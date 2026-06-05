"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Papa from "papaparse";
import { toast } from "sonner";
import { UploadCloud, FileSpreadsheet, Loader2, CheckCircle2, X } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

interface Row {
  po_number: string;
  sku_code: string;
  received_qty: string;
  rejected_qty: string;
  rejection_reason: string;
}
const REQUIRED = ["po_number", "sku_code", "received_qty"] as const;

function validate(row: Row): string[] {
  const errs: string[] = [];
  if (!row.po_number?.trim()) errs.push("po_number");
  if (!row.sku_code?.trim()) errs.push("sku_code");
  if (row.received_qty === "" || isNaN(Number(row.received_qty)) || Number(row.received_qty) < 0)
    errs.push("received_qty");
  if (row.rejected_qty && (isNaN(Number(row.rejected_qty)) || Number(row.rejected_qty) < 0))
    errs.push("rejected_qty");
  return errs;
}

export function CsvUpload() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [fileName, setFileName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [drag, setDrag] = useState(false);

  function handleFile(file: File) {
    setFileName(file.name);
    Papa.parse<Row>(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, "_"),
      complete: (res) => {
        setRows(res.data.filter((r) => r.po_number || r.sku_code));
        toast.info(`Parsed ${res.data.length} rows`);
      },
      error: () => toast.error("Failed to parse CSV"),
    });
  }

  const errorsByRow = rows.map(validate);
  const hasErrors = errorsByRow.some((e) => e.length > 0);

  async function confirm() {
    setSubmitting(true);
    try {
      const payload = {
        rows: rows.map((r) => ({
          po_number: r.po_number.trim(),
          sku_code: r.sku_code.trim(),
          received_qty: Number(r.received_qty),
          rejected_qty: Number(r.rejected_qty || 0),
          rejection_reason: r.rejection_reason?.trim() || null,
        })),
      };
      const res = await fetch("/api/grn/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      const flagged = json.data.created.filter((c: { hasDiscrepancy: boolean }) => c.hasDiscrepancy).length;
      toast.success(
        `${json.data.created.length} GRN(s) created` +
          (flagged ? ` · ${flagged} flagged for reconciliation` : ""),
      );
      router.push("/grn");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="p-6">
          <label
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              const f = e.dataTransfer.files[0];
              if (f) handleFile(f);
            }}
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-16 text-center transition-colors",
              drag ? "border-primary bg-lime-soft/50" : "border-border hover:border-foreground/30",
            )}
          >
            <div className="grid h-14 w-14 place-items-center rounded-2xl bg-lime-soft text-[hsl(72_60%_28%)]">
              <UploadCloud className="h-7 w-7" />
            </div>
            <h3 className="mt-4 text-base font-semibold">Drop your GRN CSV here</h3>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Columns: <code className="text-xs">po_number, sku_code, received_qty, rejected_qty, rejection_reason</code>
            </p>
            <span className="mt-4 inline-flex items-center gap-2 rounded-full bg-foreground px-4 py-2 text-sm font-medium text-canvas">
              <FileSpreadsheet className="h-4 w-4" /> Choose file
            </span>
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
            />
          </label>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-border/60 px-5 py-3">
        <div className="flex items-center gap-2 text-sm">
          <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium">{fileName}</span>
          <span className="text-muted-foreground">· {rows.length} rows</span>
          {hasErrors ? (
            <span className="text-danger">· validation errors</span>
          ) : (
            <span className="inline-flex items-center gap-1 text-success">
              <CheckCircle2 className="h-3.5 w-3.5" /> ready
            </span>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={() => { setRows([]); setFileName(""); }}>
          <X className="h-4 w-4" /> Clear
        </Button>
      </div>

      <div className="max-h-[460px] overflow-auto">
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow className="hover:bg-transparent">
              <TableHead>PO Number</TableHead>
              <TableHead>SKU Code</TableHead>
              <TableHead className="text-right">Received</TableHead>
              <TableHead className="text-right">Rejected</TableHead>
              <TableHead>Reason</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => {
              const errs = errorsByRow[i]!;
              const bad = (f: string) => errs.includes(f);
              return (
                <TableRow key={i} className={cn(errs.length > 0 && "bg-[hsl(0_72%_56%/0.05)]")}>
                  <TableCell className={cn(bad("po_number") && "text-danger font-medium")}>{r.po_number || "—"}</TableCell>
                  <TableCell className={cn(bad("sku_code") && "text-danger font-medium")}>{r.sku_code || "—"}</TableCell>
                  <TableCell className={cn("text-right nums", bad("received_qty") && "text-danger font-medium")}>{r.received_qty || "—"}</TableCell>
                  <TableCell className={cn("text-right nums", bad("rejected_qty") && "text-danger font-medium")}>{r.rejected_qty || "0"}</TableCell>
                  <TableCell className="text-muted-foreground">{r.rejection_reason || "—"}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border/60 px-5 py-4">
        <Button variant="outline" onClick={() => { setRows([]); setFileName(""); }}>Cancel</Button>
        <Button onClick={confirm} disabled={hasErrors || submitting}>
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          Confirm & reconcile
        </Button>
      </div>
    </Card>
  );
}
