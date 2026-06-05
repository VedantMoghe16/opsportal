import { env } from "@/lib/env";

// Persist a single timer across HMR / re-imports in dev.
const g = globalThis as unknown as { __zeptoTimer?: NodeJS.Timeout };

/**
 * Hit the unattended cron endpoint on our own server. We go over HTTP (rather
 * than importing the sync code) so this module stays free of Node-only deps
 * (imapflow/googleapis) that can't be bundled into Next's instrumentation.
 */
async function triggerSync(ifStale: boolean): Promise<void> {
  const base = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  const url = `${base}/api/cron/zepto-sync${ifStale ? "?ifStale=1" : ""}`;
  try {
    const res = await fetch(url, {
      headers: env.CRON_SECRET ? { authorization: `Bearer ${env.CRON_SECRET}` } : {},
    });
    const json = (await res.json().catch(() => ({}))) as { data?: { skipped?: boolean; summary?: { posUpserted?: number } } };
    if (json.data?.skipped) console.log("[zepto:auto] data fresh — skipped");
    else console.log(`[zepto:auto] sync ${res.ok ? "ok" : "failed"} (${res.status})`, json.data?.summary?.posUpserted ?? "");
  } catch (e) {
    console.error("[zepto:auto] trigger failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * Start the background Zepto auto-sync. Idempotent (guards against HMR/double
 * registration). Re-scrapes every ZEPTO_SYNC_INTERVAL_HOURS, plus a startup
 * catch-up that only runs if the data is already older than that window.
 */
export function startZeptoAutoSync(): void {
  if (env.ZEPTO_AUTO_SYNC === "false") {
    console.log("[zepto:auto] disabled (ZEPTO_AUTO_SYNC=false)");
    return;
  }
  if (g.__zeptoTimer) return;
  const hours = env.ZEPTO_SYNC_INTERVAL_HOURS;
  const intervalMs = hours * 3_600_000;

  g.__zeptoTimer = setInterval(() => void triggerSync(false), intervalMs);
  if (typeof g.__zeptoTimer.unref === "function") g.__zeptoTimer.unref();
  console.log(`[zepto:auto] scheduled every ${hours}h`);

  // Startup catch-up (server needs a moment to start listening).
  setTimeout(() => void triggerSync(true), 14_000);
}
