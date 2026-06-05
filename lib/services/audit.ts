import "server-only";
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

/**
 * Append an immutable audit-log entry. `entityId` doubles as the PO id when
 * entityType is "PurchaseOrder" so the relation back-link populates.
 */
export async function writeAudit(params: {
  entityType: string;
  entityId: string;
  action: string;
  performedBy?: string | null;
  changes?: Prisma.InputJsonValue;
  tx?: Prisma.TransactionClient;
}): Promise<void> {
  const client = params.tx ?? prisma;
  await client.auditLog.create({
    data: {
      entityType: params.entityType,
      entityId: params.entityId,
      action: params.action,
      performedBy: params.performedBy ?? null,
      changes: params.changes ?? undefined,
    },
  });
}
