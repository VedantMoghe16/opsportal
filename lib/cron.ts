import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";

/**
 * Validate the `Authorization: Bearer {CRON_SECRET}` header Vercel sends.
 * Returns a 401 response if invalid, or null to proceed.
 * In dev without a CRON_SECRET set, allows the request (so you can curl it).
 */
export function validateCron(req: NextRequest): NextResponse | null {
  if (!env.CRON_SECRET) {
    if (env.NODE_ENV === "production") {
      return NextResponse.json(
        { success: false, error: "CRON_SECRET not configured" },
        { status: 500 },
      );
    }
    return null; // dev convenience
  }
  const header = req.headers.get("authorization");
  if (header !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }
  return null;
}
