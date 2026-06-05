import { Percent, Timer, ShieldCheck, Package } from "lucide-react";
import { Topbar } from "@/components/layout/topbar";
import { StatCard } from "@/components/dashboard/summary-stats";
import { AnalyticsCharts } from "@/components/analytics/charts";
import { computeKpis } from "@/lib/services/analytics";
import { pct } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const kpis = await computeKpis();
  return (
    <>
      <Topbar title="Analytics" subtitle="Operational KPIs · last 30 days" />
      <main className="flex-1 space-y-6 px-5 py-6 lg:px-8">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Avg fill rate" value={pct(kpis.summary.avgFillRate)} icon={Percent} accent="lime" />
          <StatCard label="Avg dispatch TAT" value={`${kpis.summary.avgTat}h`} icon={Timer} accent="mint" />
          <StatCard label="GRN acceptance" value={pct(kpis.summary.acceptanceRate)} icon={ShieldCheck} accent="lav" />
          <StatCard label="Orders this month" value={String(kpis.summary.ordersThisMonth)} icon={Package} accent="lav" />
        </div>
        <AnalyticsCharts data={kpis} />
      </main>
    </>
  );
}
