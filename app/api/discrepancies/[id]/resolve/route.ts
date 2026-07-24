import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { ok, fail, handler } from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { writeAudit } from "@/lib/services/audit";
import { generateDebitNotePdf } from "@/lib/integrations/pdf";
import { uploadToS3 } from "@/lib/integrations/s3";
import { sendEmail } from "@/lib/integrations/resend";
import { generateAndSendInvoice } from "@/lib/services/reconcile";
import { formatINR } from "@/lib/utils";

export const dynamic = "force-dynamic";

const schema = z.object({
  action: z.enum(["accept", "debit_note", "dispute"]),
  notes: z.string().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  return handler("PATCH /api/discrepancies/[id]/resolve", async () => {
    const actor = await currentActor();
    const { action, notes } = schema.parse(await req.json());

    const disc = await prisma.discrepancy.findUnique({
      where: { id: params.id },
      include: {
        sku: true,
        grnRecord: { include: { po: { include: { channel: true } } } },
      },
    });
    if (!disc) return fail(new Error("Discrepancy not found"), 404);
    const po = disc.grnRecord.po;

    if (action === "accept") {
      await prisma.discrepancy.update({
        where: { id: params.id },
        data: { status: "ACCEPTED", resolvedBy: actor.label, resolvedAt: new Date(), resolutionNotes: notes },
      });
    } else if (action === "dispute") {
      await prisma.discrepancy.update({
        where: { id: params.id },
        data: { status: "DISPUTED", resolvedBy: actor.label, resolutionNotes: notes },
      });
    } else if (action === "debit_note") {
      if (disc.type === "EXCESS_RECEIPT" || disc.varianceQty <= 0) {
        return fail(new Error("Debit notes only apply to shortages and rejections"), 400);
      }
      const rate = disc.sku.gstRate; // for reference
      const unitPrice =
        (await prisma.poLineItem.findFirst({ where: { poId: po.id, skuId: disc.skuId } }))?.unitPrice ??
        0;
      // The PDF bills (dispatched − received) per line. Feed it quantities that
      // net to THIS row's varianceQty so a rejection row bills only the rejected
      // units, never the sibling shortage row's units too.
      const { buffer, totalShortage } = await generateDebitNotePdf({
        debitNoteNumber: `DN-${new Date().getFullYear()}-${disc.id.slice(-4).toUpperCase()}`,
        date: new Date(),
        channelPoNumber: po.channelPoNumber ?? po.id,
        channel: {
          name: po.channel.name,
          gstin: po.channel.billingGstin ?? "—",
          address: po.channel.billingAddress ?? "—",
        },
        lines: [
          {
            internalCode: disc.sku.internalCode,
            name: disc.sku.name,
            dispatchedQty: disc.receivedQty + disc.varianceQty,
            receivedQty: disc.receivedQty,
            rate: unitPrice,
          },
        ],
      });
      const year = new Date().getFullYear();
      const month = String(new Date().getMonth() + 1).padStart(2, "0");
      const key = `debit-notes/${year}/${month}/DN-${disc.id.slice(-6)}.pdf`;
      await uploadToS3({ key, body: buffer, contentType: "application/pdf" });

      const recipient = po.channel.grnSenderEmail ?? po.channel.poSenderEmail;
      if (recipient) {
        await sendEmail({
          to: recipient,
          subject: `Debit Note — PO ${po.channelPoNumber} (${disc.sku.internalCode} shortage)`,
          html: `<p>Dear ${po.channel.name} team,</p><p>Please find attached a debit note for a shortage of ${disc.varianceQty} units of ${disc.sku.internalCode} against PO ${po.channelPoNumber}, totalling ${formatINR(totalShortage)}.</p>`,
          attachments: [{ filename: `debit-note-${disc.id.slice(-6)}.pdf`, content: buffer }],
        });
      }
      await prisma.discrepancy.update({
        where: { id: params.id },
        data: {
          status: "DEBIT_NOTE_RAISED",
          resolvedBy: actor.label,
          resolvedAt: new Date(),
          resolutionNotes: notes ?? `Debit note ${key}`,
        },
      });
    }

    await writeAudit({
      entityType: "PurchaseOrder",
      entityId: po.id,
      action: `DISCREPANCY_${action.toUpperCase()}`,
      performedBy: actor.label,
      changes: { discrepancyId: params.id, sku: disc.sku.internalCode },
    });

    // If no OPEN discrepancies remain on this GRN, close it out + invoice.
    const remaining = await prisma.discrepancy.count({
      where: { grnId: disc.grnId, status: { in: ["OPEN", "DISPUTED"] } },
    });
    if (remaining === 0) {
      await prisma.grnRecord.update({
        where: { id: disc.grnId },
        data: { status: "RESOLVED", reconciledAt: new Date(), reconciledBy: actor.label },
      });
      try {
        await generateAndSendInvoice(po.id, disc.grnId);
      } catch (err) {
        console.error("[resolve] invoice generation failed", err);
      }
    }

    return ok({ resolved: true, action });
  });
}
