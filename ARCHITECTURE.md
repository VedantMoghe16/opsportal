# Architecture

Moxie Ops is a Next.js 14 App Router app with a **clear, layered separation** between
the frontend, the backend, and the external-integration boundary. Each layer only
depends on the layers below it.

```
┌──────────────────────────────────────────────────────────────────────┐
│  FRONTEND  (browser)                                                   │
│  app/(dashboard)/*  pages (Server Components)                          │
│  components/        UI — ui/ primitives · layout/ · feature folders    │
│      client components ("use client") talk to the backend over fetch() │
└───────────────┬────────────────────────────────┬───────────────────── ┘
                │ RSC: direct import              │ Client: fetch()
                ▼                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│  API LAYER  app/api/*                                                  │
│  REST routes (pos, allocations, grn, inventory, analytics, channels)   │
│  cron routes (poll-emails, check-timers, scrape-portals)               │
│  thin: validate (Zod) → auth → call a service → ok()/fail()            │
└───────────────────────────────┬────────────────────────────────────── ┘
                                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│  BACKEND                                                               │
│  lib/services/   business logic (server-only)                          │
│      reconcile · email-processor · analytics · audit                   │
│  lib/data/       read models for Server Components (server-only)        │
│      queries                                                           │
│  lib/integrations/  external-service clients (server-only)             │
│      gmail · sheets · resend · twilio · s3 · claude · playwright · pdf  │
│  lib/  (shared kernel)  db · env · auth · api · cron · utils · status   │
└───────────────────────────────┬────────────────────────────────────── ┘
                                 ▼
        PostgreSQL (Prisma)   +   Gmail · Sheets · Resend · Twilio · S3 · Claude
```

## Layer responsibilities

| Layer | Folder | Rules |
|---|---|---|
| **Frontend** | `app/(dashboard)`, `components` | Server Components fetch via `lib/data` or `lib/services`. Client components (`"use client"`) never touch the DB — they call `app/api/*` over `fetch()`. |
| **API** | `app/api` | Thin controllers. Validate input with Zod, authenticate (`lib/auth`), delegate to a service, return the `{success,data}` / `{success,error}` envelope (`lib/api`). No business logic inline. |
| **Services** | `lib/services` | All domain logic & multi-table writes (Prisma transactions). `reconcile` (GRN diff, invoicing), `email-processor` (parse + route inbound mail), `analytics` (KPIs), `audit` (append-only log). |
| **Data** | `lib/data` | Read-only query functions tuned for the UI (narrow `select`s). Consumed by Server Components. |
| **Integrations** | `lib/integrations` | One module per third-party. Each lazily constructs its client and **degrades gracefully** (logs + no-ops or DB fallback) when its env vars are missing, so the app boots without every credential. |
| **Kernel** | `lib/` | `db` (Prisma singleton), `env` (Zod-validated, fail-fast), `auth` (Clerk wrapper, demo fallback), `api` (response helpers), `cron` (CRON_SECRET guard), `utils` (formatting), `status` (shared UI metadata). |

## Enforced boundaries
- Every module in `lib/integrations`, `lib/services`, `lib/data` (and `lib/auth`)
  starts with `import "server-only"` — importing them into a client bundle is a
  **build error**, so secrets and Node SDKs can never leak to the browser.
- `lib/integrations/sheets` exports the `AtpRow` **type** consumed by client
  components via `import type` (erased at compile time, so no server code ships).
- Cron endpoints authenticate with `CRON_SECRET`; all other API routes use Clerk
  (`lib/auth`), which falls back to a demo identity when Clerk keys are absent.

## Request flows (examples)
- **Render dashboard** → `app/(dashboard)/page.tsx` (RSC) → `lib/data/queries` +
  `lib/integrations/sheets` → Postgres.
- **Approve allocation** → grid (client) → `POST /api/allocations/approve` →
  Prisma txn (write approved qtys, create `WarehouseInstruction`, set `APPROVED`,
  audit) → `lib/integrations/resend` emails the warehouse.
- **Inbound email cron** → `GET /api/cron/poll-emails` → `lib/integrations/gmail`
  → `lib/services/email-processor` (idempotent per message id) →
  `lib/integrations/claude` parse → `lib/services/reconcile` when it's a GRN.
```
