import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { env } from "@/lib/env";

const EXTS = new Set([".csv", ".xlsx", ".xls"]);

/** Candidate directories the Python `po_dump` tool may have written into. */
export function dumpDirs(): string[] {
  const dirs: string[] = [];
  if (env.BLINKIT_DOWNLOAD_DIR) {
    dirs.push(env.BLINKIT_DOWNLOAD_DIR);
    dirs.push(path.join(env.BLINKIT_DOWNLOAD_DIR, "po_dump"));
  }
  dirs.push(path.join(process.cwd(), "Blinkit", "po_dump"));
  return [...new Set(dirs)];
}

export interface DumpFile {
  name: string;
  fullPath: string;
  mtimeMs: number;
  size: number;
}

/** List dump files across candidate dirs, newest first. */
export async function listDumpFiles(): Promise<DumpFile[]> {
  const out: DumpFile[] = [];
  for (const dir of dumpDirs()) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!EXTS.has(path.extname(name).toLowerCase())) continue;
      const fullPath = path.join(dir, name);
      try {
        const st = await fs.stat(fullPath);
        if (st.isFile()) out.push({ name, fullPath, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        /* skip */
      }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

export async function readDumpFile(fullPath: string): Promise<Buffer> {
  return fs.readFile(fullPath);
}
