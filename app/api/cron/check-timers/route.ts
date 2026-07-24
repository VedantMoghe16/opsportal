import { NextRequest, NextResponse } from "next/server";
import { validateCron } from "@/lib/cron";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { sendEmail, grnReminderEmail } from "@/lib/integrations/resend";
import { sendWhatsAppAlert } from "@/lib/integrations/twilio";
import { writeAudit } from "@/lib/services/audit";
import { reconcileGrn } from "@/lib/services/reconcile";
import { businessDaysBetween, formatDate, formatINR } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const unauthorized = validateCron(req);
  if (unauthorized) return unauthorized;

  console.log("[cron:check-timers] starting");
  try {
    const now = new Date();
    const summary = {
      grnReminders: 0,
      escalations: 0,
      deferredReconciled: 0,
      deferredFlagged: 0,
      digestSent: false,
    };

    // ── Check 1 — GRN overdue reminders ──
    const overdue = await prisma.deliveryRecord.findMany({
      where: {
        grnDeadline: { lt: now },
        grnReminderSentAt: null,
        po: { status: "DELIVERED" },
      },
      include: { po: { include: { channel: true } } },
    });
    for (const d of overdue) {
      const channel = d.po.channel;
      const recipient = channel.grnSenderEmail ?? channel.poSenderEmail;
      if (recipient) {
        const tpl = grnReminderEmail({
          channelName: channel.name,
          channelPoNumber: d.po.channelPoNumber ?? d.po.id,
          deliveredAt: formatDate(d.deliveredAt),
        });
        await sendEmail({ to: recipient, subject: tpl.subject, html: tpl.html });
      }
      await prisma.deliveryRecord.update({
        where: { id: d.id },
        data: { grnReminderSentAt: now },
      });
      await writeAudit({
        entityType: "PurchaseOrder",
        entityId: d.poId,
        action: "GRN_REMINDER_SENT",
        performedBy: "system",
      });
      summary.grnReminders++;
    }

    // ── Check 2 — Escalate discrepancies open > 5 business days ──
    const openDiscrepancies = await prisma.discrepancy.findMany({
      where: { status: "OPEN" },
      include: { grnRecord: { include: { po: { include: { channel: true } } } }, sku: true },
    });
    const stale = openDiscrepancies.filter(
      (d) => businessDaysBetween(d.createdAt, now) > 5,
    );
    if (stale.length > 0) {
      const shown = stale.slice(0, 15);
      const lines = shown
        .map(
          (d) =>
            `• ${d.grnRecord.po.channelPoNumber} (${d.grnRecord.po.channel.name}) ${d.sku.internalCode} short ${d.varianceQty}`,
        )
        .join("\n");
      const more = stale.length > shown.length ? `\n…and ${stale.length - shown.length} more` : "";
      await sendWhatsAppAlert(
        `⏰ ${stale.length} discrepancies open >5 business days:\n${lines}${more}\nResolve: ${env.NEXT_PUBLIC_APP_URL}/reconciliation`,
      );
      summary.escalations = stale.length;
    }

    // ── Check 3 — Deferred reconciliation of settled portal GRNs ──
    // Channel syncs park receipts as PENDING_RECONCILIATION and never diff them
    // (quantities keep moving while a PO is live). Once a GRN has been quiet for
    // 3 days, receipts have settled — diff it now. Quiet mode: no per-GRN
    // WhatsApp ping and no auto-invoicing, so a historical backlog can never
    // mass-email channels; one digest summarises anything flagged.
    const settledCutoff = new Date(now.getTime() - 3 * 86_400_000);
    const settled = await prisma.grnRecord.findMany({
      where: { status: "PENDING_RECONCILIATION", receivedAt: { lt: settledCutoff } },
      select: { id: true },
      orderBy: { receivedAt: "asc" },
      take: 50, // bounded per run; the hourly cadence drains any backlog
    });
    for (const g of settled) {
      try {
        const r = await reconcileGrn(g.id, { autoInvoice: false, notify: false });
        summary.deferredReconciled++;
        if (r.hasDiscrepancy) summary.deferredFlagged++;
      } catch (err) {
        console.error("[cron:check-timers] deferred reconcile failed", g.id, err);
      }
    }
    if (summary.deferredFlagged > 0) {
      await sendWhatsAppAlert(
        `⚠️ Deferred reconciliation flagged ${summary.deferredFlagged}/${summary.deferredReconciled} settled GRNs. ` +
          `Review: ${env.NEXT_PUBLIC_APP_URL}/reconciliation`,
      );
    }

    // ── Check 4 — Morning digest (7 AM cycle only) ──
    if (now.getHours() === 7) {
      const since = new Date(now);
      since.setDate(since.getDate() - 1);
      since.setHours(7, 0, 0, 0);
      const newPos = await prisma.purchaseOrder.findMany({
        where: { createdAt: { gte: since } },
        select: { totalRequestedValue: true },
      });
      const total = newPos.reduce((s, p) => s + (p.totalRequestedValue ?? 0), 0);
      await sendWhatsAppAlert(
        `🌅 Good morning! ${newPos.length} new POs arrived overnight. ` +
          `Total value: ${formatINR(total)}. Open the dashboard to begin allocation.`,
      );
      summary.digestSent = true;
    }

    console.log("[cron:check-timers] done", summary);
    return NextResponse.json({ success: true, data: summary });
  } catch (error) {
    console.error("[cron:check-timers]", error);
    await sendWhatsAppAlert(
      `🚨 Cron failure: check-timers — ${error instanceof Error ? error.message : "unknown"}`,
    );
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
