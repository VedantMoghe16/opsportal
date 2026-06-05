import { Topbar } from "@/components/layout/topbar";
import { BlinkitDashboard } from "@/components/blinkit/blinkit-dashboard";
import { computeBlinkitInsights } from "@/lib/services/blinkit-analytics";

export const dynamic = "force-dynamic";

export default async function BlinkitPage({
  searchParams,
}: {
  searchParams: { days?: string };
}) {
  const days = Math.min(90, Math.max(1, Number(searchParams.days) || 7));
  const insights = await computeBlinkitInsights(days);
  return (
    <>
      <Topbar title="Blinkit" subtitle="Purchase orders ingested from Blinkit partner dumps" />
      <main className="flex-1 px-5 py-6 lg:px-8">
        <BlinkitDashboard insights={insights} days={days} />
      </main>
    </>
  );
}
