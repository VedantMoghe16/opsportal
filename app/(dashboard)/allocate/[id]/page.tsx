import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Topbar } from "@/components/layout/topbar";
import { Card, CardContent } from "@/components/ui/card";
import { ChannelChip } from "@/components/shared/channel-chip";
import { StatusBadge } from "@/components/orders/status-badge";
import { PoAllocator } from "@/components/allocation/po-allocator";
import { getPoForAllocation } from "@/lib/data/queries";
import { formatINR, formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function AllocatePoPage({ params }: { params: { id: string } }) {
  const po = await getPoForAllocation(params.id);
  if (!po) notFound();

  const receivedBySku: Record<string, number> = {};
  for (const l of po.grnRecord?.lineItems ?? []) receivedBySku[l.skuId] = l.receivedQty;

  return (
    <>
      <Topbar title={`Allocate · ${po.channelPoNumber ?? "PO"}`} subtitle={po.channel.name} />
      <main className="flex-1 px-5 py-6 lg:px-8">
        <Link href="/allocate" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to allocation
        </Link>

        <Card className="mb-6">
          <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-4 p-5">
            <ChannelChip name={po.channel.name} color={po.channel.logoColor} tier={po.channel.tier} />
            <div><div className="text-xs text-muted-foreground">PO Number</div><div className="font-medium">{po.channelPoNumber}</div></div>
            <div><div className="text-xs text-muted-foreground">Status</div><div className="mt-0.5"><StatusBadge status={po.status} /></div></div>
            <div><div className="text-xs text-muted-foreground">PO date</div><div className="font-medium">{formatDate(po.poDate)}</div></div>
            <div><div className="text-xs text-muted-foreground">Value</div><div className="font-medium nums">{formatINR(po.totalRequestedValue)}</div></div>
            <div><div className="text-xs text-muted-foreground">Items</div><div className="font-medium nums">{po.lineItems.length}</div></div>
          </CardContent>
        </Card>

        <PoAllocator
          poId={po.id}
          lines={po.lineItems.map((l) => ({ ...l, rawData: (l.rawData as Record<string, string> | null) }))}
          receivedBySku={receivedBySku}
        />
      </main>
    </>
  );
}
