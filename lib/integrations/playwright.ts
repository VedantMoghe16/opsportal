import "server-only";
import { chromium } from "playwright";
import type { Channel } from "@prisma/client";
import { sendWhatsAppAlert } from "@/lib/integrations/twilio";

export interface ScrapedGrn {
  channelGrnNumber: string;
  lines: { channelSkuCode: string; receivedQty: number; rejectedQty: number }[];
}

/**
 * Log into a channel partner portal and scrape pending GRNs.
 * Uses role-based selectors and explicit waits per the spec's Playwright rules.
 * Returns [] (after alerting) on any failure so the cron loop continues.
 */
export async function scrapeChannelPortal(channel: Channel): Promise<ScrapedGrn[]> {
  if (!channel.portalUrl || !channel.portalUsername || !channel.portalPasswordEnvVar) {
    return [];
  }
  const password = process.env[channel.portalPasswordEnvVar];
  if (!password) {
    await sendWhatsAppAlert(
      `🚨 Portal scrape skipped for ${channel.name}: env var ${channel.portalPasswordEnvVar} is unset.`,
    );
    return [];
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();

    // ── Login ──
    await page.goto(channel.portalUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(
      '[data-testid="email"], input[type="email"], #email',
      { timeout: 10_000 },
    );
    await page.fill(
      '[data-testid="email"], input[type="email"], #email',
      channel.portalUsername,
    );
    await page.fill(
      '[data-testid="password"], input[type="password"], #password',
      password,
    );
    await page.click('[type="submit"]');
    await page.waitForURL("**/dashboard**", { timeout: 15_000 });

    // Re-auth guard: if we bounced back to a login form, retry once.
    if (await page.locator('input[type="password"]').count()) {
      await page.fill('input[type="password"]', password);
      await page.click('[type="submit"]');
      await page.waitForURL("**/dashboard**", { timeout: 15_000 });
    }

    // ── Navigate to GRN section (channel-specific in production) ──
    // Generic role-based extraction of a GRN table.
    const grns: ScrapedGrn[] = [];
    const rows = page.getByRole("row");
    const count = await rows.count();
    for (let i = 1; i < count; i++) {
      const cells = rows.nth(i).getByRole("cell");
      if ((await cells.count()) < 3) continue;
      const grnNo = (await cells.nth(0).innerText()).trim();
      const skuCode = (await cells.nth(1).innerText()).trim();
      const received = parseInt((await cells.nth(2).innerText()).replace(/\D/g, ""), 10) || 0;
      if (!grnNo) continue;
      const existing = grns.find((g) => g.channelGrnNumber === grnNo);
      const line = { channelSkuCode: skuCode, receivedQty: received, rejectedQty: 0 };
      if (existing) existing.lines.push(line);
      else grns.push({ channelGrnNumber: grnNo, lines: [line] });
    }
    return grns;
  } catch (err) {
    await sendWhatsAppAlert(
      `🚨 Portal scrape failed for ${channel.name}: ${err instanceof Error ? err.message : "unknown error"}`,
    );
    console.error(`[playwright] scrape failed for ${channel.name}`, err);
    return [];
  } finally {
    await browser.close();
  }
}
