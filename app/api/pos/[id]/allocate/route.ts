import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ok, handler } from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { writeAudit } from "@/lib/services/audit";

export const dynamic = "force-dynamic";

const schema = z.object({
  allocations: z.array(
    z.object({ skuId: z.string(), approvedQty: z.number().int().nonnegative() }),
  ),
});

/** Persist per-SKU approved quantities for one PO (called on cell edit / save). */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  return handler("POST /api/pos/[id]/allocate", async () => {
    const actor = await currentActor();
    const { allocations } = schema.parse(await req.json());

    await prisma.$transaction(async (tx) => {
      for (const a of allocations) {
        await tx.poLineItem.updateMany({
          where: { poId: params.id, skuId: a.skuId },
          data: { approvedQty: a.approvedQty },
        });
      }
      await tx.purchaseOrder.update({
        where: { id: params.id },
        data: { status: "ALLOCATED" },
      });
      await writeAudit({
        tx,
        entityType: "PurchaseOrder",
        entityId: params.id,
        action: "ALLOCATED",
        performedBy: actor.label,
        changes: { allocations },
      });
    });

    return ok({ poId: params.id, lines: allocations.length });
  });
}
