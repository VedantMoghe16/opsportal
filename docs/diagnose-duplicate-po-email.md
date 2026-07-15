# Diagnosing the duplicate PO email (sent 2:10, resent 3:24)

The error you saw —

```
sh: 1: SELECT: not found
```

— happened because the SQL was pasted into a **shell prompt**. SQL has to go into a
**PostgreSQL client** (`psql`), not into `bash`/`sh`. This file gives you the exact
commands, start to finish.

---

## Step 0 — open a database shell

Pick the option that matches where you run things.

### Option A — from the Coolify server (the app container talks to Postgres already)

In Coolify: open your app → **Terminal** (or `Execute Command`), then:

```bash
# The app already has DATABASE_URL in its environment. Use it directly:
psql "$DATABASE_URL"
```

If `psql` is not installed inside the app container, run it from a throwaway
Postgres container on the same server instead:

```bash
docker run --rm -it postgres:16 psql "PASTE_YOUR_DATABASE_URL_HERE"
```

### Option B — from your laptop

You need the same connection string the app uses (`DATABASE_URL`), e.g.
`postgresql://user:pass@host:5432/moxie_ops?sslmode=require`.

```bash
psql "postgresql://USER:PASSWORD@HOST:5432/moxie_ops?sslmode=require"
```

Once connected, your prompt changes to something like `moxie_ops=>`.
**Every command below is typed at that `moxie_ops=>` prompt, not at `$`/`#`.**

> Tip: type `\x on` first — it prints wide rows as tidy key/value blocks.

---

## Step 1 — find the PO(s) that were emailed more than once

You probably don't have the PO id yet. This finds every PO with 2+ send events
(the smoking gun) in the last 2 days:

```sql
SELECT "entityId"                                  AS po_id,
       count(*)                                    AS send_events,
       min("createdAt")                            AS first_send,
       max("createdAt")                            AS last_send
FROM "AuditLog"
WHERE "entityType" = 'PurchaseOrder'
  AND action = 'EMAIL_SENT'
  AND "createdAt" > now() - interval '2 days'
GROUP BY "entityId"
HAVING count(*) > 1
ORDER BY last_send DESC;
```

Copy the `po_id` from the row whose `first_send`/`last_send` match ~2:10 and ~3:24.

---

## Step 2 — see the full timeline for that PO

Paste the id from Step 1 in place of `PASTE_PO_ID`:

```sql
SELECT "createdAt"            AS at,
       action,
       "performedBy"          AS actor,
       changes->>'ref'        AS ref,
       changes->>'messageId'  AS message_id,
       changes->>'to'         AS sent_to
FROM "AuditLog"
WHERE "entityType" = 'PurchaseOrder'
  AND "entityId"   = 'PASTE_PO_ID'
  AND action IN ('EMAIL_SENT','EMAIL_FAILED','EMAIL_WITHHELD_NO_RECIPIENTS','ALLOCATED')
ORDER BY "createdAt";
```

### How to read the result

| What you see | What it means |
|---|---|
| Two `EMAIL_SENT` rows, **different `actor`**, same `ref` | A person clicked **Resend** at 3:24 on a PO already sent at 2:10 (send is not idempotent). |
| Two `EMAIL_SENT` rows, **same `actor`** (e.g. `system`) close together | A bulk run / retry re-sent it (the allocate path re-fired). |
| `EMAIL_FAILED` at ~2:10, then `EMAIL_SENT` at 3:24 | The 2:10 send was recorded as failed but the mail actually went out — operator resent. |
| Only **one** `EMAIL_SENT` in the DB but the mailbox shows two | The 2:10 mail sent, but writing `emailStatus=SENT` failed afterwards (swallowed error) — so the PO looked un-sent and got resent. |

The last row is the important one: it means the delivery and the "we delivered it"
record are **not written atomically**, which is the deepest cause (see the fix PR).

---

## Step 3 — cross-check the PO's stored state

```sql
SELECT "channelPoNumber", "emailStatus", "emailRef", "emailSentAt", "emailHoldReason"
FROM "PurchaseOrder"
WHERE id = 'PASTE_PO_ID';
```

- `emailStatus = SENT` with a single `emailSentAt` but two mails in the inbox →
  confirms the "resent an already-sent PO" path.

---

## Step 4 (optional) — leave the DB shell

```
\q
```

---

## What to send back to me

Paste the output of **Step 1** and **Step 2**. That tells us definitively whether
the 3:24 duplicate was a human resend, a bulk re-run, or a lost-state resend — and
who/what triggered it.
