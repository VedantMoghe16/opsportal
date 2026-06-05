import "server-only";
import { prisma } from "@/lib/db";

const DAY = 86_400_000;
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

export interface Kpis {
  summary: { avgFillRate: number; avgTat: number; acceptanceRate: number; ordersThisMonth: number };
  fillRateByChannel: { channel: string; fillRate: number }[];
  dispatchTat: { date: string; hours: number }[];
  grnAcceptance: { name: string; value: number }[];
  orderVolume: { date: string; count: number }[];
}

export async function computeKpis(): Promise<Kpis> {
  const now = Date.now();
  const since = new Date(now - 30 * DAY);

  const pos = await prisma.purchaseOrder.findMany({
    where: { createdAt: { gte: since } },
    select: {
      createdAt: true,
      approvedAt: true,
      channel: { select: { name: true } },
      lineItems: { select: { requestedQty: true, approvedQty: true } },
      dispatchRecord: { select: { dispatchedAt: true } },
      grnRecord: { select: { status: true } },
    },
  });

  // 1. Fill rate by channel
  const fillByChannel = new Map<string, { requested: number; approved: number }>();
  for (const po of pos) {
    const agg = fillByChannel.get(po.channel.name) ?? { requested: 0, approved: 0 };
    for (const li of po.lineItems) {
      agg.requested += li.requestedQty;
      agg.approved += li.approvedQty ?? 0;
    }
    fillByChannel.set(po.channel.name, agg);
  }
  const fillRateByChannel = [...fillByChannel.entries()].map(([channel, v]) => ({
    channel,
    fillRate: v.requested ? Math.round((v.approved / v.requested) * 1000) / 10 : 0,
  }));

  // 2. Dispatch TAT by day
  const tatByDay = new Map<string, number[]>();
  for (const po of pos) {
    if (po.approvedAt && po.dispatchRecord?.dispatchedAt) {
      const hours = (po.dispatchRecord.dispatchedAt.getTime() - po.approvedAt.getTime()) / 3_600_000;
      if (hours >= 0) {
        const k = dayKey(po.dispatchRecord.dispatchedAt);
        (tatByDay.get(k) ?? tatByDay.set(k, []).get(k)!).push(hours);
      }
    }
  }
  const dispatchTat = [...tatByDay.entries()].sort().map(([date, hrs]) => ({
    date,
    hours: Math.round((hrs.reduce((s, h) => s + h, 0) / hrs.length) * 10) / 10,
  }));

  // 3. GRN acceptance
  let autoAccepted = 0, flagged = 0, resolved = 0;
  for (const po of pos) {
    const s = po.grnRecord?.status;
    if (s === "ACCEPTED") autoAccepted++;
    else if (s === "DISCREPANCY_FLAGGED") flagged++;
    else if (s === "RESOLVED") resolved++;
  }
  const grnAcceptance = [
    { name: "Auto-accepted", value: autoAccepted },
    { name: "Discrepancy flagged", value: flagged },
    { name: "Manually resolved", value: resolved },
  ];

  // 4. Order volume trend
  const volumeByDay = new Map<string, number>();
  for (let i = 29; i >= 0; i--) volumeByDay.set(dayKey(new Date(now - i * DAY)), 0);
  for (const po of pos) {
    const k = dayKey(po.createdAt);
    if (volumeByDay.has(k)) volumeByDay.set(k, (volumeByDay.get(k) ?? 0) + 1);
  }
  const orderVolume = [...volumeByDay.entries()].map(([date, count]) => ({ date, count }));

  // Summary
  const totalReq = [...fillByChannel.values()].reduce((s, v) => s + v.requested, 0);
  const totalApp = [...fillByChannel.values()].reduce((s, v) => s + v.approved, 0);
  const avgFillRate = totalReq ? Math.round((totalApp / totalReq) * 1000) / 10 : 0;
  const allTat = [...tatByDay.values()].flat();
  const avgTat = allTat.length ? Math.round((allTat.reduce((s, h) => s + h, 0) / allTat.length) * 10) / 10 : 0;
  const grnTotal = autoAccepted + flagged + resolved;
  const acceptanceRate = grnTotal ? Math.round(((autoAccepted + resolved) / grnTotal) * 1000) / 10 : 0;

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const ordersThisMonth = await prisma.purchaseOrder.count({ where: { createdAt: { gte: startOfMonth } } });

  return {
    summary: { avgFillRate, avgTat, acceptanceRate, ordersThisMonth },
    fillRateByChannel,
    dispatchTat,
    grnAcceptance,
    orderVolume,
  };
}
