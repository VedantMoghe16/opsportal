import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import type { ParsedEmail } from "@/lib/integrations/gmail";
import {
  parsePurchaseOrderEmail,
  parseDispatchEmail,
  parseGrnEmail,
  parseDeliveryEmail,
  scorePriority,
} from "@/lib/integrations/claude";
import { reconcileGrn } from "@/lib/services/reconcile";
import { sendWhatsAppAlert } from "@/lib/integrations/twilio";
import { writeAudit } from "@/lib/services/audit";
import { formatINR } from "@/lib/utils";

type EmailType =
  | "PO_RECEIVED"
  | "DISPATCH_CONFIRMATION"
  | "GRN_EMAIL"
  | "DELIVERY_CONFIRMATION"
  | "UNKNOWN";

const PO_KEYWORDS = ["purchase order", "po ", "po#", "po number", "new order"];
const DISPATCH_KEYWORDS = ["awb", "dispatch", "shipped", "manifest"];
const LOGISTICS_DOMAINS = ["delhivery.com", "bluedart.com", "ecomexpress.in", "shiprocket.in"];

async function identifyType(email: ParsedEmail): Promise<{
  type: EmailType;
  channelId?: string;
}> {
  const subject = email.subject.toLowerCase();
  const domain = email.fromDomain;

  // PO: sender domain matches a channel + PO keywords in subject
  const channelByDomain = await prisma.channel.findUnique({
    where: { emailDomain: domain },
  });
  if (channelByDomain && PO_KEYWORDS.some((k) => subject.includes(k))) {
    return { type: "PO_RECEIVED", channelId: channelByDomain.id };
  }

  // Dispatch: from warehouse + AWB/dispatch keywords
  if (
    email.from === env.WAREHOUSE_EMAIL.toLowerCase() &&
    DISPATCH_KEYWORDS.some((k) => subject.includes(k) || email.body.toLowerCase().includes(k))
  ) {
    return { type: "DISPATCH_CONFIRMATION" };
  }

  // GRN: sender matches any channel grnSenderEmail
  const grnChannel = await prisma.channel.findFirst({
    where: { grnSenderEmail: email.from },
  });
  if (grnChannel) return { type: "GRN_EMAIL", channelId: grnChannel.id };

  // Delivery: known logistics providers
  if (LOGISTICS_DOMAINS.includes(domain)) {
    return { type: "DELIVERY_CONFIRMATION" };
  }

  return { type: "UNKNOWN" };
}

export interface PollResult {
  processed: number;
  skipped: number;
  byType: Record<string, number>;
}

/** Core poller logic: idempotent per gmail message id. */
export async function processEmails(emails: ParsedEmail[]): Promise<PollResult> {
  let processed = 0;
  let skipped = 0;
  const byType: Record<string, number> = {};
  const newPosByChannel: Record<string, number> = {};
  let newPoTotalValue = 0;

  for (const email of emails) {
    // ── Idempotency guard ──
    const seen = await prisma.processedEmail.findUnique({
      where: { gmailMessageId: email.id },
    });
    if (seen) {
      skipped++;
      continue;
    }

    const { type, channelId } = await identifyType(email);
    // Reserve immediately so a retry can't double-process.
    await prisma.processedEmail.create({
      data: {
        gmailMessageId: email.id,
        emailType: type.toLowerCase(),
        result: undefined,
      },
    });
    byType[type] = (byType[type] ?? 0) + 1;

    if (type === "UNKNOWN") {
      console.log(`[poll] unknown email from ${email.from} — "${email.subject}"`);
      processed++;
      continue;
    }

    try {
      let resultJson: Record<string, unknown> = {};
      let linkedPoId: string | undefined;

      if (type === "PO_RECEIVED" && channelId) {
        const r = await handlePo(email, channelId);
        resultJson = { channelPoNumber: r.channelPoNumber };
        linkedPoId = r.poId;
        newPosByChannel[r.channelName] = (newPosByChannel[r.channelName] ?? 0) + 1;
        newPoTotalValue += r.totalValue;
      } else if (type === "DISPATCH_CONFIRMATION") {
        const r = await handleDispatch(email);
        resultJson = { awb: r.awb };
        linkedPoId = r.poId;
      } else if (type === "GRN_EMAIL" && channelId) {
        const r = await handleGrn(email, channelId);
        resultJson = { channelGrnNumber: r.channelGrnNumber };
        linkedPoId = r.poId;
      } else if (type === "DELIVERY_CONFIRMATION") {
        const r = await handleDelivery(email);
        resultJson = { awb: r.awb };
        linkedPoId = r.poId;
      }

      await prisma.processedEmail.update({
        where: { gmailMessageId: email.id },
        data: { result: resultJson as Prisma.InputJsonValue, poId: linkedPoId },
      });
      processed++;
    } catch (err) {
      console.error(`[poll] failed processing ${type} email ${email.id}`, err);
      await prisma.processedEmail.update({
        where: { gmailMessageId: email.id },
        data: { result: { error: err instanceof Error ? err.message : "unknown" } },
      });
      processed++;
    }
  }

  // Batch WhatsApp notification for new POs
  const channelNames = Object.keys(newPosByChannel);
  if (channelNames.length > 0) {
    const total = channelNames.reduce((s, c) => s + newPosByChannel[c]!, 0);
    await sendWhatsAppAlert(
      `📦 New PO batch: ${total} orders from ${channelNames.join(", ")} ` +
        `(${formatINR(newPoTotalValue)}) — review at ${env.NEXT_PUBLIC_APP_URL}`,
    );
  }

  return { processed, skipped, byType };
}

async function handlePo(email: ParsedEmail, channelId: string) {
  const channel = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
  const parsed = await parsePurchaseOrderEmail(email.body);

  // Map channel SKU codes → internal SKU ids
  const codeMap = await prisma.channelSku.findMany({
    where: { channelId, channelSkuCode: { in: parsed.line_items.map((l) => l.channel_sku_code) } },
  });
  const skuByChannelCode = new Map(codeMap.map((c) => [c.channelSkuCode, c.skuId]));

  const lineItems = parsed.line_items
    .map((l) => {
      const skuId = skuByChannelCode.get(l.channel_sku_code);
      if (!skuId) return null;
      return {
        skuId,
        channelSkuCode: l.channel_sku_code,
        requestedQty: l.requested_qty,
        unitPrice: l.unit_price,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const totalValue = lineItems.reduce(
    (s, l) => s + l.requestedQty * (l.unitPrice ?? 0),
    0,
  );

  const po = await prisma.purchaseOrder.create({
    data: {
      channelId,
      channelPoNumber: parsed.channel_po_number,
      gmailMessageId: email.id,
      poDate: parsed.po_date ? new Date(parsed.po_date) : email.date,
      requestedDeliveryDate: parsed.requested_delivery_date
        ? new Date(parsed.requested_delivery_date)
        : null,
      totalRequestedValue: totalValue,
      opsNotes: parsed.special_instructions ?? null,
      rawEmailBody: email.body,
      rawEmailSubject: email.subject,
      lineItems: { create: lineItems },
    },
  });

  // AI priority score
  try {
    const score = await scorePriority({
      channelName: channel.name,
      channelTier: channel.tier,
      fillRateCommitment: channel.fillRateCommitment,
      deliverySlaHours: channel.deliverySlaHours,
      totalValue,
      requestedDeliveryDate: parsed.requested_delivery_date,
      today: new Date().toISOString(),
    });
    await prisma.purchaseOrder.update({
      where: { id: po.id },
      data: {
        priority: score.priority,
        priorityScore: score.priority_score,
        priorityRationale: score.rationale,
        status: "PRIORITISED",
      },
    });
  } catch (err) {
    console.error("[poll] priority scoring failed", err);
  }

  await writeAudit({
    entityType: "PurchaseOrder",
    entityId: po.id,
    action: "PO_RECEIVED",
    performedBy: "system",
    changes: { channelPoNumber: po.channelPoNumber, totalValue },
  });

  return {
    poId: po.id,
    channelPoNumber: po.channelPoNumber ?? po.id,
    channelName: channel.name,
    totalValue,
  };
}

async function handleDispatch(email: ParsedEmail) {
  const parsed = await parseDispatchEmail(email.body);
  // Match PO by warehouse instruction reference id in the body, else by AWB.
  const refMatch = email.body.match(/Reference ID:\s*([a-z0-9]+)/i);
  let po = null;
  if (refMatch) {
    const wi = await prisma.warehouseInstruction.findUnique({
      where: { id: refMatch[1] },
      include: { po: true },
    });
    po = wi?.po ?? null;
  }
  if (!po) {
    // Fall back: most recent APPROVED PO
    po = await prisma.purchaseOrder.findFirst({
      where: { status: "APPROVED" },
      orderBy: { approvedAt: "desc" },
    });
  }
  if (!po) throw new Error("Could not match dispatch email to a PO");

  const wi = await prisma.warehouseInstruction.findUnique({ where: { poId: po.id } });
  const skuMap = await prisma.poLineItem.findMany({
    where: { poId: po.id },
    include: { sku: true },
  });
  const skuByCode = new Map(skuMap.map((l) => [l.channelSkuCode ?? l.sku.internalCode, l.skuId]));
  const skuByInternal = new Map(skuMap.map((l) => [l.sku.internalCode, l.skuId]));

  const dispatch = await prisma.dispatchRecord.create({
    data: {
      poId: po.id,
      warehouseInstructionId: wi?.id,
      gmailMessageId: email.id,
      awbNumber: parsed.awb_number,
      carrierName: parsed.carrier_name,
      dispatchedAt: parsed.dispatched_at ? new Date(parsed.dispatched_at) : email.date,
      rawEmailBody: email.body,
      lineItems: {
        create: parsed.line_items
          .map((l) => {
            const skuId =
              (l.channel_sku_code && skuByCode.get(l.channel_sku_code)) ||
              (l.internal_code && skuByInternal.get(l.internal_code));
            if (!skuId) return null;
            return { skuId, dispatchedQty: l.dispatched_qty };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null),
      },
    },
    include: { lineItems: true },
  });

  await prisma.purchaseOrder.update({
    where: { id: po.id },
    data: { status: "DISPATCHED" },
  });

  // Variance alert vs approved qty (>5%)
  for (const dl of dispatch.lineItems) {
    const approved = skuMap.find((l) => l.skuId === dl.skuId)?.approvedQty;
    if (approved && approved > 0) {
      const variance = Math.abs((approved - dl.dispatchedQty) / approved) * 100;
      if (variance > 5) {
        const sku = skuMap.find((l) => l.skuId === dl.skuId)?.sku.internalCode;
        await sendWhatsAppAlert(
          `⚠️ Dispatch variance on PO ${po.channelPoNumber}: ${sku} — approved ${approved} dispatched ${dl.dispatchedQty}`,
        );
      }
    }
  }

  await writeAudit({
    entityType: "PurchaseOrder",
    entityId: po.id,
    action: "DISPATCHED",
    performedBy: "system",
    changes: { awb: parsed.awb_number },
  });

  return { poId: po.id, awb: parsed.awb_number };
}

async function handleGrn(email: ParsedEmail, channelId: string) {
  const parsed = await parseGrnEmail(email.body);
  const codeMap = await prisma.channelSku.findMany({ where: { channelId } });
  const skuByCode = new Map(codeMap.map((c) => [c.channelSkuCode, c.skuId]));

  // Match PO by channel GRN/PO reference present in body; else latest DELIVERED.
  let po = null;
  const poMatch = email.body.match(/PO[\s#:-]*([A-Z0-9-]+)/i);
  if (poMatch) {
    po = await prisma.purchaseOrder.findFirst({
      where: { channelId, channelPoNumber: { contains: poMatch[1] } },
    });
  }
  if (!po) {
    po = await prisma.purchaseOrder.findFirst({
      where: { channelId, status: "DELIVERED" },
      orderBy: { updatedAt: "desc" },
    });
  }
  if (!po) throw new Error("Could not match GRN email to a PO");

  const grn = await prisma.grnRecord.create({
    data: {
      poId: po.id,
      source: "EMAIL",
      gmailMessageId: email.id,
      channelGrnNumber: parsed.channel_grn_number,
      rawData: email.body,
      lineItems: {
        create: parsed.line_items
          .map((l) => {
            const skuId = l.channel_sku_code ? skuByCode.get(l.channel_sku_code) : undefined;
            if (!skuId) return null;
            return {
              skuId,
              receivedQty: l.received_qty,
              rejectedQty: l.rejected_qty ?? 0,
              rejectionReason: l.rejection_reason ?? null,
            };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null),
      },
    },
  });

  await reconcileGrn(grn.id);
  return { poId: po.id, channelGrnNumber: parsed.channel_grn_number };
}

async function handleDelivery(email: ParsedEmail) {
  const parsed = await parseDeliveryEmail(email.body);
  let dispatch = null;
  if (parsed.awb_number) {
    dispatch = await prisma.dispatchRecord.findFirst({
      where: { awbNumber: parsed.awb_number },
    });
  }
  if (!dispatch) {
    dispatch = await prisma.dispatchRecord.findFirst({
      where: { deliveryRecord: null },
      orderBy: { dispatchedAt: "desc" },
    });
  }
  if (!dispatch) throw new Error("Could not match delivery email to a dispatch");

  const deliveredAt = parsed.delivered_at ? new Date(parsed.delivered_at) : email.date;
  await prisma.deliveryRecord.create({
    data: {
      poId: dispatch.poId,
      dispatchRecordId: dispatch.id,
      gmailMessageId: email.id,
      deliveredAt,
      deliveryStatus: parsed.delivery_status ?? "DELIVERED",
      grnDeadline: new Date(deliveredAt.getTime() + 48 * 3_600_000),
    },
  });
  await prisma.purchaseOrder.update({
    where: { id: dispatch.poId },
    data: { status: "DELIVERED" },
  });
  await writeAudit({
    entityType: "PurchaseOrder",
    entityId: dispatch.poId,
    action: "DELIVERED",
    performedBy: "system",
  });

  return { poId: dispatch.poId, awb: parsed.awb_number };
}
