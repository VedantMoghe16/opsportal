import Link from "next/link";
import { Upload, Download, Send, ClipboardCheck, Hourglass, Percent } from "lucide-react";
import { Topbar } from "@/components/layout/topbar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatCard } from "@/components/dashboard/summary-stats";
import { ChannelChip } from "@/components/shared/channel-chip";
import { GrnTable } from "@/components/grn/grn-table";
import { getGrns, getIssuedPoGrnStatus } from "@/lib/data/queries";
import { formatDateTime, relativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

const AWAITING_DISPLAY_CAP = 50;

export default async function GrnPage() {
  const [grns, issued] = await Promise.all([getGrns(), getIssuedPoGrnStatus()]);
  const awaitingShown = issued.awaiting.slice(0, AWAITING_DISPLAY_CAP);
  return (
    <>
      <Topbar title="Goods Received Notes" subtitle="Reconciliation status across all channels" />
      <main className="flex-1 space-y-6 px-5 py-6 lg:px-8">
        {/* GRN follow-up on POs issued from this portal: received vs still awaiting. */}
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          <StatCard label="POs issued" value={String(issued.issuedCount)} icon={Send} accent="lav" hint="PO emails sent from this portal" />
          <StatCard
            label="GRN received"
            value={`${issued.grnCount} of ${issued.issuedCount}`}
            icon={ClipboardCheck}
            accent="mint"
            hint={issued.issuedCount > 0 ? `${Math.round((issued.grnCount / issued.issuedCount) * 100)}% of issued POs` : undefined}
          />
          <StatCard
            label="Awaiting GRN"
            value={String(issued.awaiting.length)}
            icon={Hourglass}
            accent={issued.awaiting.length > 0 ? "danger" : "lime"}
            hint="issued POs with no GRN yet"
          />
          <StatCard
            label="Fill rate (issued POs)"
            value={issued.grossFillPct != null ? `${issued.grossFillPct}%` : "—"}
            icon={Percent}
            accent="lime"
            hint={issued.netFillPct != null ? `net ${issued.netFillPct}% of assigned` : "gross · received ÷ ordered"}
          />
        </div>

        {issued.awaiting.length > 0 && (
          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle>Awaiting GRN</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/60 text-left text-xs text-muted-foreground">
                    <th className="px-5 py-2 font-medium">Channel</th>
                    <th className="px-5 py-2 font-medium">PO Number</th>
                    <th className="px-5 py-2 font-medium">Email ref</th>
                    <th className="px-5 py-2 font-medium">Issued</th>
                    <th className="px-5 py-2 font-medium">Waiting</th>
                  </tr>
                </thead>
                <tbody>
                  {awaitingShown.map((po) => (
                    <tr key={po.id} className="border-b border-border/40 last:border-0 hover:bg-muted/40">
                      <td className="px-5 py-2.5">
                        <ChannelChip name={po.channel.name} color={po.channel.logoColor} />
                      </td>
                      <td className="px-5 py-2.5">
                        <Link href={`/orders/${po.id}`} className="font-medium hover:underline">
                          {po.channelPoNumber ?? "—"}
                        </Link>
                      </td>
                      <td className="px-5 py-2.5 font-mono text-[11px] text-muted-foreground">{po.emailRef ?? "—"}</td>
                      <td className="px-5 py-2.5 text-muted-foreground">{formatDateTime(po.emailSentAt)}</td>
                      <td className="px-5 py-2.5 text-muted-foreground">
                        {po.emailSentAt ? relativeTime(po.emailSentAt).replace(" ago", "") : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {issued.awaiting.length > awaitingShown.length && (
                <div className="border-t border-border/60 px-5 py-3 text-xs text-muted-foreground">
                  Showing {awaitingShown.length} of {issued.awaiting.length} — see Orders for the full list.
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <Card className="overflow-hidden">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle>All GRNs</CardTitle>
            <div className="flex items-center gap-2">
              <Button asChild size="sm" variant="outline">
                <a href="/api/grn/export"><Download className="h-4 w-4" /> Download Excel</a>
              </Button>
              <Button asChild size="sm">
                <Link href="/grn/upload"><Upload className="h-4 w-4" /> Upload CSV</Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <GrnTable grns={grns} />
          </CardContent>
        </Card>
      </main>
    </>
  );
}
