import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, handler } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { autoMapUnmappedChannelSkus } from "@/lib/services/sku-auto-mapper";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const schema = z.object({
  items: z
    .array(
      z.object({
        source: z.string().min(1),
        channelSkuCode: z.string().min(1),
        name: z.string().default(""),
      }),
    )
    .min(1),
});

/**
 * POST /api/sku-mappings/auto-map
 * Gemini matches each unmapped channel SKU to an existing internal SKU and
 * persists high-confidence matches into the SKU master (multi-code). Admin only
 * (it writes the master). Returns per-item results + how many were applied.
 */
export async function POST(req: NextRequest) {
  return handler("POST /api/sku-mappings/auto-map", async () => {
    const actor = await requireAdmin();
    const { items } = schema.parse(await req.json());
    const { results, appliedCount } = await autoMapUnmappedChannelSkus(items, actor.label);
    return ok({ results, appliedCount });
  });
}
