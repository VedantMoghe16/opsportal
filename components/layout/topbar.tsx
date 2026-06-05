import { Search, Bell } from "lucide-react";
import { Logo } from "./logo";
import { Button } from "@/components/ui/button";

export function Topbar({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="sticky top-0 z-30 flex h-[68px] items-center gap-4 border-b border-border/60 bg-canvas/80 px-5 backdrop-blur-md lg:px-8">
      <div className="lg:hidden">
        <Logo variant="dark" />
      </div>
      <div className="hidden min-w-0 lg:block">
        <h1 className="truncate text-[19px] font-semibold tracking-tight">{title}</h1>
        {subtitle && (
          <p className="truncate text-[13px] text-muted-foreground">{subtitle}</p>
        )}
      </div>

      <div className="ml-auto flex items-center gap-2">
        <div className="relative hidden md:block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            placeholder="Search POs, SKUs…"
            className="h-10 w-56 rounded-full border border-input bg-card pl-9 pr-3 text-sm shadow-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40"
          />
        </div>
        <Button variant="outline" size="icon" className="relative">
          <Bell className="h-[18px] w-[18px]" />
          <span className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-danger" />
        </Button>
      </div>
    </header>
  );
}
