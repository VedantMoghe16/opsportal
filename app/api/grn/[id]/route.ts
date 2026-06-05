import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { ok, fail, handler } from "@/lib/api";
import { requireAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  return handler("GET /api/grn/[id]", async () => {
    await requireAuth();
    const grn = await prisma.grnRecord.findUnique({
      where: { id: params.id },
      include: {
        lineItems: { include: { sku: true } },
        discrepancies: { include: { sku: true } },
        po: {
          include: {
            channel: true,
            dispatchRecord: { include: { lineItems: { include: { sku: true } } } },
          },
        },
      },
    });
    if (!grn) return fail(new Error("GRN not found"), 404);
    return ok(grn);
  });
}
