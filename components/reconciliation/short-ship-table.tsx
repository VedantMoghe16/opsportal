import Link from "next/link";
import { PackageX } from "lucide-react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { ChannelChip } from "@/components/shared/channel-chip";
import { EmptyState } from "@/components/shared/empty-state";
import { formatDate, formatINR } from "@/lib/utils";
import type { getInternalShortShip } from "@/lib/data/queries";

type ShortShipRow = Awaited<ReturnType<typeof getInternalShortShip>>[number];

export function ShortShipTable({ rows }: { rows: ShortShipRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={PackageX}
        title="No internal short-ship"
        description="Lines where our own allocation fell short of the channel's ask (beyond 2%) show up here — a stock problem to fix, not a channel dispute."
      />
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Channel</TableHead>
          <TableHead>PO / SKU</TableHead>
          <TableHead className="text-right">Ordered</TableHead>
          <TableHead className="text-right">We committed</TableHead>
          <TableHead className="text-right">Gap</TableHead>
          <TableHead className="text-right">₹ impact</TableHead>
          <TableHead>GRN date</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={`${r.poId}-${r.skuCode}`}>
            <TableCell>
              <ChannelChip name={r.channel.name} color={r.channel.logoColor} />
            </TableCell>
            <TableCell>
              <Link href={`/orders/${r.poId}`} className="font-medium hover:underline">
                {r.channelPoNumber}
              </Link>
              <div className="text-xs text-muted-foreground">{r.skuCode} · {r.skuName}</div>
            </TableCell>
            <TableCell className="text-right nums">{r.ordered}</TableCell>
            <TableCell className="text-right nums">{r.committed}</TableCell>
            <TableCell className="text-right nums font-medium text-danger">{r.gapQty}</TableCell>
            <TableCell className="text-right nums">{r.gapValue != null ? formatINR(r.gapValue) : "—"}</TableCell>
            <TableCell className="text-sm">{formatDate(r.receivedAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
