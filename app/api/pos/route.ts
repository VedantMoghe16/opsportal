import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { ok, handler } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import type { Prisma, PoStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return handler("GET /api/pos", async () => {
    await requireAuth();
    const { searchParams } = new URL(req.url);
    const channelId = searchParams.get("channelId");
    const status = searchParams.get("status") as PoStatus | null;
    const from = searchParams.get("from");
    const to = searchParams.get("to");

    const where: Prisma.PurchaseOrderWhereInput = {};
    if (channelId) where.channelId = channelId;
    if (status) where.status = status;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to);
    }

    const pos = await prisma.purchaseOrder.findMany({
      where,
      orderBy: [{ priorityScore: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        channelPoNumber: true,
        status: true,
        priority: true,
        priorityScore: true,
        totalRequestedValue: true,
        requestedDeliveryDate: true,
        createdAt: true,
        channel: { select: { id: true, name: true, logoColor: true, tier: true } },
        _count: { select: { lineItems: true } },
      },
    });
    return ok(pos);
  });
}
