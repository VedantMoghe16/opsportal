"use client";

/**
 * Back-compat shim. The Blinkit dashboard was generalized into
 * components/channels/channel-dashboard.tsx (scoped per channel). This wrapper
 * keeps the original `<BlinkitDashboard insights days />` API working by binding
 * the Blinkit channel config.
 */
import { ChannelDashboard } from "@/components/channels/channel-dashboard";
import { getChannel } from "@/lib/channels";
import type { ChannelInsights } from "@/lib/services/blinkit-analytics";

const BLINKIT = getChannel("blinkit")!;

export function BlinkitDashboard({ insights, days }: { insights: ChannelInsights; days: number }) {
  return <ChannelDashboard channel={BLINKIT} insights={insights} days={days} />;
}
