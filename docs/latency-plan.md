# Allocation / Email latency plan

> Written after the flag-review → preview → send flow fix (2026-06-23). Diagnosis only —
> nothing here is implemented yet. The conclusion up front: **this is not an infra-size
> problem.** Bigger machines won't help; the request does heavy blocking work inline and
> calls the AI model sequentially. The fixes below are architectural and keep the same infra.

## Why "bigger infra" is the wrong lever

The slow paths are **I/O- and latency-bound**, not CPU/RAM-bound:

- Downloading the channel PO PDF + Excel over the network: **3–8 s**
- Parsing that PDF for the GSTIN — done **twice** (email build + WMS push): **2–6 s wasted**
- SMTP send with attachments: **1–3 s**
- WMS sales-order push (in the critical path): **1–2 s**
- Per-SKU Gemini calls in a `for` loop (the "model latency" you feel): **5–10 s each, sequential**

Measured shape: **P50 ≈ 5–8 s, P99 ≈ 15–20 s**. And `POST /api/pos/[id]/allocate` has **no
`maxDuration`**, so it can hit the 10 s serverless timeout on the bigger POs. Throwing more
CPU at a function that spends its time *waiting on network and on sequential API calls* changes
nothing.

## Tier 1 — quick wins (cheap, high impact, no architecture change)

| # | Problem | Fix | File | Est. gain |
|---|---------|-----|------|-----------|
| 1 | Per-SKU Gemini calls are sequential | Batch every unmapped SKU into **one** Gemini request (the batch auto-mapper already does this — route the fallback through it) | `lib/services/sku-item-mapper.ts:390-432` | −70% on mapping, removes the worst spikes |
| 2 | PDF parsed twice per allocation | Parse the PO PDF once, reuse the GSTIN result for both the email build and the WMS push | `lib/services/allocate-and-email.ts:239` + `:362` | −1–3 s |
| 3 | `allocate` route can time out | Add `export const maxDuration = 60;` | `app/api/pos/[id]/allocate/route.ts` | prevents timeouts |
| 4 | Channel docs re-downloaded every send | Cache the downloaded PDF/Excel per PO id for ~1 h (most sends re-pull the same file) | `lib/services/po-documents.ts:113-237` | −3–8 s on cache hit |
| 5 | EAN→internal map built twice | Compute `mapEansToInternal` once, pass it to the WMS push | `allocate-and-email.ts:212` + `:362` | −100–200 ms |
| 6 | SKU-master cache TTL very short (10 s) | Raise to 60 s; edits already force a refresh | `lib/services/sku-master.ts` | −50 ms/req |

Add a `console.time`/structured timing around `getPoDocuments`, the GSTIN parse, SMTP, and the
WMS push first, so we measure the win rather than guess.

## Tier 2 — get heavy work off the critical path (bigger, changes semantics)

This is the real fix for *perceived* latency and was the third option in the original ask
("make send async"). The user chose to defer it; capturing it here so it isn't lost.

- Commit the allocation + claim release in the transaction, then **return immediately**.
- Run `getPoDocuments` → GSTIN → SMTP → WMS push in a background job, writing status back to
  the PO (`emailMessageId`, `EMAIL_SENT` / `EMAIL_FAILED` audit) so the UI can poll/subscribe.
- Surface per-PO send status in the allocation list (a small "sending… / sent / failed" badge)
  instead of blocking the operator on the email round-trip.

Trade-off: the operator no longer gets an instant "email sent" confirmation — they get
"queued", then a status update. Worth it once volume grows; revisit when we do.

A lightweight queue (DB-backed job table polled by the existing cron, or a proper queue) is
enough — we do **not** need a new service tier for this.

## What infra *would* actually move the needle (and when)

- **DB connection pooling** (PgBouncer / Prisma Accelerate) — not for latency, but to survive
  bulk sends without exhausting Postgres connections on serverless. Do this before high
  concurrency, regardless of the above.
- Beyond that, scale only after Tier 1+2 are in and we have timing numbers showing a specific
  resource is saturated. Don't pre-buy capacity for a wait-bound workload.
