import Link from "next/link";
import { History } from "lucide-react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ChannelChip } from "@/components/shared/channel-chip";
import { EmptyState } from "@/components/shared/empty-state";
import { DISCREPANCY_STATUS_META, DISCREPANCY_TYPE_META } from "@/lib/status";
import { formatDate, formatINR } from "@/lib/utils";
import type { DiscrepancyRow } from "./discrepancy-table";

export type ResolvedRow = DiscrepancyRow & {
  resolvedBy: string | null;
  resolvedAt: Date | string | null;
  resolutionNotes: string | null;
};

export function ResolvedTable({ rows }: { rows: ResolvedRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={History}
        title="Nothing resolved yet"
        description="Accepted variances, debit notes, and resolved disputes will build up a history here."
      />
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Channel</TableHead>
          <TableHead>PO / SKU</TableHead>
          <TableHead>Type</TableHead>
          <TableHead className="text-right">Variance</TableHead>
          <TableHead className="text-right">₹ impact</TableHead>
          <TableHead>Outcome</TableHead>
          <TableHead>Resolved by</TableHead>
          <TableHead>Resolved on</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((d) => {
          const meta = DISCREPANCY_STATUS_META[d.status];
          const typeMeta = DISCREPANCY_TYPE_META[d.type];
          return (
            <TableRow key={d.id}>
              <TableCell>
                <ChannelChip name={d.grnRecord.po.channel.name} color={d.grnRecord.po.channel.logoColor} />
              </TableCell>
              <TableCell>
                <Link href={`/orders/${d.grnRecord.po.id}`} className="font-medium hover:underline">
                  {d.grnRecord.po.channelPoNumber}
                </Link>
                <div className="text-xs text-muted-foreground">{d.sku.internalCode}</div>
              </TableCell>
              <TableCell><Badge variant={typeMeta.variant}>{typeMeta.label}</Badge></TableCell>
              <TableCell className="text-right nums">{d.varianceQty}</TableCell>
              <TableCell className="text-right nums">
                {d.valueImpact != null ? formatINR(d.valueImpact) : "—"}
              </TableCell>
              <TableCell>
                <Badge variant={meta.variant}>{meta.label}</Badge>
                {d.resolutionNotes && (
                  <div className="mt-0.5 max-w-[200px] truncate text-xs text-muted-foreground" title={d.resolutionNotes}>
                    {d.resolutionNotes}
                  </div>
                )}
              </TableCell>
              <TableCell className="text-sm">{d.resolvedBy ?? "—"}</TableCell>
              <TableCell className="text-sm">{formatDate(d.resolvedAt)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
