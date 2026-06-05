import { Topbar } from "@/components/layout/topbar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DiscrepancyTable } from "@/components/reconciliation/discrepancy-table";
import { getOpenDiscrepancies } from "@/lib/data/queries";

export const dynamic = "force-dynamic";

export default async function ReconciliationPage() {
  const rows = await getOpenDiscrepancies();
  return (
    <>
      <Topbar
        title="Reconciliation"
        subtitle="Resolve GRN discrepancies outside the 2% tolerance"
      />
      <main className="flex-1 px-5 py-6 lg:px-8">
        <Card className="overflow-hidden">
          <CardHeader><CardTitle>Open discrepancies</CardTitle></CardHeader>
          <CardContent className="p-0">
            <DiscrepancyTable rows={rows} />
          </CardContent>
        </Card>
      </main>
    </>
  );
}
