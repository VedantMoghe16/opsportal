import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/services/audit";
import type { ParsedSheet } from "@/lib/integrations/blinkit/parse";
import { resolveFields, toNumber, toDate, type FieldMap } from "@/lib/integrations/blinkit/fields";

export interface IngestSummary {
  source: "zepto";
  fileName: string;
  headers: string[];
  fieldMap: FieldMap;
  unmappedHeaders: string[];
  totalRows: number;
  posUpserted: number;
  lineItems: number;
  skusCreated: number;
  poNumbers: string[];
  warnings: string[];
}

async function getZeptoChannelId(): Promise<string> {
  const existing =
    (await prisma.channel.findFirst({ where: { name: "Zepto" } })) ??
    (await prisma.channel.findUnique({ where: { emailDomain: "zeptonow.com" } }));
  if (existing) return existing.id;
  const created = await prisma.channel.create({
    data: {
      name: "Zepto",
      emailDomain: "zeptonow.com",
      tier: "A",
      fillRateCommitment: 95,
      deliverySlaHours: 24,
      logoColor: "#7B2D8E", // Zepto purple
      grnViaEmail: true,
    },
  });
  return created.id;
}

type PoStatus =
  | "PENDING_REVIEW" | "PRIORITISED" | "ALLOCATED" | "APPROVED" | "DISPATCHED"
  | "DELIVERED" | "GRN_RECEIVED" | "CLOSED" | "DISCREPANCY" | "ON_HOLD";

/** Map a Zepto PO state + received quantities to our pipeline status. */
function mapStatus(rawState: string, totalReceived: number, allReceived: boolean): PoStatus {
  if (allReceived) return "CLOSED"; // fully delivered + GRN'd
  if (totalReceived > 0) return "GRN_RECEIVED"; // partially received
  if (/cancel|expired|reject/.test(rawState)) return "ON_HOLD";
  return "PENDING_REVIEW"; // open / new → still to allocate
}

function skuCodeFor(itemCode: string | undefined, itemName: string | undefined, idx: number): string {
  if (itemCode && itemCode.trim()) return itemCode.trim();
  if (itemName && itemName.trim()) {
    return "ZEP-" + itemName.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 24);
  }
  return `ZEP-ROW-${idx}`;
}

/**
 * Ingest a parsed Zepto PO sheet into the PO pipeline. Idempotent per PO number.
 * Mirrors the Blinkit ingest (same field resolution, SKU upserts, GRN handling)
 * but writes source="ZEPTO" / externalId "zepto:<poNo>" / channel "Zepto".
 */
export async function ingestZeptoDump(
  sheet: ParsedSheet,
  fileName: string,
  actorLabel = "Zepto import",
): Promise<IngestSummary> {
  const channelId = await getZeptoChannelId();
  const fieldMap = resolveFields(sheet.headers);
  const warnings: string[] = [];

  const get = (row: Record<string, string>, c: keyof FieldMap): string | undefined => {
    const h = fieldMap[c];
    return h ? row[h] : undefined;
  };

  // Group rows by PO number (fallback: one synthetic PO for the whole file).
  const groups = new Map<string, Record<string, string>[]>();
  for (const row of sheet.rows) {
    const poNo = (get(row, "poNumber") ?? "").trim() || `FILE-${fileName}`;
    const arr = groups.get(poNo) ?? [];
    arr.push(row);
    groups.set(poNo, arr);
  }
  if (!fieldMap.poNumber) warnings.push("No PO-number column detected — grouped all rows under one PO.");
  if (!fieldMap.quantity) warnings.push("No quantity column detected — quantities default to 0.");

  const survivingRows = [...groups.values()].flat();

  // Pre-resolve / create SKUs for every distinct code.
  const skuIdByCode = new Map<string, string>();
  let skusCreated = 0;
  let idx = 0;
  for (const row of survivingRows) {
    idx++;
    const code = skuCodeFor(get(row, "itemCode"), get(row, "itemName"), idx);
    if (skuIdByCode.has(code)) continue;
    const name = (get(row, "itemName") ?? code).trim() || code;
    const existing = await prisma.sku.findUnique({ where: { internalCode: code } });
    if (existing) {
      skuIdByCode.set(code, existing.id);
    } else {
      const created = await prisma.sku.create({
        data: {
          internalCode: code,
          name,
          category: (get(row, "category") ?? "Zepto").trim() || "Zepto",
          uom: (get(row, "uom") ?? "unit").trim() || "unit",
        },
      });
      skuIdByCode.set(code, created.id);
      skusCreated++;
    }
  }

  let posUpserted = 0;
  let lineItems = 0;
  const poNumbers: string[] = [];

  let gi = 0;
  for (const [poNo, rows] of groups) {
    gi++;
    const head = rows[0]!;
    const poDate = toDate(get(head, "poDate"));
    const deliveryDate = toDate(get(head, "deliveryDate"));

    const rawStatus = (get(head, "status") ?? "").trim().toLowerCase();

    let total = 0;
    let totalReceived = 0;
    const lineData = rows.map((row, i) => {
      const code = skuCodeFor(get(row, "itemCode"), get(row, "itemName"), gi * 10000 + i);
      const ordered = Math.max(0, Math.round(toNumber(get(row, "quantity")) ?? 0));
      const remainingRaw = toNumber(get(row, "remaining"));
      const received =
        remainingRaw != null ? Math.max(0, Math.min(ordered, ordered - Math.round(remainingRaw))) : 0;
      totalReceived += received;
      const unit = toNumber(get(row, "unitPrice")) ?? toNumber(get(row, "mrp"));
      const lineVal = toNumber(get(row, "lineValue")) ?? (unit != null ? unit * ordered : null);
      if (lineVal != null) total += lineVal;
      const skuId = skuIdByCode.get(code)!;
      return {
        line: {
          skuId,
          channelSkuCode: get(row, "itemCode") ?? null,
          requestedQty: ordered,
          unitPrice: unit,
          rawData: row as Prisma.InputJsonValue,
        },
        received,
      };
    });

    const allReceived = lineData.length > 0 && lineData.every((l) => l.received >= l.line.requestedQty);
    const status = mapStatus(rawStatus, totalReceived, allReceived);
    const hasGrn = totalReceived > 0;

    const externalId = `zepto:${poNo}`;
    await prisma.$transaction(async (tx) => {
      const po = await tx.purchaseOrder.upsert({
        where: { externalId },
        create: {
          channelId,
          externalId,
          source: "ZEPTO",
          channelPoNumber: poNo,
          status,
          poDate: poDate ?? undefined,
          requestedDeliveryDate: deliveryDate ?? undefined,
          totalRequestedValue: total || null,
          rawData: head as Prisma.InputJsonValue,
          rawEmailSubject: `Zepto PO ${poNo}`,
          ...(poDate ? { createdAt: poDate } : {}),
        },
        update: {
          channelPoNumber: poNo,
          status,
          poDate: poDate ?? undefined,
          requestedDeliveryDate: deliveryDate ?? undefined,
          totalRequestedValue: total || null,
          rawData: head as Prisma.InputJsonValue,
        },
      });

      // Replace line items (idempotent re-import)
      await tx.poLineItem.deleteMany({ where: { poId: po.id } });
      for (const { line } of lineData) {
        await tx.poLineItem.create({ data: { ...line, poId: po.id } });
      }

      // Replace GRN (received quantities), stored as a PORTAL GRN.
      await tx.discrepancy.deleteMany({ where: { poId: po.id } });
      await tx.grnRecord.deleteMany({ where: { poId: po.id } });
      if (hasGrn) {
        await tx.grnRecord.create({
          data: {
            poId: po.id,
            source: "PORTAL",
            channelGrnNumber: null,
            status: allReceived ? "ACCEPTED" : "PENDING_RECONCILIATION",
            receivedAt: deliveryDate ?? poDate ?? undefined,
            lineItems: {
              create: lineData
                .filter((l) => l.received > 0)
                .map((l) => ({ skuId: l.line.skuId, receivedQty: l.received, rejectedQty: 0 })),
            },
          },
        });
      }

      await writeAudit({
        tx,
        entityType: "PurchaseOrder",
        entityId: po.id,
        action: "ZEPTO_IMPORTED",
        performedBy: actorLabel,
        changes: { poNumber: poNo, lines: lineData.length, totalValue: total, received: totalReceived, status },
      });
    });
    posUpserted++;
    lineItems += lineData.length;
    poNumbers.push(poNo);
  }

  const mappedHeaders = new Set(Object.values(fieldMap));
  const unmappedHeaders = sheet.headers.filter((h) => !mappedHeaders.has(h));

  return {
    source: "zepto",
    fileName,
    headers: sheet.headers,
    fieldMap,
    unmappedHeaders,
    totalRows: sheet.rows.length,
    posUpserted,
    lineItems,
    skusCreated,
    poNumbers,
    warnings,
  };
}
