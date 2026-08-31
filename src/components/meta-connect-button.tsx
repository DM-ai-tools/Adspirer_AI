"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api-client";
import { Button } from "@/components/ui/button";

interface MetaStatus {
  connected: boolean;
  metaUserName?: string;
  metaUserId?: string;
  expiresAt?: string;
}

type Variant = "compact" | "card";

type Props = {
  variant?: Variant;
  returnTo?: string;
  className?: string;
  onChanged?: (status: MetaStatus) => void;
  /** Called after a successful Sync ad accounts (reload account table). */
  onSynced?: () => void;
  /** After connect/sync, show a link to the Connections portal */
  showManageLink?: boolean;
};

export function MetaConnectButton({
  variant = "card",
  returnTo,
  className,
  onChanged,
  onSynced,
  showManageLink = false,
}: Props) {
  const [status, setStatus] = useState<MetaStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  // Keep callbacks in refs so mount-only fetch never re-runs when parent re-renders.
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const onSyncedRef = useRef(onSynced);
  onSyncedRef.current = onSynced;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/meta/status");
        const data = (await res.json()) as MetaStatus;
        if (cancelled) return;
        setStatus(data);
        onChangedRef.current?.(data);
      } catch {
        if (cancelled) return;
        const fallback = { connected: false };
        setStatus(fallback);
        onChangedRef.current?.(fallback);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Intentionally mount-only — do not depend on onChanged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConnect = () => {
    const qs = returnTo
      ? `?returnTo=${encodeURIComponent(returnTo)}`
      : "";
    window.location.href = `/api/auth/meta${qs}`;
  };

  const handleDisconnect = async () => {
    setLoading(true);
    await fetch("/api/auth/meta/disconnect", { method: "POST" });
    const next = { connected: false };
    setStatus(next);
    onChangedRef.current?.(next);
    setLoading(false);
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const data = await apiFetch<{ count: number }>("/api/auth/meta/sync", {
        method: "POST",
        body: JSON.stringify({}),
      });
      toast.success(
        `Synced ${data.count} Facebook ad account${data.count === 1 ? "" : "s"}`,
      );
      onSyncedRef.current?.();
      onChangedRef.current?.(status ?? { connected: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  if (loading) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 text-sm text-muted",
          variant === "card" &&
            "rounded-lg border border-border bg-secondary/30 px-4 py-3",
          className,
        )}
      >
        <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        Checking Facebook…
      </div>
    );
  }

  if (status?.connected) {
    if (variant === "compact") {
      return (
        <div
          className={cn(
            "flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5",
            className,
          )}
        >
          <span className="h-2 w-2 rounded-full bg-emerald-500" />
          <span className="max-w-[140px] truncate text-xs font-medium text-foreground">
            {status.metaUserName ?? "Facebook"}
          </span>
          {showManageLink ? (
            <Link
              href="/admin/adspirer"
              className="text-[11px] text-accent hover:underline"
            >
              Manage
            </Link>
          ) : null}
          <button
            type="button"
            onClick={handleConnect}
            className="text-[11px] text-muted hover:text-foreground"
          >
            Switch
          </button>
          <button
            type="button"
            onClick={() => void handleDisconnect()}
            className="text-[11px] text-muted hover:text-danger"
          >
            Disconnect
          </button>
        </div>
      );
    }

    return (
      <div
        className={cn(
          "rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3",
          className,
        )}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
            <div>
              <p className="text-sm font-medium text-foreground">
                Facebook connected
                {status.metaUserName ? ` · ${status.metaUserName}` : ""}
              </p>
              {status.expiresAt ? (
                <p className="text-xs text-muted">
                  Token expires{" "}
                  {new Date(status.expiresAt).toLocaleDateString()}
                </p>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={syncing}
              onClick={() => void handleSync()}
            >
              {syncing ? "Syncing…" : "Sync ad accounts"}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={handleConnect}
            >
              Switch account
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void handleDisconnect()}
            >
              Disconnect
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (variant === "compact") {
    return (
      <Button
        size="sm"
        className={cn("h-8 gap-1.5", className)}
        onClick={handleConnect}
      >
        <FacebookIcon className="h-3.5 w-3.5" />
        Connect Facebook
      </Button>
    );
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={handleConnect}
        className={cn(
          "flex w-full items-center justify-center gap-2 rounded-lg bg-[#1877F2] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#166fe5]",
          className,
        )}
      >
        <FacebookIcon className="h-4 w-4" />
        Connect with Facebook
      </button>
      <p className="text-[11px] text-muted">
        Continues to Facebook to approve access, then returns here. While the
        Meta app is in Development mode, use an Admin/Developer/Tester account.
      </p>
    </div>
  );
}

function FacebookIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
    </svg>
  );
}
