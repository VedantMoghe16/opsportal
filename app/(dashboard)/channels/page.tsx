import Link from "next/link";
import { ArrowRight, Boxes } from "lucide-react";
import { Topbar } from "@/components/layout/topbar";
import { Card } from "@/components/ui/card";
import { prisma } from "@/lib/db";
import { CHANNELS } from "@/lib/channels";
import { formatINR, formatNumber, relativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

interface ChannelStat {
  poCount: number;
  totalValue: number;
  lastSyncedAt: Date | null;
}

async function loadChannelStats(): Promise<Record<string, ChannelStat>> {
  const grouped = await prisma.purchaseOrder.groupBy({
    by: ["source"],
    _count: { _all: true },
    _sum: { totalRequestedValue: true },
    _max: { updatedAt: true },
  });
  const bySource: Record<string, ChannelStat> = {};
  for (const g of grouped) {
    bySource[g.source] = {
      poCount: g._count._all,
      totalValue: g._sum.totalRequestedValue ?? 0,
      lastSyncedAt: g._max.updatedAt ?? null,
    };
  }
  return bySource;
}

export default async function ChannelsPage() {
  const stats = await loadChannelStats();

  return (
    <>
      <Topbar title="Channels" subtitle="Purchase-order analytics across every sales channel" />
      <main className="flex-1 px-5 py-6 lg:px-8">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {CHANNELS.map((channel) => {
            const stat = stats[channel.source];
            const hasData = !!stat && stat.poCount > 0;
            return (
              <Link
                key={channel.slug}
                href={`/channels/${channel.slug}`}
                className="group focus-visible:outline-none"
              >
                <Card className="h-full p-5 transition-shadow hover:shadow-soft focus-visible:ring-2 focus-visible:ring-ring/40">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span
                        className="grid h-10 w-10 place-items-center rounded-xl text-white"
                        style={{ background: channel.logoColor }}
                      >
                        <Boxes className="h-5 w-5" />
                      </span>
                      <div>
                        <div className="font-semibold">{channel.name}</div>
                        <div className="text-xs text-muted-foreground">/{channel.slug}</div>
                      </div>
                    </div>
                    <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </div>

                  {hasData ? (
                    <dl className="mt-5 grid grid-cols-2 gap-4">
                      <div>
                        <dt className="text-xs text-muted-foreground">Purchase orders</dt>
                        <dd className="text-lg font-semibold nums">{formatNumber(stat.poCount)}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">Order value</dt>
                        <dd className="text-lg font-semibold nums">{formatINR(stat.totalValue)}</dd>
                      </div>
                      <div className="col-span-2">
                        <dt className="text-xs text-muted-foreground">Last sync</dt>
                        <dd className="text-sm">
                          {stat.lastSyncedAt ? relativeTime(stat.lastSyncedAt) : "—"}
                        </dd>
                      </div>
                    </dl>
                  ) : (
                    <p className="mt-5 text-sm text-muted-foreground">
                      No purchase orders yet. Open the channel to sync.
                    </p>
                  )}
                </Card>
              </Link>
            );
          })}
        </div>
      </main>
    </>
  );
}
