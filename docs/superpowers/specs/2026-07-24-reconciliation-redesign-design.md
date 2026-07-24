# Reconciliation redesign — baseline fix + workflow UI

**Date:** 2026-07-24
**Status:** Approved (Option A + B, sequenced, non-breaking)

## Problem

Analytics shows 96% gross fill (4% of ordered units never received) while the
Reconciliation tab shows "No open discrepancies". Root cause in
`lib/services/reconcile.ts`: discrepancies are only computed against
`DispatchRecord` line items, and when a PO has no dispatch record (the norm for
quick-commerce channels) every GRN line is silently skipped
(`if (!dispatched) continue`), the GRN auto-accepts, and an invoice is
generated blind. Additional blind spots:

- `GrnLineItem.rejectedQty` is ignored entirely.
- A SKU ordered but completely missing from the GRN is never checked
  (iteration is over GRN lines, not PO lines).
- Tolerance is per-line only; a PO can lose >2% overall with every line under 2%.

## Design

### 1. Shared variance engine (`lib/services/grn-variance.ts`)

Pure module (no `server-only`, like `fill-rate.ts`) so the live reconcile
path, the backfill script, and tests share one implementation.

- **Baseline chain per PO line:** dispatched qty → assigned qty
  (`approvedQty ?? asnQtyFromRaw(rawData)`) → ordered (`requestedQty`).
  Every line always has a baseline; record which one was used.
- **Iterate PO lines** (not GRN lines): a SKU missing from the GRN counts as
  received 0. GRN lines for SKUs not on the PO are ignored (no baseline to
  judge against — same as today).
- **Buckets:**
  - `SHORT_RECEIPT` — baseline > received beyond tolerance.
  - `EXCESS_RECEIPT` — received > baseline beyond tolerance.
  - `CHANNEL_REJECTION` — `rejectedQty` beyond tolerance (carries
    `rejectionReason`).
- **Tolerance:** per-line 2% as today, **plus** a PO-level aggregate check —
  if total |variance| ÷ total baseline > 2%, all lines with non-zero variance
  are flagged even if individually under 2%.
- **₹ impact:** `|varianceQty| × unitPrice` (null when no unit price known).
- Internal short-ship (ordered vs assigned gap — our own warehouse problem) is
  **not** persisted as Discrepancy rows; it is derived at query time for a
  read-only UI bucket. This keeps it out of the GRN-closure / invoicing
  workflow entirely.

### 2. Schema (additive migration only)

On `Discrepancy`:

- `type DiscrepancyType @default(SHORT_RECEIPT)` — SHORT_RECEIPT,
  EXCESS_RECEIPT, CHANNEL_REJECTION
- `baseline DiscrepancyBaseline?` — DISPATCHED, ASSIGNED, ORDERED (null on
  legacy rows)
- `baselineQty Int?` (legacy rows fall back to `dispatchedQty`)
- `valueImpact Float?`
- `origin DiscrepancyOrigin @default(LIVE)` — LIVE, BACKFILL
- `rejectionReason String?`

`dispatchedQty` keeps being written (= baselineQty) so the existing
discrepancy table, debit-note PDF, and resolve route keep working unchanged.
Migration SQL generated offline with `prisma migrate diff` (no local DB);
applied by the existing `docker-entrypoint.sh` → `prisma migrate deploy`.

### 3. `reconcileGrn` changes (behavior-compatible)

- Same signature, same callers, same status flow
  (clean → ACCEPTED + auto-invoice; flagged → DISCREPANCY_FLAGGED + WhatsApp
  alert). Only the diff engine is replaced.
- **Idempotency guard:** if the GRN already has any Discrepancy rows, do not
  create more (re-sync / re-run safe); report based on currently OPEN/DISPUTED
  rows and leave statuses untouched so resolved GRNs are never flipped back.

### 4. Backfill script (`scripts/backfill-discrepancies.ts`)

- Scans GRNs with status ACCEPTED (the auto-accepted, potentially blind ones)
  that have zero Discrepancy rows; runs the shared variance engine.
- Creates rows with `origin: BACKFILL`, status OPEN. **Never** touches
  GRN status, PO status, or invoices — closed POs stay closed; the rows simply
  surface in the tab for review/debit-note action.
- Dry-run by default (prints a summary); `--apply` writes.

### 5. Reconciliation page redesign

- **Header strip:** ₹ at risk (open), ₹ disputed, ₹ debit-noted (this month),
  ₹ written off (this month).
- **Tie-out line:** 30-day gross-fill gap in units/₹ vs. units captured as
  discrepancies vs. unexplained — so Analytics and Reconciliation can no
  longer disagree silently.
- **Tabs:** Open · Internal short-ship (derived, read-only) · Resolved
  (history).
- Open table gains Type badge, baseline hint ("vs dispatched/assigned/
  ordered"), ₹ impact, and a Backfill badge. Debit-note action only offered
  for SHORT_RECEIPT / CHANNEL_REJECTION.
- Resolve route: `remaining === 0 → RESOLVED + invoice` logic unchanged
  (idempotent invoice helper already returns the existing invoice).

### 6. Explicitly out of scope

- No changes to PO approval/allocation/email flows, Zepto/Blinkit/Nykaa/
  Instamart ingest, analytics fill-rate math, or invoice generation.
- No retroactive invoice correction — backfilled shortages are handled via the
  debit-note action, which is exactly what it exists for.

## Addendum (2026-07-24, after first prod dry run)

The dry run found 0/599 variances — by construction, not because things were
clean: channel syncs (Zepto/Blinkit/Nykaa/Instamart) never call `reconcileGrn`.
They set `allReceived → ACCEPTED` directly (zero variance by definition) and
park partials as `PENDING_RECONCILIATION` forever — that's where the fill gap
lives. Worse, every re-sync ran `discrepancy.deleteMany` + GRN recreate,
wiping reconciliation work. Fixes:

1. **Finalization latch** (`resetPortalGrn` in ingest-guard, used by
   `captureLockedPoGrn` and all six direct rewrite sites): sync never deletes/
   recreates a GRN that is human-entered, has left PENDING_RECONCILIATION, or
   carries discrepancy rows.
2. **Deferred reconciliation** (check-timers Check 3): PENDING_RECONCILIATION
   GRNs quiet for 3+ days are reconciled 50 per run in quiet mode —
   `reconcileGrn(id, { autoInvoice: false, notify: false })` — so a historical
   backlog can never mass-email channels or spam WhatsApp; one digest per run.
3. `reconcileGrn` gained those opts (default true/true; existing callers
   unchanged) and no longer downgrades a CLOSED PO in the clean path.
4. Backfill script also scans settled PENDING_RECONCILIATION GRNs.
5. The >5-day escalation WhatsApp caps its list at 15 rows.

## Verification

- `scripts/test-grn-variance.ts` (tsx, follows existing `scripts/test-*.ts`
  pattern) asserts: baseline chain order, missing-GRN-line = 0 received,
  rejection bucket, per-line + aggregate tolerance, excess classification,
  value impact, and idempotency guard behavior.
- `npm run typecheck` and `npm run build` must pass.
- Migration SQL reviewed for additive-only DDL.
