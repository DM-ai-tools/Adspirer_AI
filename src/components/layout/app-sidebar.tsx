"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  Users,
  Bot,
  ShieldCheck,
  Activity,
  Palette,
  ScrollText,
  UserCog,
  Plug,
  Settings,
  Sparkles,
  PanelLeftClose,
  PanelLeft,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { isNavActive } from "@/lib/nav";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { useApp } from "@/components/layout/app-provider";

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: number;
};

const MAIN_NAV: NavItem[] = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/clients", label: "Clients", icon: Users },
  { href: "/workspace", label: "Workspace", icon: Bot },
  { href: "/workspace-v2", label: "Workspace V2 (A/B)", icon: Sparkles },
  { href: "/approvals", label: "Approvals", icon: ShieldCheck },
  { href: "/monitoring", label: "Monitoring", icon: Activity },
  { href: "/creatives", label: "Creatives", icon: Palette },
  { href: "/audit", label: "Audit Log", icon: ScrollText },
];

const ADMIN_NAV: NavItem[] = [
  { href: "/admin/team", label: "Team", icon: UserCog },
  { href: "/admin/adspirer", label: "Connections", icon: Plug },
  { href: "/admin/settings", label: "Settings", icon: Settings },
];

function NavLink({
  item,
  active,
  collapsed,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
}) {
  const router = useRouter();
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      prefetch
      title={collapsed ? item.label : undefined}
      onMouseEnter={() => {
        router.prefetch(item.href);
      }}
      className={cn(
        "group flex items-center rounded-lg py-2 text-sm transition-colors",
        collapsed ? "justify-center px-2" : "gap-2.5 px-2.5",
        active
          ? "bg-accent-muted text-accent"
          : "text-muted hover:bg-secondary hover:text-foreground",
      )}
    >
      <Icon
        className={cn(
          "h-4 w-4 shrink-0",
          active ? "text-accent" : "text-muted group-hover:text-foreground",
        )}
      />
      {!collapsed ? (
        <>
          <span className="flex-1 truncate">{item.label}</span>
          {item.badge && item.badge > 0 ? (
            <Badge variant="warning" className="h-5 min-w-5 justify-center px-1.5">
              {item.badge}
            </Badge>
          ) : null}
        </>
      ) : item.badge && item.badge > 0 ? (
        <span className="absolute right-1.5 top-1 h-1.5 w-1.5 rounded-full bg-warning" />
      ) : null}
    </Link>
  );
}

export function AppSidebar() {
  const pathname = usePathname();
  const { user, pendingApprovals, sidebarCollapsed, toggleSidebar, selectedClientId } = useApp();
  const isAdmin = user?.profile.role === "admin";

  const main = MAIN_NAV.map((item) =>
    item.href === "/approvals"
      ? { ...item, badge: pendingApprovals }
      : item,
  );

  return (
    <aside
      className={cn(
        "flex h-screen shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200 ease-out",
        sidebarCollapsed ? "w-[4.25rem]" : "w-64",
      )}
    >
      <div
        className={cn(
          "flex h-14 items-center border-b border-sidebar-border",
          sidebarCollapsed ? "justify-center px-2" : "gap-2.5 px-4",
        )}
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-muted text-accent">
          <Sparkles className="h-4 w-4" />
        </div>
        {!sidebarCollapsed ? (
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold tracking-tight text-foreground">
              Adspirer AI
            </p>
            <p className="truncate text-[10px] uppercase tracking-[0.14em] text-muted">
              Meta Ops
            </p>
          </div>
        ) : null}
      </div>

      <div className={cn("flex-1 overflow-y-auto py-3", sidebarCollapsed ? "px-2" : "px-3")}>
        <nav className="flex flex-col gap-0.5">
          {main.map((item) => (
            <div key={item.href} className="relative">
              <NavLink
                item={{
                  ...item,
                  href:
                    selectedClientId &&
                    (item.href === "/workspace" || item.href === "/workspace-v2")
                      ? `${item.href}?clientId=${encodeURIComponent(selectedClientId)}`
                      : item.href,
                }}
                collapsed={sidebarCollapsed}
                active={isNavActive(pathname, item.href)}
              />
            </div>
          ))}
        </nav>

        {isAdmin ? (
          <>
            <Separator className="my-4" />
            {!sidebarCollapsed ? (
              <p className="mb-2 px-2.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">
                Admin
              </p>
            ) : null}
            <nav className="flex flex-col gap-0.5">
              {ADMIN_NAV.map((item) => (
                <div key={item.href} className="relative">
                  <NavLink
                    item={item}
                    collapsed={sidebarCollapsed}
                    active={isNavActive(pathname, item.href)}
                  />
                </div>
              ))}
            </nav>
          </>
        ) : null}
      </div>

      <div
        className={cn(
          "border-t border-sidebar-border p-2",
          sidebarCollapsed ? "flex justify-center" : "",
        )}
      >
        <Button
          type="button"
          variant="ghost"
          size={sidebarCollapsed ? "icon" : "sm"}
          className={cn(
            "text-muted hover:text-foreground",
            !sidebarCollapsed && "w-full justify-start gap-2",
          )}
          onClick={toggleSidebar}
          title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {sidebarCollapsed ? (
            <PanelLeft className="h-4 w-4" />
          ) : (
            <>
              <PanelLeftClose className="h-4 w-4" />
              Collapse
            </>
          )}
        </Button>
      </div>
    </aside>
  );
}
