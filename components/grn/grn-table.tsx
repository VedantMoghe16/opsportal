"use client";

import Link from "next/link";
import { Mail, Globe, FileSpreadsheet, CheckCircle2 } from "lucide-react";
import type { GrnSource, GrnStatus } from "@prisma/client";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ChannelChip } from "@/components/shared/channel-chip";
import { EmptyState } from "@/components/shared/empty-state";
import { GRN_STATUS_META } from "@/lib/status";
import { formatINR, formatDate } from "@/lib/utils";

const SOURCE_META: Record<GrnSource, { label: string; icon: typeof Mail }> = {
  EMAIL: { label: "Email", icon: Mail },
  PORTAL: { label: "Portal", icon: Globe },
  MANUAL_CSV: { label: "CSV", icon: FileSpreadsheet },
};

export interface GrnRow {
  id: string;
  source: GrnSource;
  channelGrnNumber: string | null;
  status: GrnStatus;
  receivedAt: Date | string;
  totalAcceptedValue: number | null;
  po: { id: string; channelPoNumber: string | null; channel: { name: string; logoColor: string | null } };
  _count: { lineItems: number; discrepancies: number };
}

export function GrnTable({ grns }: { grns: GrnRow[] }) {
  if (grns.length === 0) {
    return (
      <EmptyState
        icon={CheckCircle2}
        title="No GRNs yet"
        description="GRNs arrive via channel email, portal scrape, or manual CSV upload after delivery."
      />
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Channel</TableHead>
          <TableHead>GRN / PO</TableHead>
          <TableHead>Source</TableHead>
          <TableHead className="text-right">Lines</TableHead>
          <TableHead className="text-right">Discrepancies</TableHead>
          <TableHead>Received</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {grns.map((grn) => {
          const Src = SOURCE_META[grn.source];
          const meta = GRN_STATUS_META[grn.status];
          return (
            <TableRow key={grn.id}>
              <TableCell>
                <ChannelChip name={grn.po.channel.name} color={grn.po.channel.logoColor} />
              </TableCell>
              <TableCell>
                <Link href={`/orders/${grn.po.id}`} className="font-medium hover:underline">
                  {grn.channelGrnNumber ?? "—"}
                </Link>
                <div className="text-xs text-muted-foreground">{grn.po.channelPoNumber}</div>
              </TableCell>
              <TableCell>
                <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Src.icon className="h-3.5 w-3.5" /> {Src.label}
                </span>
              </TableCell>
              <TableCell className="text-right nums text-muted-foreground">
                {grn._count.lineItems}
              </TableCell>
              <TableCell className="text-right nums">
                {grn._count.discrepancies > 0 ? (
                  <Badge variant="danger">{grn._count.discrepancies}</Badge>
                ) : (
                  <span className="text-muted-foreground">0</span>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground">{formatDate(grn.receivedAt)}</TableCell>
              <TableCell><Badge variant={meta.variant}>{meta.label}</Badge></TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
