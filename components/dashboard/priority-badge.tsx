"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { PRIORITY_META } from "@/lib/status";
import { cn } from "@/lib/utils";

const CYCLE: (string | null)[] = ["P1", "P2", "P3", null];

export function PriorityBadge({
  poId,
  priority,
  editable = true,
}: {
  poId: string;
  priority: string | null;
  editable?: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState<string | null>(priority);
  const [isPending, startTransition] = useTransition();

  function cycle() {
    if (!editable) return;
    const idx = CYCLE.indexOf(value);
    const next = CYCLE[(idx + 1) % CYCLE.length] ?? null;
    setValue(next);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/pos/${poId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ priority: next }),
        });
        if (!res.ok) throw new Error();
        toast.success(next ? `Priority set to ${next}` : "Priority cleared");
        router.refresh();
      } catch {
        setValue(priority);
        toast.error("Failed to update priority");
      }
    });
  }

  if (!value) {
    return (
      <button
        onClick={cycle}
        disabled={!editable || isPending}
        className={cn(
          "rounded-full border border-dashed border-border px-2.5 py-0.5 text-xs font-medium text-muted-foreground transition-colors",
          editable && "hover:border-foreground/40 hover:text-foreground",
        )}
      >
        Set
      </button>
    );
  }

  const meta = PRIORITY_META[value]!;
  return (
    <button onClick={cycle} disabled={!editable || isPending} className={cn(editable && "cursor-pointer")}>
      <Badge variant={meta.variant} className={cn(isPending && "opacity-60")}>
        {meta.label}
      </Badge>
    </button>
  );
}
