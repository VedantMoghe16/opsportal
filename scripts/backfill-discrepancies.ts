/**
 * Retroactively surface GRN variances that never went through reconciliation:
 *  - ACCEPTED GRNs the old reconcile logic silently auto-accepted (it skipped
 *    every line without a DispatchRecord baseline), and
 *  - PENDING_RECONCILIATION GRNs from channel syncs, which never call
 *    reconcileGrn at all — that's where the fill-rate gap actually lives.
 *    Only settled ones (receivedAt older than 3 days) are scanned, so POs
 *    still receiving aren't flagged mid-delivery.
 *
 * For each such GRN with zero discrepancy rows, re-runs the shared variance
 * engine (dispatched → assigned → ordered baseline) and creates Discrepancy
 * rows with origin=BACKFILL, status=OPEN. The check-timers cron later
 * completes the status leg for pending GRNs (quiet mode — no invoices/pings).
 *
 * NON-DESTRUCTIVE by design:
 *   • never changes GrnRecord.status, PurchaseOrder.status, or invoices —
 *     closed POs stay closed; rows simply appear on /reconciliation for
 *     review and debit-note action
 *   • skips GRNs that already have any discrepancy rows (idempotent, re-runnable)
 *   • dry-run by default — pass --apply to write
 *
 * Usage:
 *   npx tsx scripts/backfill-discrepancies.ts           # dry run, prints summary
 *   npx tsx scripts/backfill-discrepancies.ts --apply   # create the rows
 */
import { PrismaClient } from "@prisma/client";
import { computeGrnVariances } from "../lib/services/grn-variance";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

async function main() {
  const settledCutoff = new Date(Date.now() - 3 * 86_400_000);
  const grns = await prisma.grnRecord.findMany({
    where: {
      discrepancies: { none: {} },
      OR: [
        { status: "ACCEPTED" },
        { status: "PENDING_RECONCILIATION", receivedAt: { lt: settledCutoff } },
      ],
    },
    include: {
      lineItems: true,
      po: {
        include: {
          channel: { select: { name: true } },
          lineItems: true,
          dispatchRecord: { include: { lineItems: true } },
        },
      },
    },
    orderBy: { receivedAt: "asc" },
  });

  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — scanning ${grns.length} unreconciled GRNs (auto-accepted + settled pending) with no discrepancy rows\n`);

  let flaggedGrns = 0;
  let totalRows = 0;
  let totalUnits = 0;
  let totalValue = 0;
  const byChannel = new Map<string, { grns: number; units: number; value: number }>();

  for (const grn of grns) {
    const { rows } = computeGrnVariances(
      grn.po.lineItems.map((l) => ({
        skuId: l.skuId,
        requestedQty: l.requestedQty,
        approvedQty: l.approvedQty,
        unitPrice: l.unitPrice,
        rawData: l.rawData,
      })),
      grn.lineItems.map((l) => ({
        skuId: l.skuId,
        receivedQty: l.receivedQty,
        rejectedQty: l.rejectedQty,
        rejectionReason: l.rejectionReason,
      })),
      grn.po.dispatchRecord?.lineItems,
    );
    if (rows.length === 0) continue;

    flaggedGrns++;
    totalRows += rows.length;
    const units = rows.reduce((s, r) => s + Math.abs(r.varianceQty), 0);
    const value = rows.reduce((s, r) => s + (r.valueImpact ?? 0), 0);
    totalUnits += units;
    totalValue += value;
    const ch = byChannel.get(grn.po.channel.name) ?? { grns: 0, units: 0, value: 0 };
    ch.grns++;
    ch.units += units;
    ch.value += value;
    byChannel.set(grn.po.channel.name, ch);

    console.log(
      `  PO ${grn.po.channelPoNumber ?? grn.poId} (${grn.po.channel.name}) — ${rows.length} row(s), ` +
        `${units} units, ₹${value.toFixed(0)}: ` +
        rows.map((r) => `${r.type}:${r.skuId.slice(-6)} ${r.varianceQty} vs ${r.baseline}`).join(", "),
    );

    if (APPLY) {
      await prisma.discrepancy.createMany({
        data: rows.map((r) => ({
          poId: grn.poId,
          grnId: grn.id,
          skuId: r.skuId,
          dispatchedQty: r.baselineQty,
          receivedQty: r.receivedQty,
          varianceQty: r.varianceQty,
          variancePct: r.variancePct,
          type: r.type,
          baseline: r.baseline,
          baselineQty: r.baselineQty,
          valueImpact: r.valueImpact,
          rejectionReason: r.rejectionReason,
          origin: "BACKFILL" as const,
        })),
      });
    }
  }

  console.log(`\n${flaggedGrns}/${grns.length} GRNs have out-of-tolerance variance — ${totalRows} rows, ${totalUnits} units, ₹${totalValue.toFixed(0)}`);
  for (const [name, ch] of byChannel) {
    console.log(`  ${name}: ${ch.grns} GRNs, ${ch.units} units, ₹${ch.value.toFixed(0)}`);
  }
  if (!APPLY && flaggedGrns > 0) console.log("\nRe-run with --apply to create these rows.");
  if (APPLY) console.log("\nRows created (origin=BACKFILL). GRN/PO statuses and invoices untouched.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
