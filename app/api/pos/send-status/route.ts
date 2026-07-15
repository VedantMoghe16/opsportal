import { NextRequest } from "next/server";
import { ok, fail, handler } from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export interface PoSendStatus {
  poId: string;
  channelPoNumber: string | null;
  emailStatus: string;
  emailRef: string | null;
  emailSentAt: string | null;
  emailSentBy: string | null;
  emailHoldReason: string | null;
}

/**
 * GET /api/pos/send-status?ids=a,b,c
 * Server-authoritative send state for a set of POs, read straight from the DB.
 *
 * The bulk-send UI calls this AFTER a run to decide which POs still need sending —
 * instead of trusting the browser's in-memory tally, which is lost when a whole batch
 * request times out or errors mid-flight (the root cause of the duplicate-send incident:
 * an errored batch made the UI re-send POs that had actually already gone out). Whatever
 * the network did, the DB knows which POs are truly SENT.
 */
export async function GET(req: NextRequest) {
  return handler("GET /api/pos/send-status", async () => {
    await currentActor(); // require auth
    const idsParam = req.nextUrl.searchParams.get("ids")?.trim();
    if (!idsParam) return fail(new Error("ids query param required"), 400);
    const ids = [...new Set(idsParam.split(",").map((s) => s.trim()).filter(Boolean))];
    if (ids.length === 0) return fail(new Error("no valid ids"), 400);
    if (ids.length > 500) return fail(new Error("too many ids (max 500)"), 400);

    const pos = await prisma.purchaseOrder.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        channelPoNumber: true,
        emailStatus: true,
        emailRef: true,
        emailSentAt: true,
        emailSentBy: true,
        emailHoldReason: true,
      },
    });

    const statuses: PoSendStatus[] = pos.map((p) => ({
      poId: p.id,
      channelPoNumber: p.channelPoNumber,
      emailStatus: p.emailStatus,
      emailRef: p.emailRef,
      emailSentAt: p.emailSentAt ? p.emailSentAt.toISOString() : null,
      emailSentBy: p.emailSentBy,
      emailHoldReason: p.emailHoldReason,
    }));

    return ok({ statuses });
  });
}
