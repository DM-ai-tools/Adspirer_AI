"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { Client, Profile } from "@/types";
import { apiFetch } from "@/lib/api-client";
import { sanitizeClientFacingText } from "@/lib/client-facing";

type AuthUser = {
  id: string;
  email: string;
  profile: Profile;
};

type AppContextValue = {
  user: AuthUser | null;
  clients: Client[];
  selectedClientId: string | null;
  setSelectedClientId: (id: string | null) => void;
  pendingApprovals: number;
  refresh: () => Promise<void>;
  loading: boolean;
  bootError: string | null;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
};

const AppContext = createContext<AppContextValue | null>(null);

const SELECTED_CLIENT_KEY = "adspirer_selected_client";
const SIDEBAR_COLLAPSED_KEY = "adspirer_sidebar_collapsed";

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [selectedClientId, setSelectedClientIdState] = useState<string | null>(
    null,
  );
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const [loading, setLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsedState] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setSidebarCollapsedState(
      localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1",
    );
  }, []);

  const setSidebarCollapsed = useCallback((collapsed: boolean) => {
    setSidebarCollapsedState(collapsed);
    if (typeof window !== "undefined") {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
    }
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsedState((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      }
      return next;
    });
  }, []);

  const setSelectedClientId = useCallback((id: string | null) => {
    setSelectedClientIdState(id);
    if (typeof window !== "undefined") {
      if (id) localStorage.setItem(SELECTED_CLIENT_KEY, id);
      else localStorage.removeItem(SELECTED_CLIENT_KEY);
    }
  }, []);

  const refresh = useCallback(async () => {
    setBootError(null);
    const me = await apiFetch<{ user: AuthUser }>("/api/auth/me");
    setUser(me.user);

    // Don't block the shell on secondary fetches.
    const [clientsRes, dashboard] = await Promise.all([
      apiFetch<{ clients: Client[] }>("/api/clients"),
      apiFetch<{
        stats: { pendingApprovals: number };
      }>("/api/dashboard").catch(() => ({
        stats: { pendingApprovals: 0 },
      })),
    ]);

    setClients(clientsRes.clients);
    setPendingApprovals(dashboard.stats.pendingApprovals);

    setSelectedClientIdState((current) => {
      if (current && clientsRes.clients.some((c) => c.id === current)) {
        return current;
      }
      const stored =
        typeof window !== "undefined"
          ? localStorage.getItem(SELECTED_CLIENT_KEY)
          : null;
      if (stored && clientsRes.clients.some((c) => c.id === stored)) {
        return stored;
      }
      return clientsRes.clients[0]?.id ?? null;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Resolve identity first so chrome can render; then fill roster.
        setBootError(null);
        const me = await apiFetch<{ user: AuthUser }>("/api/auth/me");
        if (cancelled) return;
        setUser(me.user);
        setLoading(false);

        const [clientsRes, dashboard] = await Promise.all([
          apiFetch<{ clients: Client[] }>("/api/clients"),
          apiFetch<{
            stats: { pendingApprovals: number };
          }>("/api/dashboard").catch(() => ({
            stats: { pendingApprovals: 0 },
          })),
        ]);
        if (cancelled) return;

        setClients(clientsRes.clients);
        setPendingApprovals(dashboard.stats.pendingApprovals);
        setSelectedClientIdState((current) => {
          if (current && clientsRes.clients.some((c) => c.id === current)) {
            return current;
          }
          const stored =
            typeof window !== "undefined"
              ? localStorage.getItem(SELECTED_CLIENT_KEY)
              : null;
          if (stored && clientsRes.clients.some((c) => c.id === stored)) {
            return stored;
          }
          return clientsRes.clients[0]?.id ?? null;
        });
      } catch (error) {
        if (!cancelled) {
          setUser(null);
          setClients([]);
          const status =
            error && typeof error === "object" && "status" in error
              ? Number((error as { status: unknown }).status)
              : undefined;
          const message = sanitizeClientFacingText(
            error instanceof Error ? error.message : String(error ?? ""),
          );

          if (/schema|user profiles is missing|migration|database setup/i.test(message)) {
            setBootError(
              "Workspace data isn’t ready yet. Contact your administrator to finish setup.",
            );
          } else if (
            status === 401 ||
            /unauthor|unauthenticated/i.test(message)
          ) {
            window.location.href = "/login";
          } else if (/auth/i.test(message) && status !== 500) {
            window.location.href = "/login";
          } else {
            setBootError(message || "Failed to load workspace");
          }
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo(
    () => ({
      user,
      clients,
      selectedClientId,
      setSelectedClientId,
      pendingApprovals,
      refresh,
      loading,
      bootError,
      sidebarCollapsed,
      setSidebarCollapsed,
      toggleSidebar,
    }),
    [
      user,
      clients,
      selectedClientId,
      setSelectedClientId,
      pendingApprovals,
      refresh,
      loading,
      bootError,
      sidebarCollapsed,
      setSidebarCollapsed,
      toggleSidebar,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
