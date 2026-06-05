import { ArrowDownRight, ArrowUpRight, type LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface StatCardProps {
  label: string;
  value: string;
  icon: LucideIcon;
  trend?: { value: string; positive: boolean } | null;
  accent?: "lime" | "mint" | "lav" | "danger";
  hint?: string;
}

const ACCENT: Record<NonNullable<StatCardProps["accent"]>, string> = {
  lime: "bg-lime-soft text-[hsl(72_60%_26%)]",
  mint: "bg-mint/40 text-[hsl(162_50%_24%)]",
  lav: "bg-accent text-accent-foreground",
  danger: "bg-[hsl(0_72%_56%/0.12)] text-[hsl(0_64%_44%)]",
};

export function StatCard({
  label,
  value,
  icon: Icon,
  trend,
  accent = "lav",
  hint,
}: StatCardProps) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <span className={cn("grid h-10 w-10 place-items-center rounded-xl", ACCENT[accent])}>
          <Icon className="h-5 w-5" />
        </span>
        {trend && (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-semibold",
              trend.positive
                ? "bg-[hsl(158_64%_42%/0.14)] text-[hsl(158_64%_30%)]"
                : "bg-[hsl(0_72%_56%/0.13)] text-[hsl(0_64%_44%)]",
            )}
          >
            {trend.positive ? (
              <ArrowUpRight className="h-3 w-3" />
            ) : (
              <ArrowDownRight className="h-3 w-3" />
            )}
            {trend.value}
          </span>
        )}
      </div>
      <div className="mt-4 text-2xl font-semibold tracking-tight nums">{value}</div>
      <div className="mt-0.5 text-sm text-muted-foreground">{label}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground/80">{hint}</div>}
    </Card>
  );
}
