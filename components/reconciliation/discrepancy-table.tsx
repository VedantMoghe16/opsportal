"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Check, FileWarning, Flag, Loader2, MoreHorizontal, Zap } from "lucide-react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChannelChip } from "@/components/shared/channel-chip";
import { EmptyState } from "@/components/shared/empty-state";
import { DISCREPANCY_STATUS_META } from "@/lib/status";
import { cn, businessDaysBetween, pct } from "@/lib/utils";

export interface DiscrepancyRow {
  id: string;
  dispatchedQty: number;
  receivedQty: number;
  varianceQty: number;
  variancePct: number;
  status: keyof typeof DISCREPANCY_STATUS_META;
  createdAt: Date | string;
  sku: { internalCode: string; name: string };
  grnRecord: {
    channelGrnNumber: string | null;
    po: { id: string; channelPoNumber: string | null; channel: { name: string; logoColor: string | null } };
  };
}

type Action = "accept" | "debit_note" | "dispute";

export function DiscrepancyTable({ rows }: { rows: DiscrepancyRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Zap}
        title="No open discrepancies"
        description="GRNs within the 2% tolerance auto-accept and invoice. Anything outside it lands here."
      />
    );
  }

  async function resolve(id: string, action: Action) {
    setBusy(id);
    try {
      const res = await fetch(`/api/discrepancies/${id}/resolve`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      const msg = action === "accept" ? "Shortage accepted" : action === "debit_note" ? "Debit note raised & emailed" : "Marked disputed";
      toast.success(msg);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Channel</TableHead>
          <TableHead>PO / SKU</TableHead>
          <TableHead className="text-right">Dispatched</TableHead>
          <TableHead className="text-right">Received</TableHead>
          <TableHead className="text-right">Shortage</TableHead>
          <TableHead className="text-right">Variance</TableHead>
          <TableHead className="text-right">Days open</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((d) => {
          const meta = DISCREPANCY_STATUS_META[d.status];
          const days = businessDaysBetween(new Date(d.createdAt), new Date());
          const stale = days > 5;
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
              <TableCell className="text-right nums">{d.dispatchedQty}</TableCell>
              <TableCell className="text-right nums">{d.receivedQty}</TableCell>
              <TableCell className="text-right nums font-medium text-danger">{d.varianceQty}</TableCell>
              <TableCell className="text-right nums">{pct(d.variancePct)}</TableCell>
              <TableCell className={cn("text-right nums", stale && "font-semibold text-danger")}>{days}</TableCell>
              <TableCell><Badge variant={meta.variant}>{meta.label}</Badge></TableCell>
              <TableCell className="text-right">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="icon-sm" disabled={busy === d.id}>
                      {busy === d.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => resolve(d.id, "accept")}>
                      <Check className="text-success" /> Accept shortage
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => resolve(d.id, "debit_note")}>
                      <FileWarning className="text-[hsl(265_56%_46%)]" /> Raise debit note
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => resolve(d.id, "dispute")}>
                      <Flag className="text-info" /> Mark disputed
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
