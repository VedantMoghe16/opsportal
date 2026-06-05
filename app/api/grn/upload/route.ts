import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ok, fail, handler } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { reconcileGrn } from "@/lib/services/reconcile";

export const dynamic = "force-dynamic";

const rowSchema = z.object({
  po_number: z.string().min(1),
  sku_code: z.string().min(1),
  received_qty: z.coerce.number().int().nonnegative(),
  rejected_qty: z.coerce.number().int().nonnegative().default(0),
  rejection_reason: z.string().optional().nullable(),
});

const bodySchema = z.object({ rows: z.array(rowSchema).min(1) });

/**
 * Manual CSV GRN upload. Body: { rows: [...] } already parsed client-side.
 * Validates every row, groups by PO, creates one GRN per PO (source MANUAL_CSV),
 * then runs reconciliation.
 */
export async function POST(req: NextRequest) {
  return handler("POST /api/grn/upload", async () => {
    await requireAuth();
    const { rows } = bodySchema.parse(await req.json());

    // Resolve PO numbers + SKU codes
    const poNumbers = [...new Set(rows.map((r) => r.po_number))];
    const skuCodes = [...new Set(rows.map((r) => r.sku_code))];

    const pos = await prisma.purchaseOrder.findMany({
      where: { channelPoNumber: { in: poNumbers } },
      select: { id: true, channelPoNumber: true, channelId: true, grnRecord: { select: { id: true } } },
    });
    const skus = await prisma.sku.findMany({
      where: { internalCode: { in: skuCodes } },
      select: { id: true, internalCode: true },
    });
    const poByNumber = new Map(pos.map((p) => [p.channelPoNumber, p]));
    const skuByCode = new Map(skus.map((s) => [s.internalCode, s.id]));

    // Validate
    const errors: { row: number; message: string }[] = [];
    rows.forEach((r, i) => {
      if (!poByNumber.has(r.po_number)) errors.push({ row: i, message: `Unknown PO ${r.po_number}` });
      if (!skuByCode.has(r.sku_code)) errors.push({ row: i, message: `Unknown SKU ${r.sku_code}` });
    });
    if (errors.length > 0) {
      return fail(new Error(`Validation failed: ${errors.length} row(s)`), 400);
    }

    // Group rows by PO
    const grouped = new Map<string, typeof rows>();
    for (const r of rows) {
      const arr = grouped.get(r.po_number) ?? [];
      arr.push(r);
      grouped.set(r.po_number, arr);
    }

    const created: { poNumber: string; grnId: string; hasDiscrepancy: boolean }[] = [];
    for (const [poNumber, group] of grouped) {
      const po = poByNumber.get(poNumber)!;
      if (po.grnRecord) continue; // already has a GRN — skip (idempotent)

      const grn = await prisma.grnRecord.create({
        data: {
          poId: po.id,
          source: "MANUAL_CSV",
          rawData: JSON.stringify(group),
          lineItems: {
            create: group.map((r) => ({
              skuId: skuByCode.get(r.sku_code)!,
              receivedQty: r.received_qty,
              rejectedQty: r.rejected_qty,
              rejectionReason: r.rejection_reason ?? null,
            })),
          },
        },
      });
      const result = await reconcileGrn(grn.id);
      created.push({ poNumber, grnId: grn.id, hasDiscrepancy: result.hasDiscrepancy });
    }

    return ok({ created });
  });
}
