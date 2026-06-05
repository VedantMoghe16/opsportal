import "server-only";

/**
 * Concept → header resolution for an arbitrary Blinkit PO-dump schema.
 * We never assume exact column names; we score each header against a priority
 * keyword list per concept so the importer survives Blinkit changing labels.
 */
export type Concept =
  | "poNumber"
  | "poDate"
  | "deliveryDate"
  | "itemCode"
  | "itemName"
  | "quantity"
  | "remaining"
  | "upc"
  | "unitPrice"
  | "lineValue"
  | "uom"
  | "facility"
  | "city"
  | "status"
  | "manufacturer"
  | "category"
  | "brand"
  | "mrp";

// Ordered by preference (earlier = stronger). Matched against a normalized header.
const KEYWORDS: Record<Concept, string[]> = {
  poNumber: ["ponumber", "pono", "purchaseordernumber", "purchaseorderno", "poid", "ponum", "po"],
  poDate: ["podate", "issuedate", "orderdate", "createddate", "createdat", "poissuedate", "date"],
  deliveryDate: ["deliverydate", "expecteddelivery", "appointmentdate", "poexpiry", "expirydate", "validtill", "expecteddate", "delivery"],
  itemCode: ["itemid", "itemcode", "skucode", "sku", "productcode", "productid", "articlecode", "article", "ean", "fsn", "barcode"],
  itemName: ["itemname", "productname", "itemdescription", "productdescription", "description", "product", "itemtitle", "name"],
  quantity: ["unitsordered", "orderedunits", "orderedqty", "orderqty", "poqty", "quantityordered", "orderedquantity", "quantity", "qty", "units"],
  remaining: ["remainingquantity", "remainingqty", "pendingquantity", "pendingqty", "balancequantity", "balanceqty", "remaining", "pending"],
  upc: ["upc", "ean", "barcode", "gtin"],
  unitPrice: ["unitcost", "basiccost", "landingcost", "unitprice", "costprice", "rate", "cost", "price", "buyingprice"],
  lineValue: ["totalcost", "totalvalue", "linevalue", "totalamount", "grossamount", "lineamount", "amount", "gmv", "total"],
  uom: ["unitofmeasure", "uom", "unit"],
  facility: ["facilityname", "facility", "warehouse", "outlet", "store", "fulfilmentcentre", "fulfillmentcenter", "dcname", "dc", "destination"],
  city: ["city", "destinationcity", "deliverycity", "location"],
  status: ["postatus", "status", "state", "orderstatus"],
  manufacturer: ["manufacturername", "manufacturer", "mfgname"],
  category: ["category", "l1category", "l2category", "vertical", "subcategory"],
  brand: ["brand", "brandname", "manufacturer"],
  mrp: ["mrp", "maximumretailprice"],
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export type FieldMap = Partial<Record<Concept, string>>;

export function resolveFields(headers: string[]): FieldMap {
  const normed = headers.map((h) => ({ raw: h, n: norm(h) }));
  const used = new Set<string>();
  const map: FieldMap = {};

  for (const concept of Object.keys(KEYWORDS) as Concept[]) {
    const kws = KEYWORDS[concept];
    let best: { raw: string; score: number } | null = null;
    for (const { raw, n } of normed) {
      if (used.has(raw)) continue;
      // exact match wins outright
      const exactIdx = kws.indexOf(n);
      let score = -1;
      if (exactIdx !== -1) {
        score = 1000 - exactIdx;
      } else {
        for (let i = 0; i < kws.length; i++) {
          const kw = kws[i]!;
          // ignore very short keywords as substrings (e.g. "po", "dc") to avoid false hits
          if (kw.length <= 2) continue;
          if (n.includes(kw)) {
            score = 100 - i;
            break;
          }
        }
      }
      if (score > 0 && (!best || score > best.score)) best = { raw, score };
    }
    if (best) {
      map[concept] = best.raw;
      used.add(best.raw);
    }
  }

  // Special-case the short "po" keyword for poNumber if nothing matched yet.
  if (!map.poNumber) {
    const cand = normed.find((h) => !used.has(h.raw) && (h.n === "po" || h.n.startsWith("po") && h.n.includes("num")));
    if (cand) {
      map.poNumber = cand.raw;
      used.add(cand.raw);
    }
  }
  return map;
}

// ── value coercion ────────────────────────────────────────
export function toNumber(v: string | undefined | null): number | null {
  if (v == null) return null;
  const cleaned = String(v).replace(/[₹,\s]/g, "").replace(/[^0-9.\-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function toDate(v: string | undefined | null): Date | null {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  // ISO / native first
  const native = new Date(s);
  if (!Number.isNaN(native.getTime()) && /\d{4}/.test(s)) return native;
  // dd-mm-yyyy or dd/mm/yyyy (+ optional time)
  const m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (m) {
    const [, d, mo, y] = m;
    const year = y!.length === 2 ? 2000 + Number(y) : Number(y);
    const dt = new Date(year, Number(mo) - 1, Number(d));
    if (!Number.isNaN(dt.getTime())) return dt;
  }
  return null;
}
