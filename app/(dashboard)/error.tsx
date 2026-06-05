"use client";

import { useEffect } from "react";
import { DatabaseZap, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const isDbError = /database|prisma|connect|ECONNREFUSED|P\d{4}/i.test(error.message);

  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <Card className="max-w-md p-8 text-center">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-[hsl(0_72%_56%/0.12)] text-danger">
          <DatabaseZap className="h-7 w-7" />
        </div>
        <h2 className="mt-4 text-lg font-semibold">
          {isDbError ? "Can't reach the database" : "Something went wrong"}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {isDbError
            ? "Set DATABASE_URL in .env.local, then run prisma migrate dev and prisma db seed."
            : error.message || "An unexpected error occurred."}
        </p>
        <Button className="mt-5" onClick={reset}>
          <RefreshCw className="h-4 w-4" /> Try again
        </Button>
      </Card>
    </div>
  );
}
