import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Topbar } from "@/components/layout/topbar";
import { CsvUpload } from "@/components/grn/csv-upload";

export const dynamic = "force-dynamic";

export default function GrnUploadPage() {
  return (
    <>
      <Topbar title="Upload GRN" subtitle="Manual CSV reconciliation" />
      <main className="flex-1 px-5 py-6 lg:px-8">
        <Link
          href="/grn"
          className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Back to GRN
        </Link>
        <div className="max-w-4xl">
          <CsvUpload />
        </div>
      </main>
    </>
  );
}
