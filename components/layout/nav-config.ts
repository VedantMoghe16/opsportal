import {
  LayoutDashboard,
  ClipboardList,
  Package,
  CheckCircle2,
  Zap,
  TrendingUp,
  Settings,
  ShoppingBag,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  badgeKey?: "pendingPos" | "openDiscrepancies";
}

export const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", href: "/", icon: LayoutDashboard },
  { label: "Blinkit", href: "/blinkit", icon: ShoppingBag },
  { label: "Allocation", href: "/allocate", icon: ClipboardList, badgeKey: "pendingPos" },
  { label: "Orders", href: "/orders", icon: Package },
  { label: "GRN", href: "/grn", icon: CheckCircle2, badgeKey: "openDiscrepancies" },
  { label: "Reconciliation", href: "/reconciliation", icon: Zap },
  { label: "Analytics", href: "/analytics", icon: TrendingUp },
];

export const SETTINGS_ITEM: NavItem = {
  label: "Settings",
  href: "/settings",
  icon: Settings,
};
