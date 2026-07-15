"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ChevronLeft, ChevronRight, Loader2, SendHorizonal, RotateCcw, Pencil,
  CheckCircle2, XCircle, AlertTriangle, FastForward,
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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

/** Per-PO send outcome (from allocate-bulk, reconciled against server truth). */
interface SendResult {
  poId: string;
  ok: boolean;
  mismatchWithheld?: boolean;
  emailFailed?: boolean;
  /** Email was not re-sent because the PO was already SENT (idempotency guard). */
  alreadySent?: boolean;
  emailRef?: string | null;
  /** Who sent it (logged-in Moxie user), from server truth. */
  emailSentBy?: string | null;
  error?: string;
}

/** Server-authoritative send state for a PO (GET /api/pos/send-status). */
interface PoSendStatus {
  poId: string;
  channelPoNumber: string | null;
  emailStatus: string;
  emailRef: string | null;
  emailSentAt: string | null;
  emailSentBy: string | null;
  emailHoldReason: string | null;
}

interface Preview {
  poNumber: string;
  channel: string;
  location: string;
  dispatchFrom: string;
  refPreview: string;
  to: string[];
  cc: string[];
  testMode: boolean;
  lineCount: number;
  html: string;
}

// Batching: send in chunks with a pause between them so Gmail isn't hit in one burst.
// The pause is skippable from the UI. Single batch (≤ BATCH_SIZE) sends with no wait.
const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 120_000; // 2 minutes between batches

const isFailed = (r: SendResult) => !r.ok || r.emailFailed;
// An already-SENT PO is neither a fresh send nor a failure — the guard skipped it.
const isSent = (r: SendResult) => r.ok && !r.emailFailed && !r.mismatchWithheld && !r.alreadySent;
const isAlreadySent = (r: SendResult) => r.ok && r.alreadySent === true;

/**
 * Review the dispatch email for each selected PO one at a time (Prev/Next), edit
 * the subject and body inline if needed, then "Send all". The default path
 * full-allocates + emails the batch via /api/pos/allocate-bulk in chunks of
 * BATCH_SIZE with a skippable pause between them, then shows a per-PO result
 * screen where any failed sends can be retried.
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
   * Custom send (single-PO allocator). Receives the operator-edited bodies/subjects
   * (only POs actually edited) and performs the allocate+email, returning a summary.
   * When omitted, the modal calls POST /api/pos/allocate-bulk itself (with batching).
   */
  onSend?: (payload: { bodies: Record<string, string>; subjects: Record<string, string> }) => Promise<SendSummary>;
}) {
  const [idx, setIdx] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  // cache previews by poId so Prev/Next is instant after first view
  const [cache, setCache] = useState<Record<string, Preview>>({});
  // operator body edits keyed by poId — held in a ref so typing never triggers re-render
  const edits = useRef<Record<string, string>>({});
  // operator subject edits keyed by poId (controlled input → state)
  const [subjects, setSubjects] = useState<Record<string, string>>({});
  // poIds the operator has edited (drives the "edited" badge / reset button)
  const [editedIds, setEditedIds] = useState<Set<string>>(new Set());
  const bodyRef = useRef<HTMLDivElement>(null);

  // Send progress + result phase
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [waitSecs, setWaitSecs] = useState<number | null>(null); // countdown between batches
  const skipWaitRef = useRef<(() => void) | null>(null);
  const [results, setResults] = useState<SendResult[] | null>(null);
  const [resending, setResending] = useState<Set<string>>(new Set());

  const current = pos[idx];
  const total = pos.length;
  const isEdited = current ? editedIds.has(current.id) : false;

  useEffect(() => {
    if (open) {
      setIdx(0);
      edits.current = {};
      setEditedIds(new Set());
      setSubjects({});
      setResults(null);
      setProgress(null);
      setWaitSecs(null);
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
        // Seed the editable subject from the PO's reference number the first time.
        setSubjects((s) => (s[current.id] !== undefined ? s : { ...s, [current.id]: json.data.refPreview ?? "" }));
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
    if (preview) setSubjects((s) => ({ ...s, [current.id]: preview.refPreview }));
  }

  function go(nextIdx: number) {
    captureEdit(); // flush current body before navigating away
    setIdx(nextIdx);
  }

  /** Collect operator edits: bodies that changed, and non-empty subjects. */
  function collectEdits() {
    captureEdit();
    const bodies: Record<string, string> = {};
    for (const [poId, html] of Object.entries(edits.current)) {
      if (html && html !== cache[poId]?.html) bodies[poId] = html;
    }
    // Only send a subject override when the operator actually changed it from the
    // default (the PO's reference). Otherwise omit it so the server stamps each PO's
    // OWN issued reference (distinct per PO in a bulk run) rather than the projected one.
    const subjectsOut: Record<string, string> = {};
    for (const [poId, subj] of Object.entries(subjects)) {
      const seeded = cache[poId]?.refPreview ?? "";
      const v = (subj ?? "").trim();
      if (v && v !== seeded) subjectsOut[poId] = v;
    }
    return { bodies, subjects: subjectsOut };
  }

  /** Skippable pause between batches. */
  function waitBetweenBatches(): Promise<void> {
    return new Promise((resolve) => {
      let remaining = Math.ceil(BATCH_DELAY_MS / 1000);
      setWaitSecs(remaining);
      const interval = setInterval(() => {
        remaining -= 1;
        setWaitSecs(remaining);
        if (remaining <= 0) finish();
      }, 1000);
      const finish = () => {
        clearInterval(interval);
        skipWaitRef.current = null;
        setWaitSecs(null);
        resolve();
      };
      skipWaitRef.current = finish;
    });
  }

  async function postBatch(batch: BulkPo[], edited: { bodies: Record<string, string>; subjects: Record<string, string> }): Promise<SendResult[]> {
    const res = await fetch("/api/pos/allocate-bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        poIds: batch.map((p) => p.id),
        acknowledge: true,
        ...(removals && Object.keys(removals).length > 0 ? { removals } : {}),
        ...(Object.keys(edited.bodies).length > 0 ? { bodies: edited.bodies } : {}),
        ...(Object.keys(edited.subjects).length > 0 ? { subjects: edited.subjects } : {}),
      }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || "Send failed");
    return json.data.results as SendResult[];
  }

  /**
   * Reconcile what actually went out from SERVER TRUTH, not the browser's tally. After a
   * run we ask the DB for each PO's real emailStatus — so a batch whose HTTP response was
   * lost (timeout / 500) can't make us think a delivered PO still needs sending (the bug
   * that caused the duplicate sends). Falls back to the client results if the status
   * lookup itself fails, marking anything unknown as "verify" rather than silently sent.
   */
  async function reconcileFromServer(poIds: string[], clientResults: SendResult[]): Promise<SendResult[]> {
    const clientById = new Map(clientResults.map((r) => [r.poId, r]));
    try {
      const res = await fetch(`/api/pos/send-status?ids=${encodeURIComponent(poIds.join(","))}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "status lookup failed");
      const byId = new Map((json.data.statuses as PoSendStatus[]).map((s) => [s.poId, s]));
      return poIds.map((id) => {
        const s = byId.get(id);
        const c = clientById.get(id);
        if (!s) return c ?? { poId: id, ok: false, error: "status unknown — verify before resending" };
        if (s.emailStatus === "SENT") {
          return { poId: id, ok: true, emailRef: s.emailRef, emailSentBy: s.emailSentBy, alreadySent: c?.alreadySent === true };
        }
        const reason =
          s.emailHoldReason ??
          (s.emailStatus === "HELD" ? "Email reached no one — open the PO to add recipients"
            : s.emailStatus === "FAILED" ? "Send failed"
            : "Not sent");
        return { poId: id, ok: true, emailFailed: true, emailRef: s.emailRef, error: reason };
      });
    } catch (e) {
      console.error("[bulk-send] server reconcile failed, using client results:", e);
      return poIds.map((id) => clientById.get(id) ?? { poId: id, ok: false, error: "status unknown — verify before resending" });
    }
  }

  async function sendAll() {
    const edited = collectEdits();
    setSending(true);

    // Single-PO allocator path delegates the actual send to the parent.
    if (onSend) {
      const t = toast.loading("Sending…");
      try {
        const summary = await onSend(edited);
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
      return;
    }

    // Default path: batched allocate-bulk. NEVER abort mid-run — a failed batch (timeout
    // /500) must not strand the batches after it, and must not hide what already went out.
    // We process every PO, then reconcile against server truth to see what really sent.
    const batches: BulkPo[][] = [];
    for (let i = 0; i < pos.length; i += BATCH_SIZE) batches.push(pos.slice(i, i + BATCH_SIZE));
    const all: SendResult[] = [];
    setProgress({ done: 0, total: pos.length });
    try {
      for (const [b, batch] of batches.entries()) {
        if (b > 0) await waitBetweenBatches(); // skippable pause between batches
        try {
          const batchResults = await postBatch(batch, edited);
          all.push(...batchResults);
        } catch (e) {
          // A batch request failed as a whole — record placeholders and keep going. The
          // server may still have sent some/all of them; reconcile decides from the DB.
          console.error("[bulk-send] batch request failed, continuing:", e);
          for (const p of batch) all.push({ poId: p.id, ok: false, error: e instanceof Error ? e.message : "batch request failed" });
        }
        setProgress({ done: all.length, total: pos.length });
      }

      // Server-authoritative truth: the DB knows which POs actually went out.
      const reconciled = await reconcileFromServer(pos.map((p) => p.id), all);
      setResults(reconciled);

      const sent = reconciled.filter(isSent).length;
      const skipped = reconciled.filter(isAlreadySent).length;
      const notSent = reconciled.filter(isFailed).length;
      if (notSent === 0) {
        toast.success(`Sent ${sent}/${total}` + (skipped ? ` · ${skipped} already sent` : ""));
        onSent();
        onClose();
      } else {
        // Keep the modal open on the result screen so ONLY the not-sent POs can be sent.
        // Don't call onSent() here — parents treat it as "close" (it unmounts the modal),
        // which would destroy this result screen. The list refreshes when they click Done.
        toast.warning(`${sent} sent · ${notSent} not sent — review below and send only those`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSending(false);
      setProgress(null);
      setWaitSecs(null);
    }
  }

  async function resendOne(poId: string, force = false) {
    setResending((s) => new Set(s).add(poId));
    try {
      const res = await fetch(`/api/pos/${poId}/resend-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(edits.current[poId] ? { bodyHtml: edits.current[poId] } : {}),
          ...(subjects[poId]?.trim() ? { subject: subjects[poId].trim() } : {}),
          ...(force ? { force: true } : {}),
        }),
      });
      const json = await res.json();
      // 409 = already sent. Confirm with the operator, then retry with force so an
      // accidental duplicate never goes out silently.
      if (res.status === 409 && !force) {
        if (typeof window !== "undefined" && window.confirm(`${json.error}\n\nSend this PO again anyway?`)) {
          return resendOne(poId, true);
        }
        return;
      }
      if (!json.success) throw new Error(json.error || "Resend failed");
      setResults((rs) => rs?.map((r) => (r.poId === poId ? { ...r, ok: true, emailFailed: false, alreadySent: false, emailRef: json.data.emailRef } : r)) ?? null);
      toast.success("Resent");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Resend failed");
    } finally {
      setResending((s) => {
        const n = new Set(s);
        n.delete(poId);
        return n;
      });
    }
  }

  async function sendAllNotSent() {
    // Only the POs the DB says are NOT sent. Already-sent POs are never in this list, so
    // this can't duplicate — and each resend still hits the server-side idempotency guard.
    const notSent = (results ?? []).filter(isFailed).map((r) => r.poId);
    for (const poId of notSent) await resendOne(poId);
  }

  const poNumberOf = (poId: string) => pos.find((p) => p.id === poId)?.poNumber ?? poId;

  // ── Result phase ──────────────────────────────────────────────────────────
  if (results) {
    const notSent = results.filter(isFailed);
    const sent = results.filter(isSent).length;
    const withheld = results.filter((r) => r.mismatchWithheld).length;
    const skipped = results.filter(isAlreadySent).length;
    const sentBy = results.find((r) => r.emailSentBy)?.emailSentBy ?? null;
    return (
      <Dialog open={open} onOpenChange={(o) => { if (!o) { onSent(); onClose(); } }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Send results — {results.length} PO{results.length > 1 ? "s" : ""}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-wrap gap-3 text-sm">
            <span className="inline-flex items-center gap-1.5 text-emerald-600"><CheckCircle2 className="h-4 w-4" /> {sent} sent</span>
            {skipped > 0 && <span className="inline-flex items-center gap-1.5 text-sky-600" title="Already emailed earlier — not re-sent to avoid duplicates"><CheckCircle2 className="h-4 w-4" /> {skipped} already sent</span>}
            {withheld > 0 && <span className="inline-flex items-center gap-1.5 text-amber-600"><AlertTriangle className="h-4 w-4" /> {withheld} held (price mismatch)</span>}
            {notSent.length > 0 && <span className="inline-flex items-center gap-1.5 text-rose-600"><XCircle className="h-4 w-4" /> {notSent.length} not sent</span>}
          </div>
          {sentBy && <p className="text-xs text-muted-foreground">Sent by {sentBy}</p>}

          {notSent.length > 0 && (
            <>
              <p className="text-sm text-muted-foreground">
                These POs did <span className="font-medium text-foreground">not</span> go out. Only these will be sent — the ones already delivered above are left untouched.
              </p>
              <div className="max-h-[40vh] space-y-2 overflow-auto rounded-lg border border-border/70 p-3">
                {notSent.map((r) => (
                  <div key={r.poId} className="flex items-center justify-between gap-3 text-sm">
                    <div className="min-w-0">
                      <span className="font-medium">{poNumberOf(r.poId)}</span>
                      <span className="ml-2 truncate text-xs text-muted-foreground">{r.error ?? "not sent"}</span>
                    </div>
                    <Button size="sm" variant="outline" disabled={resending.has(r.poId)} onClick={() => resendOne(r.poId)} className="gap-1.5">
                      {resending.has(r.poId) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                      Send
                    </Button>
                  </div>
                ))}
              </div>
            </>
          )}

          <DialogFooter className="flex items-center justify-between gap-2 sm:justify-between">
            {notSent.length > 0 ? (
              <Button variant="outline" onClick={sendAllNotSent} disabled={resending.size > 0} className="gap-2">
                <RotateCcw className="h-4 w-4" /> Send all not-sent ({notSent.length})
              </Button>
            ) : <span />}
            <Button onClick={() => { onSent(); onClose(); }}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // ── Preview / send phase ───────────────────────────────────────────────────
  const subjectVal = current ? (subjects[current.id] ?? preview?.refPreview ?? "") : "";
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !sending && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-3">
            <span>Review &amp; send — {total} PO{total > 1 ? "s" : ""}</span>
            <span className="text-sm font-normal text-muted-foreground">{idx + 1} of {total}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="min-h-[360px] max-h-[60vh] overflow-auto rounded-lg border border-border/70 bg-white p-4">
          {loading || !preview ? (
            <div className="flex h-[320px] items-center justify-center text-muted-foreground">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Building preview for {current?.poNumber}…
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              {/* Editable subject */}
              <div className="space-y-1">
                <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Subject (defaults to the reference number — editable)
                </label>
                <Input
                  value={subjectVal}
                  onChange={(e) => current && setSubjects((s) => ({ ...s, [current.id]: e.target.value }))}
                  placeholder="Email subject"
                  className="bg-white"
                />
              </div>

              <div className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-md bg-muted/40 p-3 text-xs">
                <div><span className="text-muted-foreground">PO:</span> <span className="font-medium">{preview.poNumber}</span></div>
                <div><span className="text-muted-foreground">Reference (on send):</span> <span className="font-mono">{preview.refPreview}</span></div>
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
              <div className="text-[11px] text-muted-foreground">
                Attachments: the channel PO PDF + Excel are fetched and attached at send time. The subject defaults to the reference number ({preview.refPreview}), which is also recorded on the PO. Edit the subject above to override it.
              </div>

              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Pencil className="h-3 w-3" /> Click in the email below to edit it — changes apply to this PO only.
                  {isEdited && <span className="ml-1 rounded-full bg-lime-100 px-2 py-0.5 font-medium text-lime-800">edited</span>}
                </span>
                {isEdited && (
                  <button type="button" onClick={resetCurrent} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
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

        {/* Sending progress / batch countdown */}
        {sending && progress && (
          <div className="rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-sm">
            {waitSecs != null ? (
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">
                  Pausing between batches — next batch in {waitSecs}s. ({progress.done}/{progress.total} done)
                </span>
                <Button size="sm" variant="outline" className="h-7 gap-1.5" onClick={() => skipWaitRef.current?.()}>
                  <FastForward className="h-3.5 w-3.5" /> Send now
                </Button>
              </div>
            ) : (
              <span className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Sending… {progress.done}/{progress.total}
              </span>
            )}
          </div>
        )}

        <DialogFooter className="flex items-center justify-between gap-2 sm:justify-between">
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={idx === 0 || sending} onClick={() => go(Math.max(0, idx - 1))}>
              <ChevronLeft className="h-4 w-4" /> Prev
            </Button>
            <Button variant="outline" size="sm" disabled={idx >= total - 1 || sending} onClick={() => go(Math.min(total - 1, idx + 1))}>
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
