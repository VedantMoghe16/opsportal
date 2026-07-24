import "server-only";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { sendWhatsAppAlert } from "@/lib/integrations/twilio";
import { sendEmail } from "@/lib/integrations/resend";
import { uploadToS3 } from "@/lib/integrations/s3";
import { generateInvoicePdf } from "@/lib/integrations/pdf";
import { writeAudit } from "@/lib/services/audit";
import { computeGrnVariances } from "@/lib/services/grn-variance";
import { formatINR } from "@/lib/utils";

/**
 * Diff a GRN's received quantities against the best available baseline
 * (dispatched → assigned/ASN → ordered; see lib/services/grn-variance.ts).
 * Within tolerance → accept + auto-invoice. Otherwise → flag discrepancies.
 *
 * Idempotent per GRN: a re-run (re-sync, replayed email) never creates
 * duplicate rows and never flips statuses on a GRN that was already
 * reconciled or manually resolved.
 *
 * opts (default true/true — existing callers unchanged):
 *  - autoInvoice: invoice + email the channel when the GRN is clean. The
 *    deferred cron pass sets false so a historical backlog never mass-emails.
 *  - notify: WhatsApp alert on flag. The deferred pass sets false and sends
 *    one digest instead of one ping per GRN.
 */
export async function reconcileGrn(
  grnId: string,
  opts: { autoInvoice?: boolean; notify?: boolean } = {},
): Promise<{
  hasDiscrepancy: boolean;
  discrepancyCount: number;
}> {
  const { autoInvoice = true, notify = true } = opts;
  const grn = await prisma.grnRecord.findUnique({
    where: { id: grnId },
    include: {
      lineItems: true,
      po: {
        include: {
          channel: true,
          lineItems: true,
          dispatchRecord: { include: { lineItems: true } },
        },
      },
    },
  });
  if (!grn) throw new Error(`GRN ${grnId} not found`);

  // Re-run guard: a GRN that already left PENDING_RECONCILIATION (accepted,
  // flagged, or manually resolved) is never re-diffed or status-flipped.
  if (grn.status !== "PENDING_RECONCILIATION") {
    const openCount = await prisma.discrepancy.count({
      where: { grnId, status: { in: ["OPEN", "DISPUTED"] } },
    });
    return { hasDiscrepancy: openCount > 0, discrepancyCount: openCount };
  }

  // Still pending but rows already exist → a previous run crashed between
  // creating rows and updating statuses. Skip creation, finish the status leg.
  const existingCount = await prisma.discrepancy.count({ where: { grnId } });

  let hasDiscrepancy: boolean;
  let discrepancyCount: number;

  if (existingCount > 0) {
    discrepancyCount = await prisma.discrepancy.count({
      where: { grnId, status: { in: ["OPEN", "DISPUTED"] } },
    });
    hasDiscrepancy = discrepancyCount > 0;
  } else {
    const result = computeGrnVariances(
      grn.po.lineItems.map((l) => ({
        skuId: l.skuId,
        requestedQty: l.requestedQty,
        approvedQty: l.approvedQty,
        unitPrice: l.unitPrice,
        rawData: l.rawData,
      })),
      grn.lineItems.map((l) => ({
        skuId: l.skuId,
        receivedQty: l.receivedQty,
        rejectedQty: l.rejectedQty,
        rejectionReason: l.rejectionReason,
      })),
      grn.po.dispatchRecord?.lineItems,
    );
    hasDiscrepancy = result.hasDiscrepancy;
    discrepancyCount = result.rows.length;

    if (result.rows.length > 0) {
      await prisma.discrepancy.createMany({
        data: result.rows.map((r) => ({
          poId: grn.poId,
          grnId,
          skuId: r.skuId,
          // dispatchedQty mirrors baselineQty for legacy consumers (debit notes, exports)
          dispatchedQty: r.baselineQty,
          receivedQty: r.receivedQty,
          varianceQty: r.varianceQty,
          variancePct: r.variancePct,
          type: r.type,
          baseline: r.baseline,
          baselineQty: r.baselineQty,
          valueImpact: r.valueImpact,
          rejectionReason: r.rejectionReason,
        })),
      });
    }
  }

  if (hasDiscrepancy) {
    await prisma.purchaseOrder.update({
      where: { id: grn.poId },
      data: { status: "DISCREPANCY" },
    });
    await prisma.grnRecord.update({
      where: { id: grnId },
      data: { status: "DISCREPANCY_FLAGGED" },
    });
    await writeAudit({
      entityType: "PurchaseOrder",
      entityId: grn.poId,
      action: "DISCREPANCY_FLAGGED",
      performedBy: "system",
      changes: { discrepancyCount },
    });
    if (notify) {
      await sendWhatsAppAlert(
        `⚠️ GRN discrepancy on PO ${grn.po.channelPoNumber} (${grn.po.channel.name}). ` +
          `Review at ${env.NEXT_PUBLIC_APP_URL}/reconciliation`,
      );
    }
  } else {
    // Never downgrade a PO the sync/ops already closed — matters for the
    // deferred pass, where autoInvoice=false means nothing would re-close it.
    if (grn.po.status !== "CLOSED") {
      await prisma.purchaseOrder.update({
        where: { id: grn.poId },
        data: { status: "GRN_RECEIVED" },
      });
    }
    await prisma.grnRecord.update({
      where: { id: grnId },
      data: { status: "ACCEPTED", reconciledAt: new Date() },
    });
    await writeAudit({
      entityType: "PurchaseOrder",
      entityId: grn.poId,
      action: "GRN_ACCEPTED",
      performedBy: "system",
    });
    if (autoInvoice) await generateAndSendInvoice(grn.poId, grnId);
  }

  return { hasDiscrepancy, discrepancyCount };
}

/** Sequence helper: INV-2026-0042 style. */
async function nextSequence(prefix: string): Promise<string> {
  const year = new Date().getFullYear();
  const count =
    prefix === "INV"
      ? await prisma.invoice.count()
      : await prisma.discrepancy.count({ where: { status: "DEBIT_NOTE_RAISED" } });
  return `${prefix}-${year}-${String(count + 1).padStart(4, "0")}`;
}

/**
 * Build the tax invoice PDF, upload to S3, email it to the channel, and persist
 * the Invoice record. Idempotent: returns the existing invoice if already made.
 */
export async function generateAndSendInvoice(
  poId: string,
  grnId: string,
): Promise<{ invoiceId: string; invoiceNumber: string }> {
  const existing = await prisma.invoice.findUnique({ where: { poId } });
  if (existing) {
    return { invoiceId: existing.id, invoiceNumber: existing.invoiceNumber };
  }

  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    include: {
      channel: true,
      lineItems: { include: { sku: true } },
      grnRecord: { include: { lineItems: true } },
    },
  });
  if (!po || !po.grnRecord) throw new Error(`PO ${poId} / GRN not found`);

  const receivedBySku = new Map(
    po.grnRecord.lineItems.map((l) => [l.skuId, l.receivedQty]),
  );

  const lines = po.lineItems.map((li) => ({
    internalCode: li.sku.internalCode,
    name: li.sku.name,
    hsnCode: li.sku.hsnCode ?? "—",
    qty: receivedBySku.get(li.skuId) ?? li.approvedQty ?? li.requestedQty,
    rate: li.unitPrice ?? 0,
    gstRate: li.sku.gstRate,
  }));

  const invoiceNumber = await nextSequence("INV");
  const invoiceDate = new Date();

  const { buffer, totalAmount, gstAmount } = await generateInvoicePdf({
    invoiceNumber,
    invoiceDate,
    channelPoNumber: po.channelPoNumber ?? "—",
    channelGrnNumber: po.grnRecord.channelGrnNumber ?? "—",
    channel: {
      name: po.channel.name,
      gstin: po.channel.billingGstin ?? "—",
      address: po.channel.billingAddress ?? "—",
    },
    lines,
  });

  const month = String(invoiceDate.getMonth() + 1).padStart(2, "0");
  const s3Key = `invoices/${invoiceDate.getFullYear()}/${month}/${invoiceNumber}.pdf`;
  await uploadToS3({ key: s3Key, body: buffer, contentType: "application/pdf" });

  let sentAt: Date | null = null;
  if (po.channel.billingAddress) {
    const recipient = po.channel.grnSenderEmail ?? po.channel.poSenderEmail;
    if (recipient) {
      await sendEmail({
        to: recipient,
        subject: `Tax Invoice ${invoiceNumber} — PO ${po.channelPoNumber}`,
        html: `<p>Dear ${po.channel.name} team,</p><p>Please find attached tax invoice <strong>${invoiceNumber}</strong> for PO ${po.channelPoNumber}, total ${formatINR(totalAmount)}.</p>`,
        attachments: [{ filename: `${invoiceNumber}.pdf`, content: buffer }],
      });
      sentAt = new Date();
    }
  }

  const invoice = await prisma.invoice.create({
    data: {
      poId,
      grnId,
      invoiceNumber,
      invoiceDate,
      totalAmount,
      gstAmount,
      s3Key,
      sentAt,
    },
  });

  await prisma.purchaseOrder.update({
    where: { id: poId },
    data: { status: "CLOSED" },
  });
  await writeAudit({
    entityType: "PurchaseOrder",
    entityId: poId,
    action: "INVOICE_GENERATED",
    performedBy: "system",
    changes: { invoiceNumber, totalAmount },
  });

  return { invoiceId: invoice.id, invoiceNumber };
}
