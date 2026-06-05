import "server-only";
import { env } from "@/lib/env";
import { getTokens } from "@/lib/integrations/blinkit/auth";
import { BlinkitClient, BlinkitAuthExpired } from "@/lib/integrations/blinkit/client";
import { parseDumpFile } from "@/lib/integrations/blinkit/parse";
import { ingestBlinkitDump, type IngestSummary } from "@/lib/services/blinkit-ingest";

const IST_OFFSET_MS = 5.5 * 3_600_000;

/** A date N days ago in IST as YYYY-MM-DD. */
function istDaysAgo(n: number): string {
  return new Date(Date.now() + IST_OFFSET_MS - n * 86_400_000).toISOString().slice(0, 10);
}
function istToday(): string {
  return istDaysAgo(0);
}

export interface SyncResult {
  since: string;
  until: string;
  fileName: string | null;
  summary: IngestSummary;
}

/**
 * Live-scrape Blinkit POs from partnersbiz for [since, until] (defaults: from the
 * configured backfill floor — June 1 — through today IST), then ingest into the
 * pipeline. Re-authenticates once via OTP if the cached token has expired.
 */
export async function syncBlinkit(opts: { since?: string; until?: string; actorLabel?: string } = {}): Promise<SyncResult> {
  // Default to a rolling 30-day window so settled/delivered POs are visible.
  const since = opts.since ?? istDaysAgo(30);
  // until is inclusive but the report keys on a datetime; use tomorrow so today's POs are caught.
  const until = opts.until ?? istDaysAgo(-1);
  // Filter by created_at (immediate) rather than issue_date (lags ~2 days).
  const field = env.BLINKIT_DATE_FILTER_FIELD || "created_at";
  const body = { filters: { [`${field}__gte`]: since, [`${field}__lte`]: until } };

  const runOnce = async (forceRefresh: boolean) => {
    const tokens = await getTokens(forceRefresh);
    const client = new BlinkitClient(tokens);
    // The report API needs X-Entity-Id; login doesn't return it, so discover it
    // (unless provided via BLINKIT_ENTITY_ID, which the client already prefers).
    if (!env.BLINKIT_ENTITY_ID && !tokens.entityId) {
      const id = await client.discoverEntityId();
      if (id) client.setEntityId(id);
    }
    return client.runReport({
      triggerPath: "/v1/reports/bulk-po-excel/",
      triggerBody: body,
      reportKind: "po",
    });
  };

  let download;
  try {
    download = await runOnce(false);
  } catch (err) {
    if (err instanceof BlinkitAuthExpired) {
      // token stale → re-login via OTP and retry once
      download = await runOnce(true);
    } else {
      throw err;
    }
  }

  const fileName = download.filename ?? `blinkit-po-${since}_to_${until}.csv`;
  const sheet = parseDumpFile(fileName, download.content);
  const summary = await ingestBlinkitDump(sheet, fileName, opts.actorLabel ?? "Blinkit sync");

  return { since, until, fileName: download.filename, summary };
}
