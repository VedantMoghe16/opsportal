-- CreateEnum
CREATE TYPE "PoStatus" AS ENUM ('PENDING_REVIEW', 'PRIORITISED', 'ALLOCATED', 'APPROVED', 'DISPATCHED', 'DELIVERED', 'GRN_RECEIVED', 'CLOSED', 'DISCREPANCY', 'ON_HOLD');

-- CreateEnum
CREATE TYPE "GrnSource" AS ENUM ('EMAIL', 'PORTAL', 'MANUAL_CSV');

-- CreateEnum
CREATE TYPE "GrnStatus" AS ENUM ('PENDING_RECONCILIATION', 'ACCEPTED', 'DISCREPANCY_FLAGGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "DiscrepancyStatus" AS ENUM ('OPEN', 'ACCEPTED', 'DEBIT_NOTE_RAISED', 'DISPUTED', 'RESOLVED');

-- CreateTable
CREATE TABLE "Channel" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "emailDomain" TEXT NOT NULL,
    "poSenderEmail" TEXT,
    "grnSenderEmail" TEXT,
    "tier" TEXT NOT NULL DEFAULT 'B',
    "fillRateCommitment" DOUBLE PRECISION NOT NULL DEFAULT 90.0,
    "deliverySlaHours" INTEGER NOT NULL DEFAULT 48,
    "billingGstin" TEXT,
    "billingAddress" TEXT,
    "logoColor" TEXT,
    "portalUrl" TEXT,
    "portalUsername" TEXT,
    "portalPasswordEnvVar" TEXT,
    "grnViaEmail" BOOLEAN NOT NULL DEFAULT true,
    "grnViaPortal" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sku" (
    "id" TEXT NOT NULL,
    "internalCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "hsnCode" TEXT,
    "gstRate" DOUBLE PRECISION NOT NULL DEFAULT 18.0,
    "uom" TEXT NOT NULL DEFAULT 'unit',
    "casePackSize" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Sku_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelSku" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "channelSkuCode" TEXT NOT NULL,
    "channelMoq" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" DOUBLE PRECISION,

    CONSTRAINT "ChannelSku_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "channelPoNumber" TEXT,
    "gmailMessageId" TEXT,
    "status" "PoStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "priority" TEXT,
    "priorityScore" INTEGER,
    "priorityRationale" TEXT,
    "poDate" TIMESTAMP(3),
    "requestedDeliveryDate" TIMESTAMP(3),
    "totalRequestedValue" DOUBLE PRECISION,
    "opsNotes" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rawEmailBody" TEXT,
    "rawEmailSubject" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PoLineItem" (
    "id" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "channelSkuCode" TEXT,
    "requestedQty" INTEGER NOT NULL,
    "approvedQty" INTEGER,
    "unitPrice" DOUBLE PRECISION,

    CONSTRAINT "PoLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventorySnapshot" (
    "id" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "onHandQty" INTEGER NOT NULL,
    "reservedQty" INTEGER NOT NULL DEFAULT 0,
    "safetyStock" INTEGER NOT NULL DEFAULT 0,
    "atpQty" INTEGER NOT NULL,
    "snapshotAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventorySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WarehouseInstruction" (
    "id" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "sentToEmail" TEXT NOT NULL,
    "resendMessageId" TEXT,
    "emailSubject" TEXT,
    "emailBody" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WarehouseInstruction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DispatchRecord" (
    "id" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "warehouseInstructionId" TEXT,
    "gmailMessageId" TEXT,
    "awbNumber" TEXT,
    "carrierName" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "estimatedDeliveryDate" TIMESTAMP(3),
    "rawEmailBody" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DispatchRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DispatchLineItem" (
    "id" TEXT NOT NULL,
    "dispatchRecordId" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "dispatchedQty" INTEGER NOT NULL,

    CONSTRAINT "DispatchLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryRecord" (
    "id" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "dispatchRecordId" TEXT NOT NULL,
    "gmailMessageId" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "deliveryStatus" TEXT,
    "grnReminderSentAt" TIMESTAMP(3),
    "grnDeadline" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrnRecord" (
    "id" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "source" "GrnSource" NOT NULL,
    "gmailMessageId" TEXT,
    "channelGrnNumber" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "GrnStatus" NOT NULL DEFAULT 'PENDING_RECONCILIATION',
    "reconciledAt" TIMESTAMP(3),
    "reconciledBy" TEXT,
    "totalAcceptedValue" DOUBLE PRECISION,
    "rawData" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GrnRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrnLineItem" (
    "id" TEXT NOT NULL,
    "grnId" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "receivedQty" INTEGER NOT NULL,
    "rejectedQty" INTEGER NOT NULL DEFAULT 0,
    "rejectionReason" TEXT,

    CONSTRAINT "GrnLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Discrepancy" (
    "id" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "grnId" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "dispatchedQty" INTEGER NOT NULL,
    "receivedQty" INTEGER NOT NULL,
    "varianceQty" INTEGER NOT NULL,
    "variancePct" DOUBLE PRECISION NOT NULL,
    "status" "DiscrepancyStatus" NOT NULL DEFAULT 'OPEN',
    "resolutionNotes" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Discrepancy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "grnId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "invoiceDate" TIMESTAMP(3) NOT NULL,
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "gstAmount" DOUBLE PRECISION NOT NULL,
    "s3Key" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessedEmail" (
    "gmailMessageId" TEXT NOT NULL,
    "emailType" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "poId" TEXT,
    "result" JSONB,

    CONSTRAINT "ProcessedEmail_pkey" PRIMARY KEY ("gmailMessageId")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "performedBy" TEXT,
    "changes" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Channel_emailDomain_key" ON "Channel"("emailDomain");

-- CreateIndex
CREATE UNIQUE INDEX "Sku_internalCode_key" ON "Sku"("internalCode");

-- CreateIndex
CREATE INDEX "ChannelSku_skuId_idx" ON "ChannelSku"("skuId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelSku_channelId_channelSkuCode_key" ON "ChannelSku"("channelId", "channelSkuCode");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_gmailMessageId_key" ON "PurchaseOrder"("gmailMessageId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_channelId_idx" ON "PurchaseOrder"("channelId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_status_idx" ON "PurchaseOrder"("status");

-- CreateIndex
CREATE INDEX "PurchaseOrder_createdAt_idx" ON "PurchaseOrder"("createdAt");

-- CreateIndex
CREATE INDEX "PoLineItem_poId_idx" ON "PoLineItem"("poId");

-- CreateIndex
CREATE INDEX "PoLineItem_skuId_idx" ON "PoLineItem"("skuId");

-- CreateIndex
CREATE INDEX "InventorySnapshot_skuId_snapshotAt_idx" ON "InventorySnapshot"("skuId", "snapshotAt");

-- CreateIndex
CREATE UNIQUE INDEX "WarehouseInstruction_poId_key" ON "WarehouseInstruction"("poId");

-- CreateIndex
CREATE UNIQUE INDEX "DispatchRecord_poId_key" ON "DispatchRecord"("poId");

-- CreateIndex
CREATE UNIQUE INDEX "DispatchRecord_warehouseInstructionId_key" ON "DispatchRecord"("warehouseInstructionId");

-- CreateIndex
CREATE UNIQUE INDEX "DispatchRecord_gmailMessageId_key" ON "DispatchRecord"("gmailMessageId");

-- CreateIndex
CREATE INDEX "DispatchLineItem_dispatchRecordId_idx" ON "DispatchLineItem"("dispatchRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryRecord_poId_key" ON "DeliveryRecord"("poId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryRecord_dispatchRecordId_key" ON "DeliveryRecord"("dispatchRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryRecord_gmailMessageId_key" ON "DeliveryRecord"("gmailMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "GrnRecord_poId_key" ON "GrnRecord"("poId");

-- CreateIndex
CREATE UNIQUE INDEX "GrnRecord_gmailMessageId_key" ON "GrnRecord"("gmailMessageId");

-- CreateIndex
CREATE INDEX "GrnLineItem_grnId_idx" ON "GrnLineItem"("grnId");

-- CreateIndex
CREATE INDEX "Discrepancy_grnId_idx" ON "Discrepancy"("grnId");

-- CreateIndex
CREATE INDEX "Discrepancy_status_idx" ON "Discrepancy"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_poId_key" ON "Invoice"("poId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_grnId_key" ON "Invoice"("grnId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_invoiceNumber_key" ON "Invoice"("invoiceNumber");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "ChannelSku" ADD CONSTRAINT "ChannelSku_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelSku" ADD CONSTRAINT "ChannelSku_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoLineItem" ADD CONSTRAINT "PoLineItem_poId_fkey" FOREIGN KEY ("poId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoLineItem" ADD CONSTRAINT "PoLineItem_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventorySnapshot" ADD CONSTRAINT "InventorySnapshot_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarehouseInstruction" ADD CONSTRAINT "WarehouseInstruction_poId_fkey" FOREIGN KEY ("poId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchRecord" ADD CONSTRAINT "DispatchRecord_poId_fkey" FOREIGN KEY ("poId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchRecord" ADD CONSTRAINT "DispatchRecord_warehouseInstructionId_fkey" FOREIGN KEY ("warehouseInstructionId") REFERENCES "WarehouseInstruction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchLineItem" ADD CONSTRAINT "DispatchLineItem_dispatchRecordId_fkey" FOREIGN KEY ("dispatchRecordId") REFERENCES "DispatchRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchLineItem" ADD CONSTRAINT "DispatchLineItem_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryRecord" ADD CONSTRAINT "DeliveryRecord_poId_fkey" FOREIGN KEY ("poId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryRecord" ADD CONSTRAINT "DeliveryRecord_dispatchRecordId_fkey" FOREIGN KEY ("dispatchRecordId") REFERENCES "DispatchRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrnRecord" ADD CONSTRAINT "GrnRecord_poId_fkey" FOREIGN KEY ("poId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrnLineItem" ADD CONSTRAINT "GrnLineItem_grnId_fkey" FOREIGN KEY ("grnId") REFERENCES "GrnRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrnLineItem" ADD CONSTRAINT "GrnLineItem_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Discrepancy" ADD CONSTRAINT "Discrepancy_grnId_fkey" FOREIGN KEY ("grnId") REFERENCES "GrnRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Discrepancy" ADD CONSTRAINT "Discrepancy_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_poId_fkey" FOREIGN KEY ("poId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_grnId_fkey" FOREIGN KEY ("grnId") REFERENCES "GrnRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
