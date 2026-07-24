/**
 * GRN variance engine — shared by the live reconcile path (lib/services/reconcile.ts)
 * and the retroactive backfill (scripts/backfill-discrepancies.ts).
 *
 * For every PO line, receipts are diffed against the best available baseline,
 * in order of confidence:
 *   1. DISPATCHED — what the warehouse actually shipped (DispatchRecord line)
 *   2. ASSIGNED  — what we committed (PoLineItem.approvedQty, else the
 *                  channel's ASN qty scraped into rawData)
 *   3. ORDERED   — the channel's original ask (requestedQty)
 * Every line therefore always has a baseline; nothing is silently skipped.
 *
 * A line is flagged when it breaches the per-line tolerance, or when the PO's
 * aggregate variance breaches tolerance (many small leaks add up). Buckets:
 *   • SHORT_RECEIPT     baseline > received
 *   • EXCESS_RECEIPT    received > baseline
 *   • CHANNEL_REJECTION rejectedQty at the dock (carries the reason)
 *
 * Plain module (no "server-only") so it is importable from services, scripts,
 * and tests alike. Callers pass already-fetched Prisma rows.
 */

import { asnQtyFromRaw } from "@/lib/services/fill-rate";

export const TOLERANCE_PCT = 2.0;

export type VarianceBaseline = "DISPATCHED" | "ASSIGNED" | "ORDERED";
export type VarianceType = "SHORT_RECEIPT" | "EXCESS_RECEIPT" | "CHANNEL_REJECTION";

export interface VariancePoLine {
  skuId: string;
  requestedQty: number;
  approvedQty: number | null;
  unitPrice: number | null;
  rawData: unknown;
}

export interface VarianceGrnLine {
  skuId: string;
  receivedQty: number;
  rejectedQty: number;
  rejectionReason: string | null;
}

export interface VarianceDispatchLine {
  skuId: string;
  dispatchedQty: number;
}

export interface VarianceRow {
  skuId: string;
  type: VarianceType;
  baseline: VarianceBaseline;
  baselineQty: number;
  receivedQty: number;
  /** baselineQty - receivedQty for receipts; rejectedQty for rejections. */
  varianceQty: number;
  variancePct: number;
  /** |variance| × unit price; null when the PO line has no price. */
  valueImpact: number | null;
  rejectionReason: string | null;
}

export interface VarianceResult {
  rows: VarianceRow[];
  hasDiscrepancy: boolean;
  /** Aggregate |variance| ÷ aggregate baseline, in %. */
  aggregatePct: number;
}

const pct = (num: number, den: number): number => (den > 0 ? (num / den) * 100 : 0);

/** Round to 2dp for storage — avoids 3.9999999 noise in the UI. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

export function computeGrnVariances(
  poLines: VariancePoLine[],
  grnLines: VarianceGrnLine[],
  dispatchLines: VarianceDispatchLine[] | null | undefined,
): VarianceResult {
  const grnBySku = new Map<string, VarianceGrnLine>();
  for (const g of grnLines) {
    const prev = grnBySku.get(g.skuId);
    grnBySku.set(
      g.skuId,
      prev
        ? {
            skuId: g.skuId,
            receivedQty: prev.receivedQty + g.receivedQty,
            rejectedQty: prev.rejectedQty + g.rejectedQty,
            rejectionReason: prev.rejectionReason ?? g.rejectionReason,
          }
        : g,
    );
  }
  const dispatchedBySku = new Map<string, number>();
  for (const d of dispatchLines ?? []) {
    dispatchedBySku.set(d.skuId, (dispatchedBySku.get(d.skuId) ?? 0) + d.dispatchedQty);
  }

  // First pass: resolve baselines and raw variances for every PO line.
  type Candidate = VarianceRow & { overTolerance: boolean };
  const candidates: Candidate[] = [];
  let aggVariance = 0;
  let aggBaseline = 0;

  for (const line of poLines) {
    const grn = grnBySku.get(line.skuId);
    const received = grn?.receivedQty ?? 0; // SKU absent from the GRN = nothing received
    const rejected = grn?.rejectedQty ?? 0;

    const dispatched = dispatchedBySku.get(line.skuId);
    const assigned = line.approvedQty ?? asnQtyFromRaw(line.rawData);
    let baseline: VarianceBaseline;
    let baselineQty: number;
    if (dispatched != null) {
      baseline = "DISPATCHED";
      baselineQty = dispatched;
    } else if (assigned != null) {
      baseline = "ASSIGNED";
      baselineQty = assigned;
    } else {
      baseline = "ORDERED";
      baselineQty = line.requestedQty;
    }

    aggBaseline += baselineQty;

    // Rejected units physically reached the dock — count them as delivered so
    // a rejection isn't double-counted as a transit shortage too.
    const varianceQty = baselineQty - (received + rejected);
    if (varianceQty !== 0) {
      aggVariance += Math.abs(varianceQty);
      const variancePct = pct(Math.abs(varianceQty), baselineQty);
      candidates.push({
        skuId: line.skuId,
        type: varianceQty > 0 ? "SHORT_RECEIPT" : "EXCESS_RECEIPT",
        baseline,
        baselineQty,
        receivedQty: received,
        varianceQty,
        variancePct: round2(variancePct),
        valueImpact:
          line.unitPrice != null ? round2(Math.abs(varianceQty) * line.unitPrice) : null,
        rejectionReason: null,
        // Excess against a zero baseline (e.g. unsolicited units) is always over tolerance.
        overTolerance: baselineQty === 0 ? true : variancePct > TOLERANCE_PCT,
      });
    }

    if (rejected > 0) {
      aggVariance += rejected;
      const rejectionPct = pct(rejected, baselineQty);
      candidates.push({
        skuId: line.skuId,
        type: "CHANNEL_REJECTION",
        baseline,
        baselineQty,
        receivedQty: received,
        varianceQty: rejected,
        variancePct: round2(rejectionPct),
        valueImpact: line.unitPrice != null ? round2(rejected * line.unitPrice) : null,
        rejectionReason: grn?.rejectionReason ?? null,
        overTolerance: baselineQty === 0 ? true : rejectionPct > TOLERANCE_PCT,
      });
    }
  }

  // Second pass: per-line tolerance, or everything with variance when the PO
  // as a whole leaks more than tolerance (many small shortfalls add up).
  const aggregatePct = round2(pct(aggVariance, aggBaseline));
  const poOverTolerance = aggregatePct > TOLERANCE_PCT;
  const rows = candidates
    .filter((c) => c.overTolerance || poOverTolerance)
    .map(({ overTolerance: _overTolerance, ...row }) => row);

  return { rows, hasDiscrepancy: rows.length > 0, aggregatePct };
}
