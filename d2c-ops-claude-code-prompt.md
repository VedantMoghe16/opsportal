# D2C Operations Management System — Claude Code Build Prompt

You are building a production-grade internal operations tool for a D2C (direct-to-consumer)
startup. The ops team receives purchase orders (POs) from channel partners like Nykaa, Blinkit,
and Instamart, allocates inventory, coordinates with a warehouse, and reconciles goods received
notes (GRNs). This system replaces an entirely email and spreadsheet based workflow with a
structured, automated, and auditable platform.

Build this completely. Do not scaffold and leave placeholders. Every feature described must work.

---

## 1. Tech Stack — Use Exactly These

| Layer | Technology |
|---|---|
| Framework | Next.js 14 (App Router, TypeScript strict mode) |
| Styling | Tailwind CSS + shadcn/ui |
| ORM | Prisma with PostgreSQL |
| AI | Anthropic Claude API (`@anthropic-ai/sdk`) — model: `claude-opus-4-6` |
| Email read | Google APIs (`googleapis`) — Gmail API |
| Inventory | Google APIs — Sheets API |
| Email send | Resend (`resend`) |
| Alerts | Twilio (`twilio`) — WhatsApp Business API |
| File storage | AWS S3 (`@aws-sdk/client-s3`) |
| PDF generation | PDFKit (`pdfkit`) |
| Portal scraping | Playwright (`playwright`) |
| Validation | Zod |
| Auth | Clerk (`@clerk/nextjs`) |
| Scheduling | Vercel Cron Jobs (defined in `vercel.json`) |
| Deployment | Vercel |

Install all packages from the start. Do not defer package installation.

---

## 2. Environment Variables

Create `.env.local` with all of these. Add Zod validation in `lib/env.ts` that throws on startup
if any required variable is missing.

```
# Database
DATABASE_URL=

# Clerk Auth
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=

# Anthropic
ANTHROPIC_API_KEY=

# Gmail (OAuth2)
GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=
GMAIL_REFRESH_TOKEN=
GMAIL_USER_EMAIL=                    # the ops team Gmail address

# Google Sheets
GOOGLE_SHEETS_CLIENT_EMAIL=
GOOGLE_SHEETS_PRIVATE_KEY=
INVENTORY_SPREADSHEET_ID=            # the Google Sheet ID

# Resend
RESEND_API_KEY=
RESEND_FROM_EMAIL=                   # e.g. ops@yourcompany.com

# Twilio WhatsApp
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_WHATSAPP_FROM=               # e.g. whatsapp:+14155238886
OPS_WHATSAPP_GROUP=                 # destination number

# AWS S3
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=ap-south-1
S3_BUCKET_NAME=

# Warehouse
WAREHOUSE_EMAIL=                    # email to send picking lists to

# Cron security
CRON_SECRET=                        # random string to protect cron endpoints
```

---

## 3. Database Schema

Run `npx prisma init` then create the schema below in `prisma/schema.prisma`.
Run `npx prisma migrate dev --name init` to apply.

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Channel {
  id                   String   @id @default(cuid())
  name                 String
  emailDomain          String   @unique          // nykaa.com
  poSenderEmail        String?                   // specific PO sender address
  grnSenderEmail       String?
  tier                 String   @default("B")    // A, B, C
  fillRateCommitment   Float    @default(90.0)   // % minimum fill
  deliverySlaHours     Int      @default(48)
  billingGstin         String?
  billingAddress       String?
  portalUrl            String?
  portalUsername       String?
  portalPasswordEnvVar String?                   // name of env var holding password
  grnViaEmail          Boolean  @default(true)
  grnViaPortal         Boolean  @default(false)
  active               Boolean  @default(true)
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt

  purchaseOrders PurchaseOrder[]
  channelSkus    ChannelSku[]
}

model Sku {
  id          String   @id @default(cuid())
  internalCode String  @unique
  name        String
  category    String?
  hsnCode     String?
  gstRate     Float    @default(18.0)
  uom         String   @default("unit")
  casePackSize Int     @default(1)
  active      Boolean  @default(true)
  createdAt   DateTime @default(now())

  channelSkus       ChannelSku[]
  poLineItems       PoLineItem[]
  dispatchLineItems DispatchLineItem[]
  grnLineItems      GrnLineItem[]
  discrepancies     Discrepancy[]
  inventorySnapshots InventorySnapshot[]
}

model ChannelSku {
  id             String  @id @default(cuid())
  channelId      String
  skuId          String
  channelSkuCode String                // e.g. NKA-0124
  channelMoq     Int     @default(1)
  unitPrice      Float?

  channel Channel @relation(fields: [channelId], references: [id])
  sku     Sku     @relation(fields: [skuId], references: [id])

  @@unique([channelId, channelSkuCode])
}

model PurchaseOrder {
  id                   String    @id @default(cuid())
  channelId            String
  channelPoNumber      String?
  gmailMessageId       String?   @unique           // idempotency key
  status               PoStatus  @default(PENDING_REVIEW)
  priority             String?                      // P1, P2, P3
  priorityScore        Int?                         // computed by AI (1-100)
  poDate               DateTime?
  requestedDeliveryDate DateTime?
  totalRequestedValue  Float?
  opsNotes             String?
  approvedBy           String?
  approvedAt           DateTime?
  rawEmailBody         String?   @db.Text
  rawEmailSubject      String?
  createdAt            DateTime  @default(now())
  updatedAt            DateTime  @updatedAt

  channel              Channel             @relation(fields: [channelId], references: [id])
  lineItems            PoLineItem[]
  warehouseInstruction WarehouseInstruction?
  dispatchRecord       DispatchRecord?
  deliveryRecord       DeliveryRecord?
  grnRecord            GrnRecord?
  invoice              Invoice?
  auditLogs            AuditLog[]
}

enum PoStatus {
  PENDING_REVIEW
  PRIORITISED
  ALLOCATED
  APPROVED
  DISPATCHED
  DELIVERED
  GRN_RECEIVED
  CLOSED
  DISCREPANCY
  ON_HOLD
}

model PoLineItem {
  id              String  @id @default(cuid())
  poId            String
  skuId           String
  channelSkuCode  String?
  requestedQty    Int
  approvedQty     Int?
  unitPrice       Float?

  po  PurchaseOrder @relation(fields: [poId], references: [id], onDelete: Cascade)
  sku Sku           @relation(fields: [skuId], references: [id])
}

model InventorySnapshot {
  id          String   @id @default(cuid())
  skuId       String
  onHandQty   Int
  reservedQty Int      @default(0)
  safetyStock Int      @default(0)
  atpQty      Int                           // computed: onHand - reserved - safety
  snapshotAt  DateTime @default(now())

  sku Sku @relation(fields: [skuId], references: [id])

  @@index([skuId, snapshotAt])
}

model WarehouseInstruction {
  id              String    @id @default(cuid())
  poId            String    @unique
  sentAt          DateTime?
  sentToEmail     String
  resendMessageId String?
  emailSubject    String?
  emailBody       String?   @db.Text
  acknowledgedAt  DateTime?
  createdAt       DateTime  @default(now())

  po             PurchaseOrder  @relation(fields: [poId], references: [id])
  dispatchRecord DispatchRecord?
}

model DispatchRecord {
  id                     String    @id @default(cuid())
  poId                   String    @unique
  warehouseInstructionId String?   @unique
  gmailMessageId         String?   @unique
  awbNumber              String?
  carrierName            String?
  dispatchedAt           DateTime?
  estimatedDeliveryDate  DateTime?
  rawEmailBody           String?   @db.Text
  createdAt              DateTime  @default(now())

  po                   PurchaseOrder         @relation(fields: [poId], references: [id])
  warehouseInstruction WarehouseInstruction? @relation(fields: [warehouseInstructionId], references: [id])
  lineItems            DispatchLineItem[]
  deliveryRecord       DeliveryRecord?
}

model DispatchLineItem {
  id               String @id @default(cuid())
  dispatchRecordId String
  skuId            String
  dispatchedQty    Int

  dispatchRecord DispatchRecord @relation(fields: [dispatchRecordId], references: [id])
  sku            Sku            @relation(fields: [skuId], references: [id])
}

model DeliveryRecord {
  id               String    @id @default(cuid())
  poId             String    @unique
  dispatchRecordId String    @unique
  gmailMessageId   String?   @unique
  deliveredAt      DateTime?
  deliveryStatus   String?
  grnReminderSentAt DateTime?
  grnDeadline      DateTime?                // deliveredAt + 48h
  createdAt        DateTime  @default(now())

  po             PurchaseOrder  @relation(fields: [poId], references: [id])
  dispatchRecord DispatchRecord @relation(fields: [dispatchRecordId], references: [id])
}

model GrnRecord {
  id               String    @id @default(cuid())
  poId             String    @unique
  source           GrnSource
  gmailMessageId   String?   @unique
  channelGrnNumber String?
  receivedAt       DateTime  @default(now())
  status           GrnStatus @default(PENDING_RECONCILIATION)
  reconciledAt     DateTime?
  reconciledBy     String?
  totalAcceptedValue Float?
  rawData          String?   @db.Text
  createdAt        DateTime  @default(now())

  po            PurchaseOrder @relation(fields: [poId], references: [id])
  lineItems     GrnLineItem[]
  discrepancies Discrepancy[]
  invoice       Invoice?
}

enum GrnSource {
  EMAIL
  PORTAL
  MANUAL_CSV
}

enum GrnStatus {
  PENDING_RECONCILIATION
  ACCEPTED
  DISCREPANCY_FLAGGED
  RESOLVED
}

model GrnLineItem {
  id             String  @id @default(cuid())
  grnId          String
  skuId          String
  receivedQty    Int
  rejectedQty    Int     @default(0)
  rejectionReason String?

  grn GrnRecord @relation(fields: [grnId], references: [id], onDelete: Cascade)
  sku Sku       @relation(fields: [skuId], references: [id])
}

model Discrepancy {
  id            String            @id @default(cuid())
  poId          String
  grnId         String
  skuId         String
  dispatchedQty Int
  receivedQty   Int
  varianceQty   Int               // dispatchedQty - receivedQty
  variancePct   Float
  status        DiscrepancyStatus @default(OPEN)
  resolutionNotes String?
  resolvedBy    String?
  resolvedAt    DateTime?
  createdAt     DateTime          @default(now())

  grnRecord GrnRecord @relation(fields: [grnId], references: [id])
  sku       Sku       @relation(fields: [skuId], references: [id])
}

enum DiscrepancyStatus {
  OPEN
  ACCEPTED
  DEBIT_NOTE_RAISED
  DISPUTED
  RESOLVED
}

model Invoice {
  id            String   @id @default(cuid())
  poId          String   @unique
  grnId         String   @unique
  invoiceNumber String   @unique
  invoiceDate   DateTime
  totalAmount   Float
  gstAmount     Float
  s3Key         String?
  sentAt        DateTime?
  createdAt     DateTime @default(now())

  po  PurchaseOrder @relation(fields: [poId], references: [id])
  grn GrnRecord     @relation(fields: [grnId], references: [id])
}

model ProcessedEmail {
  gmailMessageId String   @id
  emailType      String                              // po_received | dispatch_confirmation | grn_email | delivery_confirmation
  processedAt    DateTime @default(now())
  poId           String?
  result         Json?
}

model AuditLog {
  id          String   @id @default(cuid())
  entityType  String
  entityId    String
  action      String
  performedBy String?
  changes     Json?
  createdAt   DateTime @default(now())

  po PurchaseOrder? @relation(fields: [entityId], references: [id])

  @@index([entityType, entityId])
}
```

---

## 4. Project Folder Structure

```
/app
  /(dashboard)
    /layout.tsx              — sidebar + topbar shell
    /page.tsx                — morning dashboard (/)
    /allocate/page.tsx       — allocation grid
    /orders/page.tsx         — all orders pipeline view
    /orders/[id]/page.tsx    — order detail + timeline
    /grn/page.tsx            — GRN management
    /grn/upload/page.tsx     — CSV upload form
    /reconciliation/page.tsx — discrepancy resolution
    /analytics/page.tsx      — KPI dashboard
  /api
    /cron
      /poll-emails/route.ts      — Gmail polling (every 10 min)
      /check-timers/route.ts     — GRN deadline checker (every hour)
      /scrape-portals/route.ts   — Playwright portal scraper (9 AM, 5 PM)
    /pos
      /route.ts                  — GET list, filters
      /[id]/route.ts             — GET detail, PATCH status/priority
      /[id]/allocate/route.ts    — POST submit allocation
    /allocations
      /approve/route.ts          — POST approve all → send warehouse emails
    /inventory
      /atp/route.ts              — GET live ATP from Google Sheets
    /grn
      /route.ts                  — GET list
      /[id]/route.ts             — GET detail
      /upload/route.ts           — POST CSV upload
      /[id]/reconcile/route.ts   — PATCH resolve discrepancy
    /analytics
      /kpis/route.ts             — GET KPI metrics

/lib
  /env.ts              — Zod env validation
  /db.ts               — Prisma client singleton
  /gmail.ts            — Gmail API client + helper functions
  /claude.ts           — Anthropic client + parsing functions
  /sheets.ts           — Google Sheets ATP reader
  /resend.ts           — Email send helpers
  /twilio.ts           — WhatsApp alert helper
  /s3.ts               — S3 upload/download helpers
  /pdf.ts              — Invoice PDF generator
  /playwright.ts       — Portal scraper functions
  /reconcile.ts        — GRN reconciliation logic
  /audit.ts            — Audit log writer

/components
  /ui                  — shadcn/ui components (auto-generated)
  /layout
    /sidebar.tsx
    /topbar.tsx
  /dashboard
    /po-card.tsx
    /summary-stats.tsx
    /priority-badge.tsx
  /allocation
    /allocation-grid.tsx
    /atp-bar.tsx
    /sku-cell.tsx
  /orders
    /order-table.tsx
    /order-timeline.tsx
    /status-badge.tsx
  /grn
    /grn-table.tsx
    /csv-upload.tsx
    /discrepancy-row.tsx

/vercel.json           — cron schedule definitions
/prisma/schema.prisma
```

---

## 5. Cron Job Definitions (`vercel.json`)

```json
{
  "crons": [
    {
      "path": "/api/cron/poll-emails",
      "schedule": "*/10 * * * *"
    },
    {
      "path": "/api/cron/check-timers",
      "schedule": "0 * * * *"
    },
    {
      "path": "/api/cron/scrape-portals",
      "schedule": "0 9,17 * * *"
    }
  ]
}
```

All cron routes must validate the `Authorization: Bearer {CRON_SECRET}` header and return 401
if it does not match. Vercel automatically sends this header when configured.

---

## 6. Feature Specifications

### 6.1 — Cron: Gmail Email Poller (`/api/cron/poll-emails`)

This is the backbone of the automation. It runs every 10 minutes and processes all new emails.

**Algorithm:**

```
1. Fetch all unread emails from the ops Gmail inbox using Gmail API
2. For each email:
   a. Check if gmail_message_id exists in ProcessedEmail table
      — If yes: skip (idempotency guard)
      — If no: insert into ProcessedEmail immediately with result=null
   b. Identify email type by analysing sender + subject:
      — Sender domain matches a Channel.emailDomain AND subject contains PO keywords → PO_RECEIVED
      — Sender matches warehouse email + contains AWB/dispatch → DISPATCH_CONFIRMATION
      — Sender matches any Channel.grnSenderEmail → GRN_EMAIL
      — Sender matches known logistics providers → DELIVERY_CONFIRMATION
      — Unknown: log and skip
   c. Route to appropriate parser function
   d. Update ProcessedEmail.result with what was extracted
3. Return { processed: N, skipped: M }
```

**PO Parser** (`parsePurchaseOrderEmail`):
- Send full email body to Claude with this exact system prompt:
  ```
  You are parsing a purchase order email from a channel partner into structured JSON.
  Extract: channel_po_number, po_date (ISO), requested_delivery_date (ISO),
  line_items (array of { channel_sku_code, requested_qty, unit_price }),
  and any special instructions.
  Respond ONLY with valid JSON matching this schema. No explanation, no markdown.
  If a field is not found, use null.
  ```
- Match channel by sender domain to get channelId
- Map channel_sku_code to internal skuId using ChannelSku table
- Create PurchaseOrder + PoLineItem records
- Compute priorityScore using Claude (score 1–100 based on channel tier, order value,
  delivery urgency relative to today's date)
- Notify via WhatsApp: `"📦 New PO batch: {N} orders from {channels} — review at {dashboard_url}"`

**Dispatch Confirmation Parser** (`parseDispatchEmail`):
- Send to Claude to extract: awb_number, carrier_name, dispatched_at, line_items with qtys
- Update DispatchRecord, DispatchLineItem
- Set PurchaseOrder.status = DISPATCHED
- Update InventorySnapshot (mark dispatched qty as no longer reserved)
- If dispatched qty for any SKU differs from approved qty by > 5%:
  send WhatsApp alert: `"⚠️ Dispatch variance on PO {poNumber}: {sku} — approved {X} dispatched {Y}"`

**GRN Email Parser** (`parseGrnEmail`):
- Send to Claude to extract: channel_grn_number, line_items with received_qty and rejected_qty
- Create GrnRecord (source: EMAIL) + GrnLineItems
- Run reconciliation (see section 6.6)

**Delivery Confirmation Parser** (`parseDeliveryEmail`):
- Extract: awb_number, delivered_at, delivery_status
- Create DeliveryRecord
- Set PurchaseOrder.status = DELIVERED
- Set grnDeadline = deliveredAt + 48 hours

---

### 6.2 — Cron: Timer Checker (`/api/cron/check-timers`)

Runs every hour. Executes these three checks:

**Check 1 — GRN overdue reminders:**
```sql
SELECT po.id, po.channelId, delivery.deliveredAt, delivery.grnDeadline
FROM DeliveryRecord delivery
JOIN PurchaseOrder po ON po.id = delivery.poId
WHERE po.status = 'DELIVERED'
  AND delivery.grnDeadline < NOW()
  AND delivery.grnReminderSentAt IS NULL
```
For each result: send reminder email to channel's grnSenderEmail via Resend,
update grnReminderSentAt.

**Check 2 — Escalation for unresolved discrepancies:**
```
Discrepancies open for > 5 business days → WhatsApp alert to ops group
```

**Check 3 — Morning digest (runs only on the 7 AM cycle):**
```
If current hour == 7:
  Fetch all POs created since yesterday 7 AM
  Send WhatsApp summary: "🌅 Good morning! {N} new POs arrived overnight.
  Total value: ₹{amount}. Open the dashboard to begin allocation."
```

---

### 6.3 — Cron: Portal Scraper (`/api/cron/scrape-portals`)

Runs at 9 AM and 5 PM daily using Playwright.

For each Channel where `grnViaPortal = true` and `portalUrl` is set:

```typescript
async function scrapeChannelPortal(channel: Channel) {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()

  // Login
  await page.goto(channel.portalUrl)
  await page.waitForSelector('[data-testid="email"], input[type="email"], #email', { timeout: 10000 })
  await page.fill('[data-testid="email"], input[type="email"], #email', channel.portalUsername)
  await page.fill('[data-testid="password"], input[type="password"], #password',
    process.env[channel.portalPasswordEnvVar])
  await page.click('[type="submit"]')
  await page.waitForURL('**/dashboard**', { timeout: 15000 })

  // Navigate to GRN/orders section
  // NOTE: URL patterns are channel-specific — add per channel
  // Extract table data using role-based selectors (not CSS classes)
  // Return structured GRN data

  await browser.close()
}
```

Important Playwright rules to follow:
- Always use `waitForSelector` before interacting with elements
- Prefer `getByRole`, `getByLabel`, `getByText` over CSS class selectors
- Handle session timeout: if login page appears mid-session, re-authenticate
- Wrap in try-catch: on failure, send WhatsApp alert and log the error
- Never store credentials in code — always read from `process.env[channel.portalPasswordEnvVar]`

---

### 6.4 — Morning Dashboard (Page: `/`)

The first screen ops sees every morning. Must feel fast and information-dense.

**Top section — Summary cards (4 cards in a row):**
- Total POs today (with change vs yesterday)
- Total order value today (₹ formatted with commas)
- POs awaiting allocation (badge count)
- Open discrepancies (alert if > 0)

**Main content — PO list table:**

Columns: Channel logo/name | PO number | Requested value | Priority badge (editable) |
SKU count | Requested delivery | Status badge | Actions

- Sort by priorityScore descending by default (AI-computed urgency)
- Filter bar: by channel, by status, by date range
- Priority badges are inline-editable (click to cycle P1 → P2 → P3 → none)
- Changing priority immediately PATCHes the database
- Status badges: color-coded chips
  - PENDING_REVIEW = gray
  - PRIORITISED = blue
  - ALLOCATED = purple
  - APPROVED = indigo
  - DISPATCHED = amber
  - DELIVERED = teal
  - GRN_RECEIVED = cyan
  - CLOSED = green
  - DISCREPANCY = red
  - ON_HOLD = orange
- "Go to allocation →" button appears when all POs have priorities set, linking to `/allocate`

**Live ATP sidebar (right panel, collapsed on mobile):**
- Shows current ATP for top 10 SKUs by demand volume
- Green if ATP > 150% of today's demand, amber if 50–150%, red if < 50%
- Refreshes every 30 seconds via polling

---

### 6.5 — Allocation Grid (Page: `/allocate`)

This is the most critical screen. It must be fast, intuitive, and resemble a spreadsheet.

**Layout:**

```
[Live ATP strip — one row per SKU showing ATP qty]
[Grid: rows = POs, columns = SKUs]
[Bottom: Totals row + Approve All button]
```

**ATP strip (top, sticky):**
- One column per SKU that appears in today's POs
- Shows: SKU name, ATP qty, colour bar (green/amber/red)
- Updates when ops edits any cell (subtract confirmed allocations from ATP)

**Grid:**
- Left-frozen column: Channel | PO number | Priority | Total value
- Remaining columns: one per SKU
- Each cell: number input, pre-filled with Claude-suggested quantity
- Cell colour coding:
  - Full fill (approved qty = requested qty) → green background
  - Partial fill (approved qty < requested qty) → amber background
  - Zero fill → red background
  - Over-allocated (sum of all approved across POs > ATP) → cell border turns red
- Editing a cell immediately recalculates the ATP strip and re-colours all other cells for that SKU
- Tab key moves to next cell (natural spreadsheet navigation)
- Cells only accept integers, auto-rounds to nearest case-pack multiple for that channel

**AI suggestion banner (top of grid):**
- Claude pre-fills all quantities using priority order (P1 first, then P2, then P3 from remaining ATP)
- Shows a banner: "AI suggested quantities based on priority and ATP. Review and adjust."
- "Re-generate suggestions" button (useful if ops changes priorities after loading the page)

**Approve All button (bottom, right-aligned):**
- Disabled until every PO row has at least one quantity filled
- On click: shows confirmation dialog with summary (total units, total value per channel)
- On confirm:
  1. POST to `/api/allocations/approve`
  2. This creates WarehouseInstruction records and sends one email per PO via Resend
  3. Updates all PO statuses to APPROVED
  4. Writes an AuditLog entry per PO with approved_by = current Clerk user
  5. Redirects to `/orders` with a success toast

**Warehouse email format (auto-generated by Resend):**

```
Subject: Dispatch Instruction — PO {channelPoNumber} for {channelName} — Due {deliveryDate}

Dear Warehouse Team,

Please dispatch the following order:

Channel: {channelName}
PO Number: {channelPoNumber}  
Delivery Address: {channel.billingAddress}
Dispatch By: {requestedDeliveryDate}

PICKING LIST:
| SKU Code       | Product Name        | Quantity | Case Packs |
|----------------|---------------------|----------|------------|
| {internalCode} | {skuName}           | {qty}    | {casePacks}|

Please reply to this email confirming dispatch with AWB number and actual
quantities per SKU.

Reference ID: {warehouseInstruction.id}
```

---

### 6.6 — GRN Collection & Reconciliation

Three parallel paths — all feed the same reconciliation function.

**Path A — Email (handled by cron poller, see 6.1)**

**Path B — Playwright portal scraping (handled by cron scraper, see 6.3)**
After extracting GRN data from portal: create GrnRecord (source: PORTAL) + run reconciliation.

**Path C — Manual CSV upload (page: `/grn/upload`):**

Upload form accepts CSV with columns: `po_number, sku_code, received_qty, rejected_qty, rejection_reason`

On upload:
1. Parse CSV with Papa Parse
2. Validate each row (known PO number, known SKU, quantities are integers)
3. Show preview table with validation errors highlighted in red
4. On confirm: create GrnRecord (source: MANUAL_CSV) + GrnLineItems + run reconciliation

**Reconciliation function** (`lib/reconcile.ts`):

```typescript
async function reconcileGrn(grnId: string) {
  const grn = await prisma.grnRecord.findUnique({
    where: { id: grnId },
    include: { lineItems: true, po: { include: { dispatchRecord: { include: { lineItems: true } } } } }
  })

  const TOLERANCE_PCT = 2.0  // 2% tolerance
  let hasDiscrepancy = false

  for (const grnLine of grn.lineItems) {
    const dispatched = grn.po.dispatchRecord?.lineItems
      .find(d => d.skuId === grnLine.skuId)

    if (!dispatched) continue

    const varianceQty = dispatched.dispatchedQty - grnLine.receivedQty
    const variancePct = Math.abs(varianceQty / dispatched.dispatchedQty) * 100

    if (variancePct > TOLERANCE_PCT) {
      hasDiscrepancy = true
      await prisma.discrepancy.create({
        data: {
          poId: grn.poId, grnId, skuId: grnLine.skuId,
          dispatchedQty: dispatched.dispatchedQty,
          receivedQty: grnLine.receivedQty,
          varianceQty, variancePct
        }
      })
    }
  }

  if (hasDiscrepancy) {
    await prisma.purchaseOrder.update({ where: { id: grn.poId }, data: { status: 'DISCREPANCY' } })
    await prisma.grnRecord.update({ where: { id: grnId }, data: { status: 'DISCREPANCY_FLAGGED' } })
    await sendWhatsAppAlert(
      `⚠️ GRN discrepancy on PO ${grn.po.channelPoNumber} (${grn.po.channel.name}). ` +
      `Review at ${process.env.NEXT_PUBLIC_APP_URL}/reconciliation`
    )
  } else {
    await prisma.purchaseOrder.update({ where: { id: grn.poId }, data: { status: 'GRN_RECEIVED' } })
    await prisma.grnRecord.update({ where: { id: grnId }, data: { status: 'ACCEPTED' } })
    await generateAndSendInvoice(grn.poId, grnId)
  }
}
```

**Reconciliation page (`/reconciliation`):**

Table of all open discrepancies. Columns:
PO number | Channel | SKU | Dispatched | Received | Shortage | % Variance | Days open | Actions

Actions per row:
- "Accept shortage" → marks discrepancy ACCEPTED, proceeds to invoice
- "Raise debit note" → generates a debit note PDF, uploads to S3, emails to channel
- "Mark disputed" → flags for follow-up, sets status DISPUTED

Debit note format (PDF via PDFKit):
```
Debit Note — {yourCompanyName}
Date: {today}
Debit Note No: DN-{year}-{sequence}

To: {channel.name}
GSTIN: {channel.billingGstin}
Address: {channel.billingAddress}

Against PO: {channelPoNumber}

SHORTAGE DETAILS:
| SKU        | Dispatched | Received | Shortage | Rate   | Amount   |
|------------|------------|----------|----------|--------|----------|
| {skuName}  | {x}        | {y}      | {x-y}    | ₹{r}   | ₹{amt}   |

Total shortage amount: ₹{total}
```

---

### 6.7 — Invoice Generation

Triggered automatically when GRN is accepted with no discrepancies, OR manually after
discrepancy resolution.

Invoice PDF content (PDFKit, A4):
```
TAX INVOICE
{yourCompanyName}
GSTIN: {yourGstin}  |  {yourAddress}

Invoice No: INV-{year}-{sequence}  |  Invoice Date: {date}
PO Number: {channelPoNumber}  |  GRN Number: {channelGrnNumber}

Bill To:
{channel.name}
GSTIN: {channel.billingGstin}
{channel.billingAddress}

| # | SKU Code | Description | HSN | Qty | Rate | Taxable | GST% | GST Amt | Total |
|---|----------|-------------|-----|-----|------|---------|------|---------|-------|
| 1 | {code}   | {name}      |{hsn}|{qty}| {r} | {tax}   | {%}  | {gstAmt}| {tot} |

Subtotal: ₹{subtotal}
Total GST: ₹{gst}
TOTAL PAYABLE: ₹{total}

(Amount in words: {amountInWords})

Bank Details:
Account Name: {accountName}
Account No: {accountNumber}
IFSC: {ifsc}
Bank: {bankName}

This is a computer-generated invoice.
```

Upload PDF to S3 at key: `invoices/{year}/{month}/{invoiceNumber}.pdf`
Email to channel's billing address via Resend with PDF attached.
Store s3Key and sentAt in Invoice record.

---

### 6.8 — Order Detail Page (`/orders/[id]`)

Shows the complete lifecycle of one order.

**Header:** Channel name + logo | PO number | Current status badge | Priority badge | Total value

**Timeline (vertical, left-aligned):**
Each event is a node with timestamp, actor, and description:
- PO received (auto)
- Priority set (by whom)
- Allocated (by whom, total units)
- Warehouse emailed (auto, link to email content)
- Dispatched (AWB number, carrier, link to dispatch record)
- Delivered (timestamp)
- GRN received (source: email/portal/manual)
- Reconciled / Discrepancy flagged
- Invoice generated + sent

**Line items table:**
| SKU | Requested | Approved | Dispatched | Received | Variance |
Colour code the Variance column: green if 0, amber if < 2%, red if ≥ 2%

**Action buttons (context-sensitive, appear based on status):**
- PENDING_REVIEW → "Set Priority"
- PRIORITISED → "Go to Allocation Grid"
- APPROVED → "Re-send Warehouse Email"
- DELIVERED → "Upload GRN Manually"
- DISCREPANCY → "Resolve Discrepancy"

---

### 6.9 — Analytics Dashboard (`/analytics`)

Four charts using Recharts (already available in Next.js stack):

**1. Fill rate by channel (last 30 days)**
Bar chart: X = channel name, Y = fill rate %
Fill rate = sum(approved_qty) / sum(requested_qty) × 100

**2. Dispatch TAT (hours)**
Line chart by day: average hours between PO approval and dispatch confirmation

**3. GRN acceptance rate**
Donut chart: Auto-accepted vs Discrepancy flagged vs Manual resolution

**4. Order volume trend**
Area chart: POs received per day, last 30 days

**Summary KPI cards (top row):**
- Average fill rate (last 30 days)
- Average dispatch TAT
- GRN acceptance rate
- Total orders processed this month

---

## 7. UI/UX Design Requirements

### Visual Design

Use a **clean, utilitarian, data-dense** aesthetic appropriate for an internal ops tool.

- Font: `Geist` (Next.js default, excellent readability)
- Colour palette:
  ```css
  --brand: #1a1a2e;           /* deep navy — sidebar */
  --brand-accent: #4f46e5;    /* indigo — primary actions */
  --success: #10b981;         /* emerald — completed states */
  --warning: #f59e0b;         /* amber — partial/pending */
  --danger: #ef4444;          /* red — errors, discrepancies */
  --surface: #f8fafc;         /* near-white page bg */
  --card: #ffffff;
  ```
- Sidebar: dark navy background, white icons and text, indigo active state
- Main content: light gray background with white cards
- Tables: alternating row shading, hover highlight
- All monetary values: formatted as ₹1,23,456 (Indian number format)
- All dates: DD MMM YYYY format (15 Jan 2025)

### Sidebar Navigation

```
Logo (company name)
────────────────
📊 Dashboard         (/)
📋 Allocation        (/allocate)   [badge: pending POs count]
📦 Orders            (/orders)
✅ GRN               (/grn)        [badge: discrepancies count]
⚡ Reconciliation    (/reconciliation)
📈 Analytics         (/analytics)
────────────────
⚙  Settings          (/settings)
[User avatar + name from Clerk]
```

### Loading States

Every data-fetching component must show a skeleton loader (use shadcn/ui `Skeleton`).
No blank white pages. Show skeleton → data, never show nothing.

### Toast Notifications

Use shadcn/ui `Sonner` toast for every user action:
- Success: green — "✓ Allocation approved. Warehouse emailed."
- Error: red — "✗ Failed to send warehouse email. Retry?"
- Info: blue — "ℹ 3 new POs received since last check"

### Empty States

Every table must have a proper empty state (not just a blank table):
- Illustrated icon + heading + description + action button
- Example: "No POs received today yet. The cron job checks every 10 minutes."

### Responsive Layout

- Desktop (≥1280px): full sidebar + main content
- Tablet (768–1280px): collapsed sidebar (icon only), expand on click
- Mobile (<768px): bottom navigation bar, no sidebar

---

## 8. Quality Standards

### TypeScript

- Strict mode enabled in `tsconfig.json`
- No `any` types anywhere
- All Prisma queries fully typed
- Zod schemas for all API request bodies and Claude API responses

### Error Handling

Every API route must:
```typescript
try {
  // ... logic
  return NextResponse.json({ success: true, data: result })
} catch (error) {
  console.error('[route-name]', error)
  return NextResponse.json(
    { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
    { status: 500 }
  )
}
```

Every cron job must be wrapped in try-catch with WhatsApp alert on failure:
```typescript
} catch (error) {
  await sendWhatsAppAlert(`🚨 Cron failure: poll-emails — ${error.message}`)
  throw error
}
```

### Idempotency

All email processing MUST check `ProcessedEmail` before doing any work.
Use `upsert` with `skipDuplicates` where applicable.

### Database Queries

- Use Prisma transactions (`prisma.$transaction`) wherever multiple tables are written together
- Add database indexes on all foreign keys and frequently filtered columns
- Include `updatedAt` on every model (Prisma handles this with `@updatedAt`)

### Security

- All API routes (except cron) require Clerk authentication: `auth()` from `@clerk/nextjs/server`
- Cron routes require `CRON_SECRET` header validation
- Never log full email bodies to console in production (log only metadata)
- Portal credentials stored only in environment variables, never in database

### Performance

- Use `React.Suspense` + streaming for all dashboard data
- Allocation grid virtual scrolling if > 50 rows (use `@tanstack/react-virtual`)
- Cache ATP reads in memory for 30 seconds (avoid hitting Sheets API on every keystroke)
- All Prisma queries must include only required `select` fields (avoid SELECT *)

---

## 9. Settings Page (`/settings`)

Allow ops team to configure the system without touching code.

**Tabs:**

**Channels tab:**
- Table of all channels with edit button
- Edit modal: name, email domain, tier, fill rate commitment, SLA hours, portal URL
- Toggle: GRN via email / GRN via portal
- Test connection button (sends a test ping to verify portal login works)

**SKUs tab:**
- Table of all SKUs
- Import CSV button (upload SKU master)
- Per-channel SKU code mapping section

**Inventory tab:**
- Input: Google Sheets spreadsheet ID
- Input: Column mapping (which column is SKU code, on-hand, reserved, safety stock)
- "Sync now" button to fetch current ATP
- Last synced timestamp

**Warehouse tab:**
- Warehouse email address
- Email template preview (read-only, shows the auto-generated format)

---

## 10. Build Order

Build in this exact sequence. Do not skip phases.

### Phase 1 — Foundation (build first)
1. Next.js project with TypeScript, Tailwind, shadcn/ui
2. Prisma schema + migrate
3. Clerk auth setup
4. Sidebar layout + all page routes (empty pages are fine)
5. Settings page (channels, SKUs) — ops team needs to enter data before anything works
6. Static mock data version of the dashboard (hardcoded data, no API yet)
7. Static mock version of the allocation grid (hardcoded data, functional UI)

### Phase 2 — Data Layer
1. Gmail API connection + email polling function
2. Google Sheets ATP reader
3. Claude email parser (POs first)
4. `POST /api/cron/poll-emails` — working end-to-end
5. Dashboard loading real PO data from database
6. ATP strip on allocation grid loading from Sheets

### Phase 3 — Core Workflow
1. Allocation grid saving to database on cell edit
2. `POST /api/allocations/approve` — sends warehouse emails via Resend
3. `POST /api/cron/poll-emails` — dispatch confirmation parsing
4. `POST /api/cron/poll-emails` — delivery confirmation parsing
5. Order detail page with timeline

### Phase 4 — GRN & Reconciliation
1. GRN email parsing in the cron poller
2. CSV upload form + parser
3. Reconciliation function (the core diff logic)
4. Reconciliation page (discrepancy table + resolution actions)
5. Invoice PDF generation + S3 upload + email send
6. `POST /api/cron/check-timers` — GRN deadline reminders

### Phase 5 — Polish
1. Playwright portal scraper (`/api/cron/scrape-portals`)
2. Analytics dashboard with real data
3. WhatsApp alerts for all events
4. Loading skeletons on all pages
5. Empty states on all tables
6. Mobile responsive layout

---

## 11. Sample Data for Development

Create a seed script at `prisma/seed.ts` that inserts:

**Channels:**
- Nykaa: domain=nykaa.com, tier=A, fill_rate=92%, sla=48h, grnViaEmail=true
- Blinkit: domain=blinkit.com, tier=A, fill_rate=95%, sla=24h, grnViaEmail=true
- Instamart: domain=swiggy.com, tier=B, fill_rate=85%, sla=48h, grnViaPortal=true

**SKUs (5 products):**
- MOIST-200: "Hydrating Face Moisturiser 200ml", HSN 33049900, GST 18%
- SERM-50: "Vitamin C Serum 50ml", HSN 33049900, GST 18%
- CLNS-150: "Gentle Foam Cleanser 150ml", HSN 33049900, GST 18%
- TNRR-100: "Pore Tightening Toner 100ml", HSN 33049900, GST 18%
- SPFCR-75: "SPF 50 Sunscreen Cream 75ml", HSN 33049900, GST 18%

**3 sample POs** with PENDING_REVIEW status and realistic line items.
**Inventory snapshot** with realistic ATP values.

Run with: `npx prisma db seed`

---

## Final Notes for Claude Code

- When in doubt about a UI decision, choose clarity over cleverness.
- Every number shown to the user should be formatted (currency with ₹, percentages with %, quantities with commas).
- The allocation grid is the most-used screen — any latency here is unacceptable. Pre-fetch and cache aggressively.
- Write the idempotency check before the parser in every email processing function. This is the most important correctness guarantee in the system.
- Console.log generously during development. Each cron job should log every step.
- After building each phase, test with the seed data before moving to the next phase.
