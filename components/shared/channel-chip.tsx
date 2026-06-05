import { cn } from "@/lib/utils";

export function ChannelChip({
  name,
  color,
  tier,
  className,
}: {
  name: string;
  color?: string | null;
  tier?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <span
        className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[11px] font-bold text-white"
        style={{ backgroundColor: color ?? "#1a1a2e" }}
        aria-hidden
      >
        {name.slice(0, 2).toUpperCase()}
      </span>
      <div className="min-w-0 leading-tight">
        <div className="truncate text-sm font-medium">{name}</div>
        {tier && (
          <div className="text-[11px] text-muted-foreground">Tier {tier}</div>
        )}
      </div>
    </div>
  );
}
