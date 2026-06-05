import { NextRequest } from "next/server";
import { ok, fail, handler } from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { parseDumpFile } from "@/lib/integrations/blinkit/parse";
import { listDumpFiles, readDumpFile } from "@/lib/integrations/blinkit/files";
import { ingestBlinkitDump, type IngestSummary } from "@/lib/services/blinkit-ingest";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** GET → scan the configured dump dir(s) and ingest all files found. */
export async function GET() {
  return handler("GET /api/blinkit/import", async () => {
    const actor = await currentActor();
    const files = await listDumpFiles();
    if (files.length === 0) {
      return fail(
        new Error("No Blinkit dump files found. Set BLINKIT_DOWNLOAD_DIR or drop a file in Blinkit/po_dump."),
        404,
      );
    }
    const summaries: IngestSummary[] = [];
    for (const f of files) {
      const buf = await readDumpFile(f.fullPath);
      const sheet = parseDumpFile(f.name, buf);
      summaries.push(await ingestBlinkitDump(sheet, f.name, actor.label));
    }
    return ok({ filesIngested: files.length, summaries });
  });
}

/** POST → ingest an uploaded file (multipart `file`) or scan the dir (`{scan:true}`). */
export async function POST(req: NextRequest) {
  return handler("POST /api/blinkit/import", async () => {
    const actor = await currentActor();
    const contentType = req.headers.get("content-type") ?? "";

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return fail(new Error("No file provided"), 400);
      const buf = Buffer.from(await file.arrayBuffer());
      const sheet = parseDumpFile(file.name, buf);
      if (sheet.rows.length === 0) return fail(new Error("File parsed but contained no rows"), 400);
      const summary = await ingestBlinkitDump(sheet, file.name, actor.label);
      return ok({ filesIngested: 1, summaries: [summary] });
    }

    // JSON body → scan dir
    const files = await listDumpFiles();
    if (files.length === 0) return fail(new Error("No dump files found to scan"), 404);
    const summaries: IngestSummary[] = [];
    for (const f of files) {
      const buf = await readDumpFile(f.fullPath);
      summaries.push(await ingestBlinkitDump(parseDumpFile(f.name, buf), f.name, actor.label));
    }
    return ok({ filesIngested: files.length, summaries });
  });
}
