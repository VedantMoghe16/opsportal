import { Topbar } from "@/components/layout/topbar";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { AllocationList } from "@/components/allocation/allocation-list";
import { getAllocationList } from "@/lib/data/queries";

export const dynamic = "force-dynamic";

export default async function AllocatePage() {
  const rows = await getAllocationList();
  return (
    <>
      <Topbar title="Allocation" subtitle="Open each PO and enter how much to fulfil per SKU" />
      <main className="flex-1 px-5 py-6 lg:px-8">
        <Card className="overflow-hidden">
          <CardHeader className="pb-2">
            <CardTitle>POs to allocate · {rows.length}</CardTitle>
          </CardHeader>
          <AllocationList rows={rows} />
        </Card>
      </main>
    </>
  );
}
