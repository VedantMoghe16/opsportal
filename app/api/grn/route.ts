import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { ok, handler } from "@/lib/api";
import { requireAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  return handler("GET /api/grn", async () => {
    await requireAuth();
    const grns = await prisma.grnRecord.findMany({
      orderBy: { receivedAt: "desc" },
      select: {
        id: true,
        source: true,
        channelGrnNumber: true,
        status: true,
        receivedAt: true,
        totalAcceptedValue: true,
        po: {
          select: {
            id: true,
            channelPoNumber: true,
            channel: { select: { name: true, logoColor: true } },
          },
        },
        _count: { select: { lineItems: true, discrepancies: true } },
      },
    });
    return ok(grns);
  });
}
