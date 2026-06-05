import { Topbar } from "@/components/layout/topbar";
import { Card } from "@/components/ui/card";
import { PoTable } from "@/components/dashboard/po-table";
import { getOrders } from "@/lib/data/queries";

export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  const orders = await getOrders();
  return (
    <>
      <Topbar title="Orders" subtitle="Full purchase-order pipeline" />
      <main className="flex-1 px-5 py-6 lg:px-8">
        <Card className="overflow-hidden pt-4">
          <PoTable pos={orders} />
        </Card>
      </main>
    </>
  );
}
