"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Loader2, SendHorizonal, RotateCcw, Pencil } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface BulkPo {
  id: string;
  poNumber: string;
  /**
   * Pending allocation to preview, BEFORE it's persisted. When present the modal
   * previews via POST so removed SKUs / custom quantities are reflected:
   *  • `allocations`   — explicit per-SKU approved qty (single-PO allocator).
   *  • `excludeSkuIds` — SKUs removed during bulk review.
   * Omit to preview the PO's stored quantities (GET — channel bulk-send).
   */
  previewPayload?: { allocations?: { skuId: string; approvedQty: number }[]; excludeSkuIds?: string[] };
}

export interface SendSummary {
  sent: number;
  withheld: number;
  failed: number;
}

interface Preview {
  poNumber: string;
  channel: string;
  location: string;
  dispatchFrom: string;
  subjectPreview: string;
  to: string[];
  cc: string[];
  testMode: boolean;
  lineCount: number;
  html: string;
}

/**
 * Review the dispatch email for each selected PO one at a time (Prev/Next), edit
 * the body inline if needed, then "Send all" — full-allocates + emails the whole
 * batch via /api/pos/allocate-bulk. Edited bodies are sent verbatim per PO.
 */
export function BulkSendModal({
  pos,
  open,
  onClose,
  onSent,
  removals,
  onSend,
}: {
  pos: BulkPo[];
  open: boolean;
  onClose: () => void;
  onSent: () => void;
  /** Per-PO SKU removals forwarded to the default allocate-bulk send. */
  removals?: Record<string, string[]>;
  /**
   * Custom send. Receives the operator-edited bodies (only POs actually edited) and
   * performs the allocate+email, returning a summary. When omitted, the modal calls
   * POST /api/pos/allocate-bulk (full-allocate + removals + bodies) itself.
   */
  onSend?: (bodies: Record<string, string>) => Promise<SendSummary>;
}) {
  const [idx, setIdx] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  // cache previews by poId so Prev/Next is instant after first view
  const [cache, setCache] = useState<Record<string, Preview>>({});
  // operator edits keyed by poId — held in a ref so typing never triggers re-render
  const edits = useRef<Record<string, string>>({});
  // poIds the operator has edited (drives the "edited" badge / reset button)
  const [editedIds, setEditedIds] = useState<Set<string>>(new Set());
  const bodyRef = useRef<HTMLDivElement>(null);

  const current = pos[idx];
  const total = pos.length;
  const isEdited = current ? editedIds.has(current.id) : false;

  useEffect(() => {
    if (open) {
      setIdx(0);
      edits.current = {};
      setEditedIds(new Set());
    }
  }, [open]);

  useEffect(() => {
    if (!open || !current) return;
    const cached = cache[current.id];
    if (cached) {
      setPreview(cached);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setPreview(null);
    const url = `/api/pos/${current.id}/email-preview`;
    // POST (with the pending allocation) when one is supplied, so the preview matches
    // what will be sent; otherwise GET the stored-quantity preview.
    const req = current.previewPayload
      ? fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(current.previewPayload),
        })
      : fetch(url);
    req
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (!json.success) throw new Error(json.error || "Preview failed");
        setCache((c) => ({ ...c, [current.id]: json.data }));
        setPreview(json.data);
      })
      .catch((e) => {
        if (!cancelled) toast.error(e instanceof Error ? e.message : "Preview failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, current?.id]);

  // Fill the editable body imperatively (edited version if present, else original)
  // so React never re-applies content on re-render and clobbers the cursor.
  useEffect(() => {
    if (!preview || !bodyRef.current || !current) return;
    bodyRef.current.innerHTML = edits.current[current.id] ?? preview.html;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, current?.id]);

  function captureEdit() {
    if (!bodyRef.current || !current) return;
    edits.current[current.id] = bodyRef.current.innerHTML;
    if (!editedIds.has(current.id)) {
      setEditedIds((s) => new Set(s).add(current.id));
    }
  }

  function resetCurrent() {
    if (!current) return;
    const original = cache[current.id]?.html ?? preview?.html ?? "";
    if (bodyRef.current) bodyRef.current.innerHTML = original;
    delete edits.current[current.id];
    setEditedIds((s) => {
      const n = new Set(s);
      n.delete(current.id);
      return n;
    });
  }

  function go(nextIdx: number) {
    captureEdit(); // flush current body before navigating away
    setIdx(nextIdx);
  }

  async function sendAll() {
    captureEdit();
    // Only send a body override where the operator actually changed it.
    const bodies: Record<string, string> = {};
    for (const [poId, html] of Object.entries(edits.current)) {
      if (html && html !== cache[poId]?.html) bodies[poId] = html;
    }

    setSending(true);
    const t = toast.loading(`Sending ${total} PO${total > 1 ? "s" : ""}…`);
    try {
      let summary: SendSummary;
      if (onSend) {
        summary = await onSend(bodies);
      } else {
        const res = await fetch("/api/pos/allocate-bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            poIds: pos.map((p) => p.id),
            acknowledge: true,
            ...(removals && Object.keys(removals).length > 0 ? { removals } : {}),
            ...(Object.keys(bodies).length > 0 ? { bodies } : {}),
          }),
        });
        const json = await res.json();
        if (!json.success) throw new Error(json.error || "Send failed");
        const results = json.data.results as { ok: boolean; mismatchWithheld?: boolean }[];
        summary = {
          sent: results.filter((r) => r.ok && !r.mismatchWithheld).length,
          withheld: results.filter((r) => r.mismatchWithheld).length,
          failed: results.filter((r) => !r.ok).length,
        };
      }
      toast.success(
        `Allocated & sent ${summary.sent}/${total}` +
          (summary.withheld ? ` · ${summary.withheld} held (price mismatch)` : "") +
          (summary.failed ? ` · ${summary.failed} failed` : ""),
        { id: t },
      );
      onSent();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Send failed", { id: t });
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !sending && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-3">
            <span>Review &amp; send — {total} PO{total > 1 ? "s" : ""}</span>
            <span className="text-sm font-normal text-muted-foreground">
              {idx + 1} of {total}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="min-h-[360px] max-h-[60vh] overflow-auto rounded-lg border border-border/70 bg-white p-4">
          {loading || !preview ? (
            <div className="flex h-[320px] items-center justify-center text-muted-foreground">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Building preview for {current?.poNumber}…
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-md bg-muted/40 p-3 text-xs">
                <div><span className="text-muted-foreground">PO:</span> <span className="font-medium">{preview.poNumber}</span></div>
                <div><span className="text-muted-foreground">Subject:</span> <span className="font-mono">{preview.subjectPreview}</span></div>
                <div className="col-span-2"><span className="text-muted-foreground">To:</span> {preview.to.join(", ") || "—"}</div>
                {preview.cc.length > 0 && <div className="col-span-2"><span className="text-muted-foreground">Cc:</span> {preview.cc.join(", ")}</div>}
                <div><span className="text-muted-foreground">Dispatch From:</span> {preview.dispatchFrom}</div>
                <div><span className="text-muted-foreground">Location/WH:</span> {preview.location}</div>
              </div>
              {preview.testMode && (
                <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  🧪 Test mode is ON — this will go only to the test address, not the recipients above.
                </div>
              )}
              <div className="text-[11px] text-muted-foreground">Attachments: the channel PO PDF + Excel are fetched and attached at send time.</div>

              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Pencil className="h-3 w-3" /> Click in the email below to edit it — changes apply to this PO only.
                  {isEdited && <span className="ml-1 rounded-full bg-lime-100 px-2 py-0.5 font-medium text-lime-800">edited</span>}
                </span>
                {isEdited && (
                  <button
                    type="button"
                    onClick={resetCurrent}
                    className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    <RotateCcw className="h-3 w-3" /> Reset
                  </button>
                )}
              </div>
              <div
                ref={bodyRef}
                contentEditable
                suppressContentEditableWarning
                onInput={captureEdit}
                className="min-h-[160px] rounded-md border border-border/60 p-3 outline-none focus:border-lime-400 focus:ring-2 focus:ring-lime-200 [&_table]:my-2 [&_td]:px-2 [&_td]:py-1 [&_th]:px-2 [&_th]:py-1"
              />
            </div>
          )}
        </div>

        <DialogFooter className="flex items-center justify-between gap-2 sm:justify-between">
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={idx === 0} onClick={() => go(Math.max(0, idx - 1))}>
              <ChevronLeft className="h-4 w-4" /> Prev
            </Button>
            <Button variant="outline" size="sm" disabled={idx >= total - 1} onClick={() => go(Math.min(total - 1, idx + 1))}>
              Next <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          <Button onClick={sendAll} disabled={sending} className="gap-2">
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <SendHorizonal className="h-4 w-4" />}
            Send all ({total})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
