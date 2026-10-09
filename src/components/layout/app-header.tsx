"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bell,
  ChevronsUpDown,
  LogOut,
  Building2,
  PanelLeft,
} from "lucide-react";
import { toast } from "sonner";
import type { Notification } from "@/types";
import { apiFetch, formatRelative } from "@/lib/api-client";
import { useApp } from "@/components/layout/app-provider";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function AppHeader() {
  const router = useRouter();
  const {
    user,
    clients,
    selectedClientId,
    setSelectedClientId,
    refresh,
    sidebarCollapsed,
    toggleSidebar,
  } = useApp();
  const [notifications, setNotifications] = useState<Notification[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiFetch<{ notifications: Notification[] }>(
          "/api/notifications?unread=1",
        );
        if (!cancelled) setNotifications(data.notifications);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function logout() {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
      router.push("/login");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Logout failed");
    }
  }

  async function markAllRead() {
    try {
      await apiFetch("/api/notifications", {
        method: "PATCH",
        body: JSON.stringify({ all: true }),
      });
      setNotifications([]);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to mark read");
    }
  }

  const initials =
    user?.profile.full_name
      ?.split(" ")
      .map((p) => p[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() ??
    user?.email?.slice(0, 2).toUpperCase() ??
    "AI";

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card/40 px-4 backdrop-blur">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted hover:text-foreground"
          onClick={toggleSidebar}
          title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <PanelLeft className="h-4 w-4" />
        </Button>
        <div className="hidden items-center gap-2 text-muted sm:flex">
          <Building2 className="h-4 w-4 shrink-0" />
          <span className="text-xs uppercase tracking-wide">Working on</span>
        </div>
        <Select
          value={selectedClientId ?? undefined}
          onValueChange={(value) => setSelectedClientId(value)}
          disabled={clients.length === 0}
        >
          <SelectTrigger className="h-9 w-full max-w-xs bg-background/60">
            <SelectValue
              placeholder={
                clients.length === 0
                  ? "No clients yet — add one under Clients"
                  : "Select a client account"
              }
            />
          </SelectTrigger>
          <SelectContent>
            {clients.map((client) => (
              <SelectItem key={client.id} value={client.id}>
                {client.name}
                {client.is_demo ? " · DEMO" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="relative">
            <Bell className="h-4 w-4" />
            {notifications.length > 0 ? (
              <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-accent" />
            ) : null}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
          <DropdownMenuLabel className="flex items-center justify-between">
            <span>Notifications</span>
            {notifications.length > 0 ? (
              <button
                type="button"
                className="text-xs font-normal text-accent"
                onClick={() => void markAllRead()}
              >
                Mark all read
              </button>
            ) : null}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {notifications.length === 0 ? (
            <div className="px-2 py-6 text-center text-sm text-muted">
              You&apos;re all caught up
            </div>
          ) : (
            notifications.slice(0, 6).map((n) => (
              <DropdownMenuItem
                key={n.id}
                className="flex flex-col items-start gap-0.5 py-2"
                onClick={() => n.href && router.push(n.href)}
              >
                <span className="text-sm font-medium">{n.title}</span>
                <span className="text-xs text-muted line-clamp-2">{n.body}</span>
                <span className="font-mono text-[10px] text-muted">
                  {formatRelative(n.created_at)}
                </span>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="h-9 gap-2 px-2">
            <Avatar className="h-7 w-7">
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
            <div className="hidden min-w-0 text-left md:block">
              <p className="truncate text-sm font-medium leading-none">
                {user?.profile.full_name ?? user?.email ?? "User"}
              </p>
              <p className="mt-0.5 truncate text-[11px] text-muted">
                {user?.profile.role}
              </p>
            </div>
            <ChevronsUpDown className="hidden h-3.5 w-3.5 text-muted md:block" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>
            <div className="flex flex-col gap-1">
              <span>{user?.profile.full_name}</span>
              <span className="font-mono text-xs font-normal text-muted">
                {user?.email}
              </span>
              <Badge variant="secondary" className="mt-1 w-fit capitalize">
                {user?.profile.role}
              </Badge>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => void logout()}>
            <LogOut className="h-4 w-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
