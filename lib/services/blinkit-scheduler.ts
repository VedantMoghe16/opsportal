import { env } from "@/lib/env";

// Persist a single timer across HMR / re-imports in dev.
const g = globalThis as unknown as { __blinkitTimer?: NodeJS.Timeout };

/**
 * Hit the unattended cron endpoint on our own server. We go over HTTP (rather
 * than importing the sync code) so this module stays free of Node-only deps
 * (imapflow/googleapis) that can't be bundled into Next's instrumentation.
 */
async function triggerSync(ifStale: boolean): Promise<void> {
  const base = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  const url = `${base}/api/cron/blinkit-sync${ifStale ? "?ifStale=1" : ""}`;
  try {
    const res = await fetch(url, {
      headers: env.CRON_SECRET ? { authorization: `Bearer ${env.CRON_SECRET}` } : {},
    });
    const json = (await res.json().catch(() => ({}))) as { data?: { skipped?: boolean; summary?: { posUpserted?: number } } };
    if (json.data?.skipped) console.log("[blinkit:auto] data fresh — skipped");
    else console.log(`[blinkit:auto] sync ${res.ok ? "ok" : "failed"} (${res.status})`, json.data?.summary?.posUpserted ?? "");
  } catch (e) {
    console.error("[blinkit:auto] trigger failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * Start the background Blinkit auto-sync. Idempotent (guards against HMR/double
 * registration). Re-scrapes every BLINKIT_SYNC_INTERVAL_HOURS, plus a startup
 * catch-up that only runs if the data is already older than that window.
 */
export function startBlinkitAutoSync(): void {
  if (env.BLINKIT_AUTO_SYNC === "false") {
    console.log("[blinkit:auto] disabled (BLINKIT_AUTO_SYNC=false)");
    return;
  }
  if (g.__blinkitTimer) return;
  const hours = env.BLINKIT_SYNC_INTERVAL_HOURS;
  const intervalMs = hours * 3_600_000;

  g.__blinkitTimer = setInterval(() => void triggerSync(false), intervalMs);
  if (typeof g.__blinkitTimer.unref === "function") g.__blinkitTimer.unref();
  console.log(`[blinkit:auto] scheduled every ${hours}h`);

  // Startup catch-up (server needs a moment to start listening).
  setTimeout(() => void triggerSync(true), 12_000);
}
