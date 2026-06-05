import { NextRequest, NextResponse } from "next/server";
import { validateCron } from "@/lib/cron";
import { prisma } from "@/lib/db";
import { scrapeChannelPortal } from "@/lib/integrations/playwright";
import { reconcileGrn } from "@/lib/services/reconcile";
import { sendWhatsAppAlert } from "@/lib/integrations/twilio";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const unauthorized = validateCron(req);
  if (unauthorized) return unauthorized;

  console.log("[cron:scrape-portals] starting");
  try {
    const channels = await prisma.channel.findMany({
      where: { grnViaPortal: true, active: true, portalUrl: { not: null } },
    });

    let grnsCreated = 0;
    for (const channel of channels) {
      console.log(`[cron:scrape-portals] scraping ${channel.name}`);
      const scraped = await scrapeChannelPortal(channel);

      const codeMap = await prisma.channelSku.findMany({ where: { channelId: channel.id } });
      const skuByCode = new Map(codeMap.map((c) => [c.channelSkuCode, c.skuId]));

      for (const grn of scraped) {
        // De-dupe by channel GRN number
        const exists = await prisma.grnRecord.findFirst({
          where: { channelGrnNumber: grn.channelGrnNumber, po: { channelId: channel.id } },
        });
        if (exists) continue;

        // Match to a delivered PO for this channel
        const po = await prisma.purchaseOrder.findFirst({
          where: { channelId: channel.id, status: "DELIVERED" },
          orderBy: { updatedAt: "desc" },
        });
        if (!po) continue;

        const created = await prisma.grnRecord.create({
          data: {
            poId: po.id,
            source: "PORTAL",
            channelGrnNumber: grn.channelGrnNumber,
            rawData: JSON.stringify(grn),
            lineItems: {
              create: grn.lines
                .map((l) => {
                  const skuId = skuByCode.get(l.channelSkuCode);
                  if (!skuId) return null;
                  return {
                    skuId,
                    receivedQty: l.receivedQty,
                    rejectedQty: l.rejectedQty,
                  };
                })
                .filter((x): x is NonNullable<typeof x> => x !== null),
            },
          },
        });
        await reconcileGrn(created.id);
        grnsCreated++;
      }
    }

    console.log("[cron:scrape-portals] done", { channels: channels.length, grnsCreated });
    return NextResponse.json({
      success: true,
      data: { channels: channels.length, grnsCreated },
    });
  } catch (error) {
    console.error("[cron:scrape-portals]", error);
    await sendWhatsAppAlert(
      `🚨 Cron failure: scrape-portals — ${error instanceof Error ? error.message : "unknown"}`,
    );
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
