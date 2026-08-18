"use client";

import { AppProvider, useApp } from "@/components/layout/app-provider";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { AppHeader } from "@/components/layout/app-header";
import { LoadingState } from "@/components/shared/loading-state";
import { ErrorState } from "@/components/shared/error-state";

function ShellInner({ children }: { children: React.ReactNode }) {
  const { loading, bootError, refresh } = useApp();

  // Don't blank the whole chrome while APIs load — only block on hard boot errors.
  if (bootError) {
    return (
      <div className="flex min-h-screen items-center justify-center atmosphere p-6">
        <div className="w-full max-w-xl">
          <ErrorState
            title="Setup required"
            description={bootError}
            onRetry={() => void refresh()}
          />
          <p className="mt-4 text-center text-sm text-muted">
            Open Supabase → SQL Editor, paste{" "}
            <code className="font-mono text-xs">
              supabase/migrations/00001_foundation.sql
            </code>
            , run it, then retry.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen atmosphere">
      <AppSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <AppHeader />
        <main className="flex-1 overflow-auto p-4 md:p-6">
          {loading ? <LoadingState label="Loading workspace…" skeleton /> : children}
        </main>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <AppProvider>
      <ShellInner>{children}</ShellInner>
    </AppProvider>
  );
}
