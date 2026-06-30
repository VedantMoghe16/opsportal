"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Wand2, Mail, Trash2, Undo2, Warehouse, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { cn, formatNumber } from "@/lib/utils";
import { SkuMappingReview } from "@/components/allocation/sku-mapping-review";
import { BulkSendModal, type SendSummary } from "@/components/channels/bulk-send-modal";

export interface WarehouseStockEntry {
  warehouseCode: string;
  warehouseName: string;
  /** Free available saleable units (WMS free minus allocations since last sync) */
  freeQty: number;
  /** Total saleable on hand in WMS */
  totalQty: number;
  syncedAt: string;
}
/** skuId → per-warehouse entries */
export type WarehouseStockBySku = Record<string, WarehouseStockEntry[]>;

interface Line {
  id: string;
  skuId: string;
  channelSkuCode: string | null;
  requestedQty: number;
  approvedQty: number | null;
  rawData: Record<string, string> | null;
  sku: { internalCode: string; name: string; uom: string };
  /** Internal/master SKU code resolved server-side; falls back to the raw
   *  platform code for still-unmapped SKUs (which carry the `unmapped` flag). */
  displaySkuCode?: string;
  flag?: { mismatch: boolean; unmapped: boolean; reason: string } | null;
}

export function PoAllocator({
  poId,
  poNumber,
  lines,
  receivedBySku,
  warehouseStock = {},
  dispatchWarehouseCode = null,
  dispatchWarehouseName = null,
  hasTaxableMismatch = false,
  lockedByOther = false,
  unmappedSkuIds = [],
}: {
  poId: string;
  poNumber: string;
  lines: Line[];
  receivedBySku: Record<string, number>;
  warehouseStock?: WarehouseStockBySku;
  /** Warehouse that ships this PO (resolved from the GSTIN on the PO PDF) */
  dispatchWarehouseCode?: string | null;
  dispatchWarehouseName?: string | null;
  hasTaxableMismatch?: boolean;
  lockedByOther?: boolean;
  /** SKU IDs that have no WMS stock and need AI mapping */
  unmappedSkuIds?: string[];
}) {
  const router = useRouter();
  // Locked = another user holds the claim. Starts from the server's view, and the
  // claim-on-mount below upgrades it to true if someone grabbed it between SSR & mount.
  const [locked, setLocked] = useState(lockedByOther);

  // Claim lifecycle. The atomic server gate (claimPo inside the send txn) is the real
  // guard — this keeps the UX honest:
  //  • Acquire on mount, then HEARTBEAT every 30s while the tab is visible so an active
  //    editor's claim never goes stale (claimedAt keeps refreshing under the TTL).
  //  • A hidden/closed tab stops heartbeating, so an abandoned claim auto-frees within
  //    the (short) TTL — no reliance on a fragile unload request.
  //  • While locked by someone else, the same poll keeps trying to acquire; the instant
  //    their claim goes stale this tab TAKES it over and unlocks itself (no manual reload).
  useEffect(() => {
    let active = true;
    const HEARTBEAT_MS = 30_000;

    // POST /claim = acquire-or-refresh. ok:true → we hold it (unlock); ok:false →
    // someone else holds a fresh claim (lock). claimPo never steals a non-stale claim.
    const sync = async (announceTakeover = false) => {
      try {
        const r = await fetch(`/api/pos/${poId}/claim`, { method: "POST" });
        const j = await r.json();
        if (!active || !j?.success || !j.data) return;
        const held = j.data.ok === true;
        setLocked((wasLocked) => {
          if (held && wasLocked && announceTakeover) {
            toast.success("This PO is now free — you can allocate it.");
          } else if (!held && !wasLocked) {
            toast.warning(`This PO is being allocated by ${j.data.claimedByLabel ?? "another user"}.`);
          }
          return !held;
        });
      } catch {
        /* network blip — keep current state; the next tick retries */
      }
    };

    sync(); // acquire (or discover it's locked) immediately on mount

    const timer = setInterval(() => {
      if (document.visibilityState === "visible") sync(true);
    }, HEARTBEAT_MS);

    // Re-acquire as soon as the user returns to the tab (don't wait for the next tick).
    const onVisibility = () => {
      if (document.visibilityState === "visible") sync(true);
    };
    document.addEventListener("visibilitychange", onVisibility);

    // Best-effort release on tab close / navigation. The short TTL is the real backstop
    // if this never fires (browser crash, network loss, OS sleep).
    const release = () => {
      fetch(`/api/pos/${poId}/claim`, { method: "DELETE", keepalive: true }).catch(() => {});
    };
    window.addEventListener("pagehide", release);

    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", release);
      release();
    };
  }, [poId]);
  const [alloc, setAlloc] = useState<Record<string, number>>(() =>
    Object.fromEntries(lines.map((l) => [l.skuId, l.approvedQty ?? l.requestedQty ?? 0])),
  );
  const [rawInputs, setRawInputs] = useState<Record<string, string>>(() =>
    Object.fromEntries(lines.map((l) => [l.skuId, String(l.approvedQty ?? l.requestedQty ?? 0)])),
  );
  const [syncingStock, setSyncingStock] = useState(false);
  // The editable email preview is the final gate before send — always shown.
  const [previewOpen, setPreviewOpen] = useState(false);

  // Pull fresh WMS stock on demand, then hard-reload so the server re-runs
  // readWarehouseStock with the refreshed mirror (router.refresh alone doesn't
  // fully bust the Next.js 14 route cache for this page's server data).
  async function syncStock() {
    setSyncingStock(true);
    const t = toast.loading("Refreshing WMS stock…");
    try {
      const res = await fetch("/api/wms/sync", { method: "POST" });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Sync failed");
      toast.success(`WMS stock refreshed — ${json.data.rows} rows`, { id: t });
      window.location.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "WMS sync failed", { id: t });
      setSyncingStock(false);
    }
  }
  // SKUs removed from this allocation (e.g. unmapped / not-for-sale) — excluded
  // from the saved allocation and the prep email.
  const [removed, setRemoved] = useState<Set<string>>(new Set());

  const toggleRemove = (skuId: string) =>
    setRemoved((prev) => {
      const next = new Set(prev);
      if (next.has(skuId)) next.delete(skuId);
      else next.add(skuId);
      return next;
    });

  const set = (skuId: string, raw: string) => {
    setRawInputs((p) => ({ ...p, [skuId]: raw }));
    setAlloc((p) => ({ ...p, [skuId]: Math.max(0, Math.floor(Number(raw) || 0)) }));
  };

  const fillOrdered = () => {
    setAlloc(Object.fromEntries(lines.map((l) => [l.skuId, l.requestedQty])));
    setRawInputs(Object.fromEntries(lines.map((l) => [l.skuId, String(l.requestedQty)])));
  };

  // Which warehouse's free stock the table shows. Defaults to the GSTIN-resolved
  // dispatch warehouse (how it's auto-selected) but is clickable to view any other.
  const [selectedWarehouse, setSelectedWarehouse] = useState<string | null>(dispatchWarehouseCode);

  const totalOrdered = lines.reduce((s, l) => s + l.requestedQty, 0);
  const totalAlloc = lines.reduce((s, l) => s + (removed.has(l.skuId) ? 0 : alloc[l.skuId] ?? 0), 0);
  const removedCount = lines.filter((l) => removed.has(l.skuId)).length;

  // Aggregate per-warehouse totals across all PO SKUs (for the summary panel)
  const whTotals = new Map<string, { name: string; totalFree: number }>();
  let stockSyncedAt: string | null = null;
  for (const l of lines) {
    const entries = warehouseStock[l.skuId] ?? [];
    for (const e of entries) {
      const cur = whTotals.get(e.warehouseCode) ?? { name: e.warehouseName, totalFree: 0 };
      cur.totalFree += e.freeQty;
      whTotals.set(e.warehouseCode, cur);
      if (!stockSyncedAt || e.syncedAt > stockSyncedAt) stockSyncedAt = e.syncedAt;
    }
  }
  const hasWarehouseData = whTotals.size > 0;

  /** Free stock for one line at the selected warehouse (null when none selected). */
  const freeAtSelected = (skuId: string): number | null => {
    if (!selectedWarehouse) return null;
    const e = (warehouseStock[skuId] ?? []).find((x) => x.warehouseCode === selectedWarehouse);
    return e ? e.freeQty : 0;
  };

  // Pending per-SKU allocation (removed lines → 0, excluded from preview + email).
  const buildAllocations = () =>
    lines.map((l) => ({
      skuId: l.skuId,
      approvedQty: removed.has(l.skuId) ? 0 : alloc[l.skuId] ?? 0,
    }));

  // Final send, from the preview modal — persists the allocation and emails with the
  // operator-edited subject/body (if any). acknowledge:true because the email was just reviewed.
  async function sendFromPreview({
    bodies,
    subjects,
  }: {
    bodies: Record<string, string>;
    subjects: Record<string, string>;
  }): Promise<SendSummary> {
    const res = await fetch(`/api/pos/${poId}/allocate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        allocations: buildAllocations(),
        acknowledge: true,
        bodyHtml: bodies[poId],
        subject: subjects[poId],
      }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || "Send failed");
    const withheld = json.data?.mismatchWithheld ? 1 : 0;
    return { sent: withheld ? 0 : 1, withheld, failed: 0 };
  }

  return (
    <div className="space-y-4">
      {unmappedSkuIds.length > 0 && (
        <SkuMappingReview
          skuIds={unmappedSkuIds}
          onResolved={() => {
            // router.refresh() doesn't fully bust the Next.js 14 route cache;
            // hard-reload the same URL so the server re-runs readWarehouseStock
            // with the newly confirmed SkuItemMappings in the DB.
            window.location.reload();
          }}
        />
      )}
      {hasWarehouseData && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-4 py-2.5">
          <Warehouse className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground">Free stock:</span>
          {[...whTotals.entries()].map(([code, wh]) => {
            const isSelected = code === selectedWarehouse;
            const isDispatch = code === dispatchWarehouseCode;
            return (
              <button
                type="button"
                key={code}
                onClick={() => setSelectedWarehouse(code)}
                title={`Show free stock at ${wh.name}`}
                aria-pressed={isSelected}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors",
                  isSelected
                    ? "border-emerald-400 bg-emerald-50 ring-1 ring-emerald-400/40 dark:border-emerald-700 dark:bg-emerald-950/40"
                    : "border-border/60 bg-card hover:border-emerald-300 hover:bg-emerald-50/60 dark:hover:bg-emerald-950/20",
                )}
              >
                <span className="font-mono font-semibold">{code}</span>
                <span className="text-muted-foreground">{wh.name !== code ? wh.name : ""}</span>
                <span className="font-semibold nums text-foreground">{formatNumber(wh.totalFree)}</span>
                <span className="text-muted-foreground">units</span>
                {isDispatch && (
                  <Badge variant="outline" className="ml-1 border-emerald-500 px-1.5 py-0 text-[10px] text-emerald-700 dark:text-emerald-300">
                    ships this PO
                  </Badge>
                )}
              </button>
            );
          })}
          <div className="ml-auto flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">
              {dispatchWarehouseName
                ? `Ships from ${dispatchWarehouseName} (PO GSTIN)`
                : "Shipping warehouse unknown — no GSTIN match"}
              {" · click a warehouse to view its stock"}
              {stockSyncedAt ? ` · WMS sync ${new Date(stockSyncedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false })}` : ""}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={syncStock}
              disabled={syncingStock}
              title="Pull the latest free stock from the WMS Consolidated MIS report"
              className="h-7 gap-1.5 px-2 text-xs"
            >
              {syncingStock ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh stock
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={fillOrdered}>
          <Wand2 className="h-4 w-4" /> Fill all to ordered
        </Button>
        <div className="ml-auto text-sm text-muted-foreground">
          Allocating <span className="font-semibold text-foreground nums">{formatNumber(totalAlloc)}</span> of{" "}
          <span className="nums">{formatNumber(totalOrdered)}</span> ordered units
          {removedCount > 0 && (
            <span className="ml-2 text-rose-600 dark:text-rose-400">· {removedCount} removed</span>
          )}
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border/70 bg-card shadow-soft">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Item ID</TableHead>
              <TableHead>Product</TableHead>
              <TableHead>UOM</TableHead>
              <TableHead className="text-right">Ordered</TableHead>
              <TableHead className="text-right">Received</TableHead>
              {hasWarehouseData && (
                <TableHead className="text-right">
                  {selectedWarehouse ? `Free @ ${selectedWarehouse}` : "Free stock"}
                </TableHead>
              )}
              <TableHead className="text-right">Allocate</TableHead>
              <TableHead className="text-right">Remove</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l) => {
              const received = receivedBySku[l.skuId];
              const val = alloc[l.skuId] ?? 0;
              const isRemoved = removed.has(l.skuId);
              const tone =
                val === 0 ? "border-border/60"
                  : val >= l.requestedQty ? "border-success"
                  : "border-warning";
              return (
                <TableRow key={l.id} className={cn(isRemoved && "opacity-50")}>
                  <TableCell className="font-mono text-xs">{l.displaySkuCode ?? l.sku.internalCode}</TableCell>
                  <TableCell className="max-w-[320px]">
                    <div className={cn("truncate text-sm", isRemoved && "line-through")}>{l.sku.name}</div>
                    {l.flag?.unmapped && (
                      <Badge variant="danger" className="mt-0.5 gap-1 text-[10px]">
                        <AlertTriangle className="h-2.5 w-2.5" /> New SKU · not mapped
                      </Badge>
                    )}
                    {l.flag?.mismatch && (
                      <Badge variant="warning" className="mt-0.5 gap-1 text-[10px]" title={l.flag.reason}>
                        <AlertTriangle className="h-2.5 w-2.5" /> Price mismatch
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{l.rawData?.uom_text ?? l.sku.uom}</TableCell>
                  <TableCell className="text-right nums font-medium">{l.requestedQty}</TableCell>
                  <TableCell className="text-right nums">
                    {received != null ? received : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  {hasWarehouseData && (() => {
                    const entries = warehouseStock[l.skuId] ?? [];
                    // Judge availability at the selected warehouse when one is chosen,
                    // otherwise against the total across warehouses.
                    const atSelected = freeAtSelected(l.skuId);
                    const available = atSelected ?? entries.reduce((s, e) => s + e.freeQty, 0);
                    const qty = alloc[l.skuId] ?? 0;
                    const sufficient = available >= qty && qty > 0;
                    const tooltipLines = entries.length > 0
                      ? entries.map((e) => `${e.warehouseCode}: ${formatNumber(e.freeQty)} free`).join(" · ")
                      : "";
                    return (
                      <TableCell className="text-right nums" title={tooltipLines || undefined}>
                        {entries.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <span
                            className={cn(
                              "font-medium",
                              available === 0 && "text-rose-600 dark:text-rose-400",
                              available > 0 && !sufficient && "text-amber-600 dark:text-amber-400",
                              sufficient && "text-emerald-600 dark:text-emerald-400",
                            )}
                          >
                            {formatNumber(available)}
                          </span>
                        )}
                      </TableCell>
                    );
                  })()}
                  <TableCell className="text-right">
                    <input
                      type="number"
                      min={0}
                      disabled={isRemoved || locked}
                      value={isRemoved ? "" : rawInputs[l.skuId] ?? ""}
                      onChange={(e) => set(l.skuId, e.target.value)}
                      onBlur={() =>
                        setRawInputs((p) => ({ ...p, [l.skuId]: String(alloc[l.skuId] ?? 0) }))
                      }
                      className={cn(
                        "h-9 w-24 rounded-lg border bg-card px-2 text-right text-sm nums outline-none focus:ring-2 focus:ring-ring/40 disabled:cursor-not-allowed disabled:bg-muted/40",
                        tone,
                      )}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={locked}
                      className={cn("h-8 gap-1 px-2", isRemoved ? "text-muted-foreground" : "text-rose-600 hover:text-rose-700")}
                      onClick={() => toggleRemove(l.skuId)}
                      title={isRemoved ? "Restore this item" : "Remove this item from the allocation & email"}
                    >
                      {isRemoved ? <><Undo2 className="h-3.5 w-3.5" /> Restore</> : <Trash2 className="h-3.5 w-3.5" />}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => router.push("/allocate")}>Cancel</Button>
        <Button
          onClick={() => setPreviewOpen(true)}
          disabled={totalAlloc === 0 || locked}
          className={hasTaxableMismatch ? "gap-2 bg-amber-600 hover:bg-amber-700 text-white border-0" : "gap-2"}
          title={hasTaxableMismatch ? "Price mismatch flagged — review the email preview before sending" : undefined}
        >
          {hasTaxableMismatch ? <AlertTriangle className="h-4 w-4" /> : <Mail className="h-4 w-4" />}
          {hasTaxableMismatch ? "Review price mismatch & preview email" : "Review & send email"}
        </Button>
      </div>

      {/* Editable email preview — the final gate before the email is sent. Reflects
          the custom quantities above and excludes any removed lines. Mounted only
          while open so each open re-previews the current allocation. */}
      {previewOpen && (
        <BulkSendModal
          open
          pos={[{ id: poId, poNumber, previewPayload: { allocations: buildAllocations() } }]}
          onClose={() => setPreviewOpen(false)}
          onSend={sendFromPreview}
          onSent={() => {
            router.push("/allocate");
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
