import { cn } from "@/lib/utils";

export function Logo({
  className,
  variant = "light",
}: {
  className?: string;
  variant?: "light" | "dark";
}) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <span
        className={cn(
          "grid h-8 w-8 place-items-center rounded-xl font-black",
          variant === "light"
            ? "bg-primary text-primary-foreground"
            : "bg-foreground text-canvas",
        )}
      >
        M
      </span>
      <div className="leading-none">
        <div
          className={cn(
            "text-[15px] font-black tracking-[0.18em]",
            variant === "light" ? "text-sidebar-foreground" : "text-foreground",
          )}
        >
          MOXIE
        </div>
        <div
          className={cn(
            "mt-0.5 text-[10px] font-medium tracking-wide",
            variant === "light" ? "text-sidebar-muted" : "text-muted-foreground",
          )}
        >
          Operations
        </div>
      </div>
    </div>
  );
}
