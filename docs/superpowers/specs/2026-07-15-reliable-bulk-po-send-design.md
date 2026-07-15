# Reliable bulk PO send — no duplicates, clear "not-sent" review, sender attribution

**Date:** 2026-07-15
**Status:** Implemented
**Incident:** 15 Blinkit POs (MB0573–MB0592) were emailed at ~2:10 and again at ~3:24 — "Duplicate email and PO".

## Problem

Bulk send processes POs in batches of 10. During a 30-PO run a batch errored; the UI
then offered "reallocate", and reallocating re-sent **all 10 in that batch — including
the ones that had already gone out**. Two compounding defects:

1. **Non-idempotent send.** `buildAndSendPoEmail` never checked whether a PO's email had
   already gone out, so any re-run / reallocate / double-click re-mailed the warehouse.
2. **Browser-tallied outcomes.** The bulk UI decided "what still needs sending" from its
   in-memory results. When a whole batch HTTP request errored/timed out, the browser lost
   track of what the server had actually already sent — so it re-sent delivered POs.

No scheduler/cron ever sends PO emails (verified), so every send is a human action; the
code simply failed to stop a duplicate.

## Design

### 1. Idempotency guard (safety net)
`buildAndSendPoEmail(poId, { force? })`: if `emailStatus === "SENT"` and `force` is not
set, it does **not** send — returns `alreadySent: true` (+ `emailSentAt`), audits
`EMAIL_RESEND_SKIPPED_ALREADY_SENT`, and `allocateAndEmailPo` also skips the WMS push.
The resend endpoint returns **409** unless the request carries `force: true`; the UI asks
the operator to confirm, then retries with `force`. Intentional resends of HELD/FAILED POs
are unaffected (only `SENT` is guarded).

### 2. Never abort — finish all 30, decide from server truth
- The bulk loop wraps each batch: a failed batch records placeholders and the run
  **continues** through every PO instead of aborting.
- After the run the client calls **`GET /api/pos/send-status?ids=…`**, which returns each
  PO's real `emailStatus` / `emailSentAt` / `emailSentBy` / `emailHoldReason` from the DB.
  "Not sent" = anything whose status isn't `SENT`. This is immune to a lost batch response.
  If the status lookup itself fails, it falls back to client results and marks unknowns
  "verify before resending" (never silently "sent").

### 3. "Not sent" review
Result screen shows `N sent · M not sent`, then a panel listing **only** the not-sent POs
with their reason and a **"Send all not-sent"** action. Sent POs are never in this list, so
they can't be re-sent by accident; the per-PO guard is the backstop.

### 4. Attribution
- New nullable column `PurchaseOrder.emailSentBy` (Prisma migration
  `20260715000000_po_email_sent_by`), written on a successful send from `currentActor()`
  (Google login via Moxie Gmail). A forced resend overwrites it with who last sent.
- **"Sent by" column** added to the orders list (`getOrders` + `PoTable`).

### 5. Testing
`scripts/test-resend-idempotency.ts` (tsx, test-mode sink — no real mail): first send marks
`SENT` and records `emailSentBy`; a second unforced send is skipped (no duplicate,
`emailSentAt` unchanged); a forced send delivers again.

## Files
- `lib/services/allocate-and-email.ts` — guard, `force`, `alreadySent`, record `emailSentBy`.
- `app/api/pos/[id]/resend-email/route.ts` — `force`, 409 on already-sent.
- `app/api/pos/allocate-bulk/route.ts` — surface `alreadySent`.
- `app/api/pos/send-status/route.ts` — new server-truth endpoint.
- `components/channels/bulk-send-modal.tsx` — never-abort loop, server reconcile, not-sent review.
- `components/orders/resend-email-modal.tsx` — confirm→force on 409.
- `lib/data/queries.ts`, `components/dashboard/po-table.tsx` — "Sent by" column.
- `prisma/schema.prisma` + migration — `emailSentBy`.

## Notes / limits
- Migration is additive (nullable, no backfill) — safe to `prisma migrate deploy`.
- Batch size / pauses unchanged; this fixes tracking + idempotency, not send speed.
- Real per-person attribution requires Google/Clerk auth to be configured in the
  deployment; without it every actor is the demo user.
