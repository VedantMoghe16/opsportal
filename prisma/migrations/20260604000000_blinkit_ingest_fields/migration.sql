-- Channel-import idempotency + raw source-field preservation
ALTER TABLE "PurchaseOrder"
  ADD COLUMN "externalId" TEXT,
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'EMAIL',
  ADD COLUMN "rawData" JSONB;

CREATE UNIQUE INDEX "PurchaseOrder_externalId_key" ON "PurchaseOrder"("externalId");
CREATE INDEX "PurchaseOrder_source_idx" ON "PurchaseOrder"("source");

ALTER TABLE "PoLineItem" ADD COLUMN "rawData" JSONB;
