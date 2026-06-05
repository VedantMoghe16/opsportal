import "server-only";
import Papa from "papaparse";
import * as XLSX from "xlsx";

export interface ParsedSheet {
  headers: string[];
  rows: Record<string, string>[];
}

/**
 * Parse a Blinkit PO dump (the file the Python `po_dump` tool downloads).
 * Supports both shapes it can arrive as — CSV or XLSX — detected by extension
 * then by magic bytes. Returns the ordered header list + row objects keyed by
 * header, with every value coerced to a trimmed string (raw is preserved).
 */
export function parseDumpFile(filename: string, buffer: Buffer): ParsedSheet {
  const lower = filename.toLowerCase();
  const isXlsx =
    lower.endsWith(".xlsx") ||
    lower.endsWith(".xls") ||
    buffer.subarray(0, 4).toString("binary") === "PK\x03\x04" ||
    buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));

  return isXlsx ? parseXlsx(buffer) : parseCsv(buffer);
}

function parseXlsx(buffer: Buffer): ParsedSheet {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return { headers: [], rows: [] };
  const ws = wb.Sheets[sheetName]!;
  // header:1 to capture the exact ordered header row
  const matrix = XLSX.utils.sheet_to_json<string[]>(ws, {
    header: 1,
    defval: "",
    raw: false,
    blankrows: false,
  });
  if (matrix.length === 0) return { headers: [], rows: [] };
  const headers = (matrix[0] ?? []).map((h) => String(h).trim()).filter(Boolean);
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < matrix.length; i++) {
    const arr = matrix[i] ?? [];
    if (arr.every((c) => String(c ?? "").trim() === "")) continue;
    const row: Record<string, string> = {};
    headers.forEach((h, j) => {
      row[h] = String(arr[j] ?? "").trim();
    });
    rows.push(row);
  }
  return { headers, rows };
}

function parseCsv(buffer: Buffer): ParsedSheet {
  const text = buffer.toString("utf-8").replace(/^﻿/, "");
  const res = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });
  const headers = (res.meta.fields ?? []).map((h) => h.trim()).filter(Boolean);
  const rows = (res.data as Record<string, string>[])
    .map((r) => {
      const out: Record<string, string> = {};
      for (const h of headers) out[h] = String(r[h] ?? "").trim();
      return out;
    })
    .filter((r) => Object.values(r).some((v) => v !== ""));
  return { headers, rows };
}
