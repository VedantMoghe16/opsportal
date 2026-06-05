import { notFound } from "next/navigation";
import { Topbar } from "@/components/layout/topbar";
import { ChannelDashboard } from "@/components/channels/channel-dashboard";
import { computeChannelInsights } from "@/lib/services/blinkit-analytics";
import { getChannel } from "@/lib/channels";

export const dynamic = "force-dynamic";

export default async function ChannelPage({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams: { days?: string };
}) {
  const channel = getChannel(params.slug);
  if (!channel) notFound();

  const days = Math.min(90, Math.max(1, Number(searchParams.days) || 7));
  const insights = await computeChannelInsights({
    source: channel.source,
    slug: channel.slug,
    days,
  });

  return (
    <>
      <Topbar title={channel.name} subtitle={`Purchase orders ingested from ${channel.name}`} />
      <main className="flex-1 px-5 py-6 lg:px-8">
        <ChannelDashboard channel={channel} insights={insights} days={days} />
      </main>
    </>
  );
}
