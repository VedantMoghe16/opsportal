import { NextRequest } from "next/server";
import { ok, handler } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { readLiveAtp } from "@/lib/integrations/sheets";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return handler("GET /api/inventory/atp", async () => {
    await requireAuth();
    const force = new URL(req.url).searchParams.get("force") === "1";
    const atp = await readLiveAtp({ force });
    return ok(atp);
  });
}
