import "server-only";
import type { Prisma } from "@prisma/client";

/**
 * Allocation-safe sync.
 *
 * Channel syncs upsert POs and (for existing ones) delete+recreate line items,
 * GRNs and discrepancies. That's fine while a PO is still in the review queue,
 * but once it's been allocated (or anything later) those child rows hold real
 * work — `approvedQty`, the dispatch email's reference, GRN receipts — that must
 * NOT be wiped just because the channel re-reported the PO.
 *
 * So allocation is a **one-way latch**: a PO whose status has left the review
 * queue is "locked". For locked POs, sync only refreshes the raw channel
 * snapshot (`rawData`) and leaves status + line items + GRNs + discrepancies
 * untouched. New POs and still-in-review POs refresh fully, as before.
 */

// The only statuses a sync may fully refresh. Everything else is post-allocation
// (ALLOCATED / APPROVED / DISPATCHED / DELIVERED / GRN_RECEIVED / CLOSED /
// DISCREPANCY / ON_HOLD) and is preserved. New statuses default to "locked".
const REFRESHABLE_STATUSES = new Set<string>(["PENDING_REVIEW", "PRIORITISED"]);

export function isAllocationLocked(status: string | null | undefined): boolean {
  return !!status && !REFRESHABLE_STATUSES.has(status);
}

/**
 * Within a transaction, report whether the PO (by externalId) already exists and
 * is allocation-locked. Returns null when the PO is new (→ create + full refresh).
 */
export async function poLockState(
  tx: Prisma.TransactionClient,
  externalId: string,
): Promise<{ id: string; locked: boolean } | null> {
  const existing = await tx.purchaseOrder.findUnique({
    where: { externalId },
    select: { id: true, status: true, approvedAt: true, emailRef: true, claimedById: true },
  });
  if (!existing) return null;
  // Self-heal: older syncs mapped the channel's own "approved" status onto our
  // APPROVED workflow state, locking POs nobody ever allocated. An APPROVED PO
  // with no human fingerprints (no approval timestamp, no email ref, unclaimed)
  // is such an artifact — let sync refresh it fully so its status is recomputed.
  const syntheticApproved =
    existing.status === "APPROVED" && !existing.approvedAt && !existing.emailRef && !existing.claimedById;
  return { id: existing.id, locked: isAllocationLocked(existing.status) && !syntheticApproved };
}

// Once receipts land, a locked PO may advance to GRN_RECEIVED/CLOSED — but never
// out of ops-owned exception states (ON_HOLD, DISCREPANCY) or a manual CLOSED.
const GRN_ADVANCEABLE_STATUSES = new Set<string>([
  "ALLOCATED",
  "APPROVED",
  "DISPATCHED",
  "DELIVERED",
  "GRN_RECEIVED",
]);

/**
 * Record channel-reported GRN receipts on an allocation-locked PO.
 *
 * The allocation latch rightly stops sync from rewriting line items (approvedQty)
 * and workflow status — but GRN receipts are NEW information that arrives from the
 * channel *after* allocation, on exactly the POs we issued. Skipping them meant no
 * issued PO ever showed a GRN. This captures receipts without touching allocation:
 *  - no-op when the payload carries no received quantities (header-only fetches
 *    must never erase previously captured receipts)
 *  - never overwrites a human-entered GRN (EMAIL / MANUAL_CSV)
 *  - refreshes the PORTAL GRN idempotently, then advances status only along the
 *    normal path (→ GRN_RECEIVED, or CLOSED when fully received)
 */
export async function captureLockedPoGrn(
  tx: Prisma.TransactionClient,
  args: {
    poId: string;
    grnLines: { skuId: string; receivedQty: number }[];
    allReceived: boolean;
    receivedAt?: Date | null;
  },
): Promise<boolean> {
  if (args.grnLines.length === 0) return false;
  const existing = await tx.grnRecord.findUnique({
    where: { poId: args.poId },
    select: { source: true },
  });
  if (existing && existing.source !== "PORTAL") return false;

  await tx.discrepancy.deleteMany({ where: { poId: args.poId } });
  await tx.grnRecord.deleteMany({ where: { poId: args.poId } });
  await tx.grnRecord.create({
    data: {
      poId: args.poId,
      source: "PORTAL",
      channelGrnNumber: null,
      status: args.allReceived ? "ACCEPTED" : "PENDING_RECONCILIATION",
      receivedAt: args.receivedAt ?? undefined,
      lineItems: {
        create: args.grnLines.map((l) => ({ skuId: l.skuId, receivedQty: l.receivedQty, rejectedQty: 0 })),
      },
    },
  });

  const po = await tx.purchaseOrder.findUnique({ where: { id: args.poId }, select: { status: true } });
  if (po && GRN_ADVANCEABLE_STATUSES.has(po.status)) {
    const next = args.allReceived ? "CLOSED" : "GRN_RECEIVED";
    if (next !== po.status) {
      await tx.purchaseOrder.update({ where: { id: args.poId }, data: { status: next } });
    }
  }
  return true;
}
