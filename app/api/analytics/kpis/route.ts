import { NextRequest } from "next/server";
import { ok, handler } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { computeKpis } from "@/lib/services/analytics";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  return handler("GET /api/analytics/kpis", async () => {
    await requireAuth();
    return ok(await computeKpis());
  });
}
