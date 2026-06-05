import type { PoStatus, GrnStatus, DiscrepancyStatus } from "@prisma/client";
import type { BadgeProps } from "@/components/ui/badge";

type Variant = NonNullable<BadgeProps["variant"]>;

export const PO_STATUS_META: Record<
  PoStatus,
  { label: string; variant: Variant }
> = {
  PENDING_REVIEW: { label: "Pending review", variant: "default" },
  PRIORITISED: { label: "Prioritised", variant: "info" },
  ALLOCATED: { label: "Allocated", variant: "purple" },
  APPROVED: { label: "Approved", variant: "purple" },
  DISPATCHED: { label: "Dispatched", variant: "warning" },
  DELIVERED: { label: "Delivered", variant: "mint" },
  GRN_RECEIVED: { label: "GRN received", variant: "info" },
  CLOSED: { label: "Closed", variant: "success" },
  DISCREPANCY: { label: "Discrepancy", variant: "danger" },
  ON_HOLD: { label: "On hold", variant: "warning" },
};

export const PO_STATUS_ORDER: PoStatus[] = [
  "PENDING_REVIEW",
  "PRIORITISED",
  "ALLOCATED",
  "APPROVED",
  "DISPATCHED",
  "DELIVERED",
  "GRN_RECEIVED",
  "CLOSED",
  "DISCREPANCY",
  "ON_HOLD",
];

export const GRN_STATUS_META: Record<GrnStatus, { label: string; variant: Variant }> = {
  PENDING_RECONCILIATION: { label: "Pending", variant: "warning" },
  ACCEPTED: { label: "Accepted", variant: "success" },
  DISCREPANCY_FLAGGED: { label: "Discrepancy", variant: "danger" },
  RESOLVED: { label: "Resolved", variant: "info" },
};

export const DISCREPANCY_STATUS_META: Record<
  DiscrepancyStatus,
  { label: string; variant: Variant }
> = {
  OPEN: { label: "Open", variant: "danger" },
  ACCEPTED: { label: "Accepted", variant: "warning" },
  DEBIT_NOTE_RAISED: { label: "Debit note", variant: "purple" },
  DISPUTED: { label: "Disputed", variant: "info" },
  RESOLVED: { label: "Resolved", variant: "success" },
};

export const PRIORITY_META: Record<string, { label: string; variant: Variant }> = {
  P1: { label: "P1", variant: "danger" },
  P2: { label: "P2", variant: "warning" },
  P3: { label: "P3", variant: "info" },
};
