/**
 * Assertions for lib/services/grn-variance.ts — run with:
 *   npx tsx scripts/test-grn-variance.ts
 */
import assert from "node:assert/strict";
import { computeGrnVariances } from "../lib/services/grn-variance";

const poLine = (over: Partial<Parameters<typeof computeGrnVariances>[0][number]> = {}) => ({
  skuId: "sku1",
  requestedQty: 100,
  approvedQty: null,
  unitPrice: null,
  rawData: null,
  ...over,
});
const grnLine = (over: Partial<Parameters<typeof computeGrnVariances>[1][number]> = {}) => ({
  skuId: "sku1",
  receivedQty: 100,
  rejectedQty: 0,
  rejectionReason: null,
  ...over,
});

// 1. Baseline chain: dispatched wins over assigned over ordered
{
  const r = computeGrnVariances(
    [poLine({ approvedQty: 95 })],
    [grnLine({ receivedQty: 80 })],
    [{ skuId: "sku1", dispatchedQty: 90 }],
  );
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0]!.baseline, "DISPATCHED");
  assert.equal(r.rows[0]!.baselineQty, 90);
  assert.equal(r.rows[0]!.varianceQty, 10);
}
{
  const r = computeGrnVariances([poLine({ approvedQty: 95 })], [grnLine({ receivedQty: 80 })], null);
  assert.equal(r.rows[0]!.baseline, "ASSIGNED");
  assert.equal(r.rows[0]!.baselineQty, 95);
}
{
  const r = computeGrnVariances([poLine()], [grnLine({ receivedQty: 80 })], null);
  assert.equal(r.rows[0]!.baseline, "ORDERED");
  assert.equal(r.rows[0]!.baselineQty, 100);
  assert.equal(r.rows[0]!.type, "SHORT_RECEIPT");
}
// ASN qty from scraped rawData used as ASSIGNED when no approvedQty
{
  const r = computeGrnVariances(
    [poLine({ rawData: { asnQty: 92 } })],
    [grnLine({ receivedQty: 80 })],
    null,
  );
  assert.equal(r.rows[0]!.baseline, "ASSIGNED");
  assert.equal(r.rows[0]!.baselineQty, 92);
}

// 2. SKU entirely missing from the GRN counts as received 0
{
  const r = computeGrnVariances([poLine()], [], null);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0]!.receivedQty, 0);
  assert.equal(r.rows[0]!.variancePct, 100);
}

// 3. Rejection bucket carries reason; rejected units are not double-counted as shortage
{
  const r = computeGrnVariances(
    [poLine()],
    [grnLine({ receivedQty: 90, rejectedQty: 5, rejectionReason: "damaged" })],
    null,
  );
  const short = r.rows.find((x) => x.type === "SHORT_RECEIPT");
  const rej = r.rows.find((x) => x.type === "CHANNEL_REJECTION");
  assert.ok(short && rej);
  assert.equal(short.varianceQty, 5); // 100 − (90 + 5), not 10
  assert.equal(rej.varianceQty, 5);
  assert.equal(rej.rejectionReason, "damaged");
}

// 4. Within tolerance → clean
{
  const r = computeGrnVariances([poLine()], [grnLine({ receivedQty: 99 })], null);
  assert.equal(r.hasDiscrepancy, false);
  assert.equal(r.rows.length, 0);
}

// 5. Aggregate tolerance: each leak under 2%, together over → both flagged
{
  const r = computeGrnVariances(
    [poLine({ requestedQty: 200 })],
    [grnLine({ receivedQty: 194, rejectedQty: 3 })], // short 3 (1.5%) + rejected 3 (1.5%) = 3%
    null,
  );
  assert.equal(r.rows.length, 2);
  assert.equal(r.aggregatePct, 3);
}

// 6. Excess receipt classified, negative variance
{
  const r = computeGrnVariances([poLine()], [grnLine({ receivedQty: 105 })], null);
  assert.equal(r.rows[0]!.type, "EXCESS_RECEIPT");
  assert.equal(r.rows[0]!.varianceQty, -5);
}

// 7. Value impact = |variance| × unit price
{
  const r = computeGrnVariances(
    [poLine({ unitPrice: 149.5 })],
    [grnLine({ receivedQty: 80 })],
    null,
  );
  assert.equal(r.rows[0]!.valueImpact, 2990);
}

// 8. GRN line for a SKU not on the PO is ignored (no baseline to judge)
{
  const r = computeGrnVariances([poLine()], [grnLine(), grnLine({ skuId: "rogue" })], null);
  assert.equal(r.rows.length, 0);
}

console.log("✓ all grn-variance assertions passed");
