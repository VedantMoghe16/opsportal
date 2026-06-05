import {
  Inbox, Flag, ClipboardCheck, Mail, Truck, PackageCheck,
  FileCheck2, AlertTriangle, ReceiptText, type LucideIcon,
} from "lucide-react";
import { formatDateTime } from "@/lib/utils";
import { cn } from "@/lib/utils";

const ICONS: Record<string, LucideIcon> = {
  PO_RECEIVED: Inbox,
  PRIORITY_CHANGED: Flag,
  STATUS_CHANGED: Flag,
  ALLOCATED: ClipboardCheck,
  APPROVED: Mail,
  DISPATCHED: Truck,
  DELIVERED: PackageCheck,
  GRN_ACCEPTED: FileCheck2,
  GRN_REMINDER_SENT: Mail,
  DISCREPANCY_FLAGGED: AlertTriangle,
  INVOICE_GENERATED: ReceiptText,
};

const LABELS: Record<string, string> = {
  PO_RECEIVED: "PO received",
  PRIORITY_CHANGED: "Priority updated",
  STATUS_CHANGED: "Status changed",
  ALLOCATED: "Allocated",
  APPROVED: "Approved & warehouse emailed",
  DISPATCHED: "Dispatched",
  DELIVERED: "Delivered",
  GRN_ACCEPTED: "GRN accepted",
  GRN_REMINDER_SENT: "GRN reminder sent",
  DISCREPANCY_FLAGGED: "Discrepancy flagged",
  INVOICE_GENERATED: "Invoice generated",
  DISCREPANCY_ACCEPT: "Shortage accepted",
  DISCREPANCY_DEBIT_NOTE: "Debit note raised",
  DISCREPANCY_DISPUTE: "Marked disputed",
};

export interface TimelineEvent {
  id: string;
  action: string;
  performedBy: string | null;
  createdAt: Date | string;
  changes?: unknown;
}

export function OrderTimeline({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) {
    return <p className="text-sm text-muted-foreground">No events yet.</p>;
  }
  return (
    <ol className="relative space-y-5 pl-2">
      {events.map((e, i) => {
        const Icon = ICONS[e.action] ?? Flag;
        const isDanger = e.action.includes("DISCREPANCY") && e.action.includes("FLAGGED");
        return (
          <li key={e.id} className="relative flex gap-3.5">
            {i < events.length - 1 && (
              <span className="absolute left-[15px] top-9 h-[calc(100%+4px)] w-px bg-border" />
            )}
            <span
              className={cn(
                "z-10 grid h-8 w-8 shrink-0 place-items-center rounded-full",
                isDanger
                  ? "bg-[hsl(0_72%_56%/0.13)] text-danger"
                  : "bg-lime-soft text-[hsl(72_60%_28%)]",
              )}
            >
              <Icon className="h-4 w-4" />
            </span>
            <div className="pt-1">
              <div className="text-sm font-medium">{LABELS[e.action] ?? e.action}</div>
              <div className="text-xs text-muted-foreground">
                {formatDateTime(e.createdAt)}
                {e.performedBy ? ` · ${e.performedBy}` : ""}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
