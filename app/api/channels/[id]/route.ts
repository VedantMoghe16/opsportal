import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ok, handler } from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { writeAudit } from "@/lib/services/audit";

export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().min(1).optional(),
  emailDomain: z.string().min(1).optional(),
  tier: z.enum(["A", "B", "C"]).optional(),
  fillRateCommitment: z.number().min(0).max(100).optional(),
  deliverySlaHours: z.number().int().positive().optional(),
  portalUrl: z.string().url().nullable().optional(),
  grnViaEmail: z.boolean().optional(),
  grnViaPortal: z.boolean().optional(),
  active: z.boolean().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  return handler("PATCH /api/channels/[id]", async () => {
    const actor = await currentActor();
    const data = schema.parse(await req.json());
    const channel = await prisma.channel.update({ where: { id: params.id }, data });
    await writeAudit({
      entityType: "Channel",
      entityId: params.id,
      action: "CHANNEL_UPDATED",
      performedBy: actor.label,
      changes: data,
    });
    return ok(channel);
  });
}
