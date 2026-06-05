import { NextRequest, NextResponse } from "next/server";
import { validateCron } from "@/lib/cron";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { syncZepto } from "@/lib/services/zepto-sync";
import { sendWhatsAppAlert } from "@/lib/integrations/twilio";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Real-time-ish Zepto sync: re-pulls POs since the backfill floor and upserts. */
export async function GET(req: NextRequest) {
  const unauthorized = validateCron(req);
  if (unauthorized) return unauthorized;

  // ?ifStale=1 → only sync when the latest Zepto PO is older than the interval.
  if (new URL(req.url).searchParams.get("ifStale") === "1") {
    const latest = await prisma.purchaseOrder.findFirst({
      where: { source: "ZEPTO" },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    });
    const ageMs = latest ? Date.now() - latest.updatedAt.getTime() : Infinity;
    if (ageMs < env.ZEPTO_SYNC_INTERVAL_HOURS * 3_600_000) {
      return NextResponse.json({ success: true, data: { skipped: true, reason: "fresh" } });
    }
  }

  console.log("[cron:zepto-sync] starting");
  try {
    const result = await syncZepto({ actorLabel: "Zepto cron" });
    console.log("[cron:zepto-sync] done", {
      pos: result.summary.posUpserted,
      lines: result.summary.lineItems,
    });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error("[cron:zepto-sync]", error);
    await sendWhatsAppAlert(
      `🚨 Cron failure: zepto-sync — ${error instanceof Error ? error.message : "unknown"}`,
    );
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
