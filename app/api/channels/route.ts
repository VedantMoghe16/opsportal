import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { ok, handler } from "@/lib/api";
import { requireAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  return handler("GET /api/channels", async () => {
    await requireAuth();
    const channels = await prisma.channel.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { purchaseOrders: true, channelSkus: true } } },
    });
    return ok(channels);
  });
}
