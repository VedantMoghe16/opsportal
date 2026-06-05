# Moxie Ops — D2C Operations Management System

Production-grade internal ops tool for **Moxie Beauty**. It ingests purchase orders
from channel partners (Nykaa, Blinkit, Instamart), prioritises and allocates live
inventory, instructs the warehouse, tracks dispatch & delivery, reconciles GRNs,
raises debit notes, and auto-generates tax invoices — all auditable.

The UI is an amalgamation of the **Moxie Beauty brand** (warm cream canvas, lime
accent, ink type) and a **LeapAI-style dashboard** (floating cards, big radii, soft
shadows, airy data-dense layout).

## Stack

Next.js 14 (App Router, TS strict) · Tailwind + hand-rolled shadcn/ui · Prisma +
PostgreSQL · Anthropic Claude (`claude-opus-4-6`) · Gmail API · Google Sheets ·
Resend · Twilio WhatsApp · AWS S3 · PDFKit · Playwright · Clerk · Vercel Cron.

## Getting started

```bash
npm install
cp .env.example .env.local          # fill in credentials
npx prisma migrate dev --name init  # create schema
npx prisma db seed                  # load Moxie sample data
npm run dev                         # http://localhost:3000
```

### Boots without every credential
`lib/env.ts` requires only `DATABASE_URL`. Integration clients (Gmail, Claude,
Resend, Twilio, S3, Sheets) no-op-with-a-log or fall back (e.g. ATP reads the latest
DB snapshot when Sheets isn't configured) until you supply keys. Clerk auth is
bypassed when its keys are absent, so you can browse the full UI immediately.
Add credentials to switch each subsystem live — no code changes.

## Cron jobs (`vercel.json`)
| Path | Schedule | Job |
|---|---|---|
| `/api/cron/poll-emails` | every 10 min | Gmail → Claude parse → POs / dispatch / GRN / delivery |
| `/api/cron/check-timers` | hourly | GRN reminders · discrepancy escalation · 7 AM digest |
| `/api/cron/scrape-portals` | 9 AM & 5 PM | Playwright portal GRN scrape |

All cron routes require `Authorization: Bearer $CRON_SECRET`.

## Key flows
- **Dashboard** (`/`) — summary cards, prioritised PO table (inline priority editing), live ATP rail.
- **Allocation** (`/allocate`) — spreadsheet grid, AI-suggested quantities, live ATP strip, case-pack snapping, Approve All → warehouse emails.
- **Orders** (`/orders`, `/orders/[id]`) — pipeline + full lifecycle timeline.
- **GRN** (`/grn`, `/grn/upload`) — email/portal/CSV intake → 2% tolerance reconciliation.
- **Reconciliation** (`/reconciliation`) — accept shortage · raise debit note (PDF→S3→email) · dispute.
- **Analytics** (`/analytics`) — fill rate, dispatch TAT, GRN acceptance, volume trend.
- **Settings** (`/settings`) — channels, SKUs, inventory mapping, warehouse template.
