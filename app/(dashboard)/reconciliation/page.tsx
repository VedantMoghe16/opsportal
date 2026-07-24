import { AlertTriangle, Flag, FileWarning, CheckCheck } from "lucide-react";
import { Topbar } from "@/components/layout/topbar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatCard } from "@/components/dashboard/summary-stats";
import { DiscrepancyTable } from "@/components/reconciliation/discrepancy-table";
import { ResolvedTable } from "@/components/reconciliation/resolved-table";
import { ShortShipTable } from "@/components/reconciliation/short-ship-table";
import {
  getOpenDiscrepancies,
  getResolvedDiscrepancies,
  getReconciliationSummary,
  getVarianceTieOut,
  getInternalShortShip,
} from "@/lib/data/queries";
import { formatINR, formatNumber } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ReconciliationPage() {
  const [open, resolved, summary, tieOut, shortShip] = await Promise.all([
    getOpenDiscrepancies(),
    getResolvedDiscrepancies(),
    getReconciliationSummary(),
    getVarianceTieOut(),
    getInternalShortShip(),
  ]);

  return (
    <>
      <Topbar
        title="Reconciliation"
        subtitle="Every unit lost between PO and receipt — diffed vs dispatched, assigned, or ordered"
      />
      <main className="flex-1 space-y-6 px-5 py-6 lg:px-8">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="At risk (open)"
            value={formatINR(summary.openValue)}
            hint={`${summary.openCount} open discrepancies`}
            icon={AlertTriangle}
            accent="danger"
          />
          <StatCard
            label="Disputed with channel"
            value={formatINR(summary.disputedValue)}
            hint={`${summary.disputedCount} awaiting channel response`}
            icon={Flag}
            accent="lav"
          />
          <StatCard
            label="Debit notes this month"
            value={formatINR(summary.debitNotedValue)}
            hint={`${summary.debitNotedCount} raised`}
            icon={FileWarning}
            accent="mint"
          />
          <StatCard
            label="Written off this month"
            value={formatINR(summary.writtenOffValue)}
            hint={`${summary.writtenOffCount} accepted`}
            icon={CheckCheck}
            accent="lime"
          />
        </div>

        <p className="text-xs text-muted-foreground">
          Tie-out (last {tieOut.windowDays}d): {formatNumber(tieOut.gapUnits)} units ordered but not
          received ({formatINR(tieOut.gapValue)}) · {formatNumber(tieOut.explainedUnits)} captured as
          discrepancies · {formatNumber(tieOut.unexplainedUnits)} unexplained
          {tieOut.unexplainedUnits > 0 && (
            <> — mostly GRNs from before baseline tracking; run <code>scripts/backfill-discrepancies.ts</code> to surface them</>
          )}
          .
        </p>

        <Tabs defaultValue="open">
          <TabsList>
            <TabsTrigger value="open">Open ({open.length})</TabsTrigger>
            <TabsTrigger value="short-ship">Internal short-ship ({shortShip.length})</TabsTrigger>
            <TabsTrigger value="resolved">Resolved ({resolved.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="open">
            <Card className="overflow-hidden">
              <CardHeader><CardTitle>Open discrepancies</CardTitle></CardHeader>
              <CardContent className="p-0">
                <DiscrepancyTable rows={open} />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="short-ship">
            <Card className="overflow-hidden">
              <CardHeader>
                <CardTitle>Internal short-ship · last 30 days</CardTitle>
                <p className="text-xs text-muted-foreground">
                  We committed less than the channel ordered — our stock problem, not a channel
                  dispute. Fix availability; nothing to resolve here.
                </p>
              </CardHeader>
              <CardContent className="p-0">
                <ShortShipTable rows={shortShip} />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="resolved">
            <Card className="overflow-hidden">
              <CardHeader><CardTitle>Resolved · last 100</CardTitle></CardHeader>
              <CardContent className="p-0">
                <ResolvedTable rows={resolved} />
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>
    </>
  );
}
