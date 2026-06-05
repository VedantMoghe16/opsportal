import { NextRequest } from "next/server";
import { ok, handler } from "@/lib/api";
import { getTokens } from "@/lib/integrations/blinkit/auth";
import { BlinkitClient } from "@/lib/integrations/blinkit/client";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Diagnostic: probe the bulk-po-excel report with a bad filter to surface the
 * backend's valid filter-field list, and optionally test a date filter field.
 *   GET /api/blinkit/diag                 → list valid filter fields
 *   GET /api/blinkit/diag?field=created   → trigger with <field>__gte/lte
 */
export async function GET(req: NextRequest) {
  return handler("GET /api/blinkit/diag", async () => {
    const field = new URL(req.url).searchParams.get("field");
    const tokens = await getTokens(false);
    const client = new BlinkitClient(tokens);
    if (!env.BLINKIT_ENTITY_ID && !tokens.entityId) {
      const id = await client.discoverEntityId();
      if (id) client.setEntityId(id);
    }
    const filters = field
      ? { [`${field}__gte`]: "2026-05-20", [`${field}__lte`]: "2026-06-06" }
      : { __nonexistent_field__: "1" };
    const res = await client.rawReport("/v1/reports/bulk-po-excel/", { filters });
    return ok(res);
  });
}
