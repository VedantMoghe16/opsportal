import "server-only";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { sendWhatsAppAlert } from "@/lib/integrations/twilio";
import { sendEmail } from "@/lib/integrations/resend";
import { uploadToS3 } from "@/lib/integrations/s3";
import { generateInvoicePdf } from "@/lib/integrations/pdf";
import { writeAudit } from "@/lib/services/audit";
import { formatINR } from "@/lib/utils";

const TOLERANCE_PCT = 2.0;

/**
 * Diff a GRN's received quantities against what was dispatched.
 * Within tolerance → accept + auto-invoice. Otherwise → flag discrepancies.
 */
export async function reconcileGrn(grnId: string): Promise<{
  hasDiscrepancy: boolean;
  discrepancyCount: number;
}> {
  const grn = await prisma.grnRecord.findUnique({
    where: { id: grnId },
    include: {
      lineItems: true,
      po: {
        include: {
          channel: true,
          dispatchRecord: { include: { lineItems: true } },
        },
      },
    },
  });
  if (!grn) throw new Error(`GRN ${grnId} not found`);

  let hasDiscrepancy = false;
  let discrepancyCount = 0;

  for (const grnLine of grn.lineItems) {
    const dispatched = grn.po.dispatchRecord?.lineItems.find(
      (d) => d.skuId === grnLine.skuId,
    );
    if (!dispatched) continue;

    const varianceQty = dispatched.dispatchedQty - grnLine.receivedQty;
    const variancePct =
      dispatched.dispatchedQty === 0
        ? 0
        : Math.abs(varianceQty / dispatched.dispatchedQty) * 100;

    if (variancePct > TOLERANCE_PCT) {
      hasDiscrepancy = true;
      discrepancyCount++;
      await prisma.discrepancy.create({
        data: {
          poId: grn.poId,
          grnId,
          skuId: grnLine.skuId,
          dispatchedQty: dispatched.dispatchedQty,
          receivedQty: grnLine.receivedQty,
          varianceQty,
          variancePct,
        },
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
    await sendWhatsAppAlert(
      `⚠️ GRN discrepancy on PO ${grn.po.channelPoNumber} (${grn.po.channel.name}). ` +
        `Review at ${env.NEXT_PUBLIC_APP_URL}/reconciliation`,
    );
  } else {
    await prisma.purchaseOrder.update({
      where: { id: grn.poId },
      data: { status: "GRN_RECEIVED" },
    });
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
    await generateAndSendInvoice(grn.poId, grnId);
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
