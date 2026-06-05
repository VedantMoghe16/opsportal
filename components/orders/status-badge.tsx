import type { PoStatus } from "@prisma/client";
import { Badge } from "@/components/ui/badge";
import { PO_STATUS_META } from "@/lib/status";

export function StatusBadge({ status }: { status: PoStatus }) {
  const meta = PO_STATUS_META[status];
  return <Badge variant={meta.variant}>{meta.label}</Badge>;
}
