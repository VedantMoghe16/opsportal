"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, ArrowRight, ClipboardCheck, SendHorizonal, Trash2, Undo2, Lock, Sparkles, Loader2 } from "lucide-react";
import type { PoStatus } from "@prisma/client";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SelectItem } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { ChannelChip } from "@/components/shared/channel-chip";
import { StatusBadge } from "@/components/orders/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { ColumnFilter } from "@/components/shared/column-filter";
import {
  TableToolbar, useTableDensity, densityClass, type FilterChipDef,
} from "@/components/shared/table-toolbar";
import { SearchFilter, SelectFilter, DateRangeFilter, useDebounced, inDateRange } from "@/components/shared/table-filters";
import { BulkSendModal } from "@/components/channels/bulk-send-modal";
import { PO_STATUS_META, PO_STATUS_ORDER } from "@/lib/status";
import { CHANNELS } from "@/lib/channels";
import { cn, formatINR, formatNumber, formatDate } from "@/lib/utils";

export interface AllocRow {
  id: string;
  channelPoNumber: string | null;
  status: PoStatus;
  poDate: Date | string | null;
  totalRequestedValue: number | null;
  channel: { name: string; logoColor: string | null };
  facility: string | null;
  skuCount: number;
  orderedUnits: number;
  allocatedUnits: number;
  hasTaxableMismatch: boolean;
  taxMismatchCount: number;
  hasUnmappedSku: boolean;
  unmappedSkus: { skuId: string; channelSkuCode: string | null; name: string }[];
  priceMismatches: { skuId: string; channelSkuCode: string | null; name: string; expected: number | null; actual: number | null }[];
  lockedByOther: boolean;
  claimedByLabel: string | null;
}

export function AllocationList({ rows }: { rows: AllocRow[] }) {
  const router = useRouter();
  const [density] = useTableDensity("allocation-table-density");
  const [q, setQ] = useState("");
  const [channelSlug, setChannelSlug] = useState("all");
  const [status, setStatus] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingConfirm, setPendingConfirm] = useState<string[] | null>(null);
  // The editable email preview step — opened after review (or directly when nothing
  // is flagged). Carries the per-PO SKU removals decided during review.
  const [preview, setPreview] = useState<{ poIds: string[]; removals: Record<string, string[]> } | null>(null);

  const debouncedQ = useDebounced(q);

  function clearFilters() {
    setQ("");
    setChannelSlug("all");
    setStatus("all");
    setDateFrom("");
    setDateTo("");
  }

  const channelName = CHANNELS.find((c) => c.slug === channelSlug)?.name;
  const chips: FilterChipDef[] = [];
  if (channelSlug !== "all")
    chips.push({ key: "channel", label: channelName ?? channelSlug, onRemove: () => setChannelSlug("all") });
  if (q !== "")
    chips.push({ key: "search", label: `Search: ${q}`, onRemove: () => setQ("") });
  if (status !== "all")
    chips.push({ key: "status", label: PO_STATUS_META[status as PoStatus]?.label ?? status, onRemove: () => setStatus("all") });
  if (dateFrom !== "" || dateTo !== "")
    chips.push({ key: "date", label: `PO date ${dateFrom || "…"}–${dateTo || "…"}`, onRemove: () => { setDateFrom(""); setDateTo(""); } });

  const statusOptions = useMemo(() => {
    const present = new Set(rows.map((r) => r.status));
    return PO_STATUS_ORDER.filter((s) => present.has(s));
  }, [rows]);

  const filtered = useMemo(() => {
    const s = debouncedQ.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (s === "" ||
          (r.channelPoNumber ?? "").toLowerCase().includes(s) ||
          (r.facility ?? "").toLowerCase().includes(s)) &&
        (channelSlug === "all" || r.channel.name === channelName) &&
        (status === "all" || r.status === status) &&
        inDateRange(r.poDate, dateFrom, dateTo),
    );
  }, [rows, debouncedQ, channelSlug, channelName, status, dateFrom, dateTo]);

  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  // Only POs not locked by someone else are selectable for bulk allocation.
  const selectable = useMemo(() => filtered.filter((r) => !r.lockedByOther), [filtered]);
  const allFilteredSelected =
    selectable.length > 0 && selectable.every((r) => selected.has(r.id));
  const someFilteredSelected = selectable.some((r) => selected.has(r.id));

  function toggleAll() {
    if (allFilteredSelected) {
      setSelected((prev) => {
        const next = new Set(prev);
        selectable.forEach((r) => next.delete(r.id));
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        selectable.forEach((r) => next.add(r.id));
        return next;
      });
    }
  }

  function toggleRow(id: string) {
    if (rowById.get(id)?.lockedByOther) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function requestBulkSend() {
    const poIds = Array.from(selected);
    if (poIds.length === 0) return;
    // Open the flag-review step when any selected PO has a price mismatch or an
    // unmapped SKU; otherwise go straight to the editable email preview.
    const flagged = poIds.some((id) => {
      const r = rowById.get(id);
      return r?.hasTaxableMismatch || r?.hasUnmappedSku;
    });
    if (flagged) {
      setPendingConfirm(poIds);
    } else {
      setPreview({ poIds, removals: {} });
    }
  }

  // From the review step → open the editable preview carrying the removals.
  function openPreview(poIds: string[], removals: Record<string, string[]>) {
    setPendingConfirm(null);
    setPreview({ poIds, removals });
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={ClipboardCheck}
        title="Nothing to allocate"
        description="POs awaiting allocation appear here. Sync Blinkit to pull the latest."
      />
    );
  }

  const selectedCount = selected.size;

  return (
    <div>
      <TableToolbar
        chips={chips}
        onClearAll={clearFilters}
        count={filtered.length}
        total={rows.length}
        noun="POs"
      >
        {selectedCount > 0 && (
          <Button onClick={requestBulkSend} className="gap-2 shrink-0">
            <SendHorizonal className="h-4 w-4" />
            Allocate full &amp; send ({selectedCount})
          </Button>
        )}
      </TableToolbar>

      <Table className={densityClass(density)}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-10">
              <Checkbox
                checked={allFilteredSelected}
                data-state={
                  allFilteredSelected
                    ? "checked"
                    : someFilteredSelected
                    ? "indeterminate"
                    : "unchecked"
                }
                onCheckedChange={toggleAll}
                aria-label="Select all filtered"
              />
            </TableHead>
            <TableHead>
              <ColumnFilter label="Channel" active={channelSlug !== "all"} onClear={() => setChannelSlug("all")}>
                <SelectFilter value={channelSlug} onChange={setChannelSlug} allLabel="All channels" width="w-full">
                  {CHANNELS.map((c) => (
                    <SelectItem key={c.slug} value={c.slug}>
                      <ChannelChip name={c.name} color={c.logoColor} />
                    </SelectItem>
                  ))}
                </SelectFilter>
              </ColumnFilter>
            </TableHead>
            <TableHead>
              <ColumnFilter label="PO Number" active={q !== ""} onClear={() => setQ("")}>
                <SearchFilter value={q} onChange={setQ} placeholder="PO number or facility…" className="w-full" />
              </ColumnFilter>
            </TableHead>
            <TableHead>Facility</TableHead>
            <TableHead>
              <ColumnFilter
                label="PO date"
                active={dateFrom !== "" || dateTo !== ""}
                onClear={() => { setDateFrom(""); setDateTo(""); }}
              >
                <DateRangeFilter from={dateFrom} to={dateTo} onFrom={setDateFrom} onTo={setDateTo} />
              </ColumnFilter>
            </TableHead>
            <TableHead className="text-right">SKUs</TableHead>
            <TableHead className="text-right">Ordered</TableHead>
            <TableHead className="text-right">Allocated</TableHead>
            <TableHead>
              <ColumnFilter label="Status" active={status !== "all"} onClear={() => setStatus("all")}>
                <SelectFilter value={status} onChange={setStatus} allLabel="All statuses" width="w-full">
                  {statusOptions.map((s) => (
                    <SelectItem key={s} value={s}>{PO_STATUS_META[s].label}</SelectItem>
                  ))}
                </SelectFilter>
              </ColumnFilter>
            </TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((r) => {
            const prog = r.orderedUnits > 0 ? (r.allocatedUnits / r.orderedUnits) * 100 : 0;
            const isSelected = selected.has(r.id);
            return (
              <TableRow key={r.id} className={cn("group", isSelected && "bg-muted/40", r.lockedByOther && "opacity-60")}>
                <TableCell>
                  <Checkbox
                    checked={isSelected}
                    disabled={r.lockedByOther}
                    onCheckedChange={() => toggleRow(r.id)}
                    aria-label={`Select PO ${r.channelPoNumber ?? r.id}`}
                  />
                </TableCell>
                <TableCell><ChannelChip name={r.channel.name} color={r.channel.logoColor} /></TableCell>
                <TableCell className="font-medium">
                  <div className="flex items-center gap-1.5">
                    {r.channelPoNumber}
                    {r.lockedByOther && (
                      <span
                        className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-semibold bg-slate-200 text-slate-700 dark:bg-slate-700/60 dark:text-slate-200"
                        title={`Being allocated by ${r.claimedByLabel ?? "another user"}`}
                      >
                        <Lock className="h-2.5 w-2.5" />
                        {r.claimedByLabel ?? "Locked"}
                      </span>
                    )}
                    {r.hasTaxableMismatch && (
                      <span
                        className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                        title={`${r.taxMismatchCount} line${r.taxMismatchCount !== 1 ? "s" : ""} have taxable value mismatch vs SKU master`}
                      >
                        <AlertTriangle className="h-2.5 w-2.5" />
                        Price
                      </span>
                    )}
                    {r.hasUnmappedSku && (
                      <span
                        className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-semibold bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300"
                        title={`${r.unmappedSkus.length} unmapped/new SKU${r.unmappedSkus.length !== 1 ? "s" : ""} not in the ${r.channel.name} master`}
                      >
                        <AlertTriangle className="h-2.5 w-2.5" />
                        New SKU
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="max-w-[200px] truncate text-muted-foreground">{r.facility ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">{formatDate(r.poDate)}</TableCell>
                <TableCell className="text-right nums">{r.skuCount}</TableCell>
                <TableCell className="text-right nums">{formatNumber(r.orderedUnits)}</TableCell>
                <TableCell className="text-right">
                  <span className={cn("nums font-medium", r.allocatedUnits > 0 ? "text-success" : "text-muted-foreground")}>
                    {formatNumber(r.allocatedUnits)}
                  </span>
                  {r.allocatedUnits > 0 && (
                    <span className="ml-1 text-[11px] text-muted-foreground">({Math.round(prog)}%)</span>
                  )}
                </TableCell>
                <TableCell><StatusBadge status={r.status} /></TableCell>
                <TableCell className="text-right">
                  {r.lockedByOther ? (
                    <Button size="sm" variant="outline" disabled className="gap-1">
                      <Lock className="h-3.5 w-3.5" /> Locked
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" asChild>
                      <Link href={`/allocate/${r.id}`}>
                        Open <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {/* Floating action bar — always visible when POs are selected */}
      {selectedCount > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-4 rounded-full border border-border/70 bg-card px-5 py-3 shadow-xl">
          <span className="text-sm text-muted-foreground whitespace-nowrap">
            {selectedCount} PO{selectedCount !== 1 ? "s" : ""} selected
          </span>
          <Button onClick={requestBulkSend} className="gap-2 rounded-full">
            <SendHorizonal className="h-4 w-4" />
            Allocate full &amp; send ({selectedCount})
          </Button>
          <button
            onClick={() => setSelected(new Set())}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors whitespace-nowrap"
            aria-label="Clear selection"
          >
            Clear
          </button>
        </div>
      )}

      {/* Review step: accept/remove unmapped SKUs + price-mismatch info, then preview */}
      {pendingConfirm && (
        <ReviewDialog
          poIds={pendingConfirm}
          rowById={rowById}
          onConfirm={(removals) => openPreview(pendingConfirm, removals)}
          onCancel={() => setPendingConfirm(null)}
        />
      )}

      {/* Editable email preview — always shown before the email is sent. Removed SKUs
          (from the review step) are reflected in the preview and excluded on send. */}
      {preview && (
        <BulkSendModal
          open
          pos={preview.poIds.map((id) => ({
            id,
            poNumber: rowById.get(id)?.channelPoNumber ?? id,
            previewPayload: { excludeSkuIds: preview.removals[id] ?? [] },
          }))}
          removals={preview.removals}
          onClose={() => setPreview(null)}
          onSent={() => {
            setPreview(null);
            setSelected(new Set());
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

/**
 * Bulk review step. Lists every flagged PO before sending:
 *  • Unmapped/new SKUs → operator can Accept (keep) or Remove (exclude from
 *    allocation + email).
 *  • Price mismatches → info only (no accept/reject) — surfaced so the operator
 *    is aware before the email goes out.
 * "Mark reviewed" gates the green "Save allocation & send email" button. On send,
 * the removed SKU ids are sent per-PO so those lines are allocated 0 / left out.
 */
function ReviewDialog({
  poIds,
  rowById,
  onConfirm,
  onCancel,
}: {
  poIds: string[];
  rowById: Map<string, AllocRow>;
  onConfirm: (removals: Record<string, string[]>) => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const rows = poIds
    .map((id) => rowById.get(id))
    .filter((r): r is AllocRow => !!r && (r.hasUnmappedSku || r.hasTaxableMismatch));
  // Keyed per-PO (`poId::skuId`) so removing a SKU on one PO never touches the same
  // SKU on another — each handler decides what to drop from each PO independently.
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [reviewed, setReviewed] = useState(false);
  const [autoMapping, setAutoMapping] = useState(false);

  const keyOf = (poId: string, skuId: string) => `${poId}::${skuId}`;

  // Gemini auto-map: match every flagged "new" SKU to an existing internal SKU
  // and persist it into the master, then refresh so the flags clear.
  async function autoMap() {
    const items = rows.flatMap((r) =>
      r.unmappedSkus
        .filter((s) => s.channelSkuCode)
        .map((s) => ({ source: r.channel.name, channelSkuCode: s.channelSkuCode!, name: s.name })),
    );
    if (items.length === 0) {
      toast.info("No new SKU codes to map.");
      return;
    }
    setAutoMapping(true);
    const t = toast.loading(`Asking AI to map ${items.length} new SKU${items.length !== 1 ? "s" : ""}…`);
    try {
      const res = await fetch("/api/sku-mappings/auto-map", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Auto-map failed");
      const applied = json.data.appliedCount as number;
      const total = (json.data.results as unknown[]).length;
      if (applied > 0) {
        toast.success(`Mapped ${applied}/${total} SKU${total !== 1 ? "s" : ""} to the master. Re-checking…`, { id: t });
        onCancel(); // close; the list re-renders with refreshed mappings
        router.refresh();
      } else {
        toast.warning(`AI couldn't confidently map any of the ${total} SKU${total !== 1 ? "s" : ""}. Map them in Settings → SKUs.`, { id: t });
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Auto-map failed", { id: t });
    } finally {
      setAutoMapping(false);
    }
  }

  const toggle = (poId: string, skuId: string) =>
    setRemoved((prev) => {
      const next = new Set(prev);
      const k = keyOf(poId, skuId);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  function send() {
    const removals: Record<string, string[]> = {};
    for (const r of rows) {
      const rem = r.unmappedSkus.filter((s) => removed.has(keyOf(r.id, s.skuId))).map((s) => s.skuId);
      if (rem.length) removals[r.id] = rem;
    }
    onConfirm(removals);
  }

  const unmappedTotal = rows.reduce((s, r) => s + r.unmappedSkus.length, 0);
  const priceTotal = rows.reduce((s, r) => s + r.priceMismatches.length, 0);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-card shadow-2xl">
        <div className="border-b border-border px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <ClipboardCheck className="h-5 w-5 text-foreground" />
              <h2 className="text-base font-semibold">Review before sending · {rows.length} PO{rows.length !== 1 ? "s" : ""} flagged</h2>
            </div>
            {unmappedTotal > 0 && (
              <Button size="sm" variant="outline" className="shrink-0 gap-1.5" onClick={autoMap} disabled={autoMapping}>
                {autoMapping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                Auto-map with AI
              </Button>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {unmappedTotal > 0 && <>Accept or remove {unmappedTotal} unmapped SKU{unmappedTotal !== 1 ? "s" : ""}, or let AI map them to existing SKUs. </>}
            {priceTotal > 0 && <>{priceTotal} price mismatch{priceTotal !== 1 ? "es" : ""} shown for info. </>}
            Mark as reviewed to enable sending.
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-4">
          {rows.map((r) => (
            <div key={r.id} className="rounded-lg border border-border/70">
              <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
                <div className="flex items-center gap-2">
                  <ChannelChip name={r.channel.name} color={r.channel.logoColor} />
                  <span className="font-medium">{r.channelPoNumber ?? r.id}</span>
                </div>
                <span className="text-xs text-muted-foreground">{r.skuCount} SKUs</span>
              </div>

              {/* Unmapped SKUs — accept / remove (per-PO) */}
              {r.unmappedSkus.map((s) => {
                const isRemoved = removed.has(keyOf(r.id, s.skuId));
                return (
                  <div key={s.skuId} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <div className={cn("min-w-0", isRemoved && "opacity-50 line-through")}>
                      <span className="font-mono text-xs text-rose-600 dark:text-rose-400">{s.channelSkuCode ?? s.skuId}</span>
                      <span className="ml-2 truncate text-muted-foreground">{s.name}</span>
                      <Badge variant="danger" className="ml-2 text-[10px]">New SKU</Badge>
                    </div>
                    <button
                      onClick={() => toggle(r.id, s.skuId)}
                      className={cn(
                        "shrink-0 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors",
                        isRemoved
                          ? "border-border text-muted-foreground hover:text-foreground"
                          : "border-rose-300 text-rose-600 hover:bg-rose-50 dark:border-rose-800 dark:hover:bg-rose-950/30",
                      )}
                    >
                      {isRemoved ? <><Undo2 className="h-3 w-3" /> Restore</> : <><Trash2 className="h-3 w-3" /> Remove</>}
                    </button>
                  </div>
                );
              })}

              {/* Price mismatches — info only */}
              {r.priceMismatches.map((s) => (
                <div key={`p-${s.skuId}`} className="flex items-center justify-between gap-3 bg-amber-50/50 px-3 py-2 text-sm dark:bg-amber-950/10">
                  <div className="min-w-0">
                    <span className="font-mono text-xs">{s.channelSkuCode ?? s.skuId}</span>
                    <span className="ml-2 truncate text-muted-foreground">{s.name}</span>
                  </div>
                  <span className="shrink-0 inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="h-3 w-3" />
                    ₹{s.actual?.toFixed(2) ?? "?"} vs exp ₹{s.expected?.toFixed(2) ?? "?"}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-4">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={reviewed} onCheckedChange={(v) => setReviewed(v === true)} aria-label="Mark reviewed" />
            I&apos;ve reviewed the flagged items
          </label>
          <div className="flex gap-3">
            <Button variant="outline" onClick={onCancel}>Cancel</Button>
            <Button
              onClick={send}
              disabled={!reviewed}
              className={reviewed ? "gap-2 bg-success text-white hover:bg-success/90 border-0" : "gap-2"}
            >
              <SendHorizonal className="h-4 w-4" />
              Save allocation &amp; send email ({poIds.length})
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
