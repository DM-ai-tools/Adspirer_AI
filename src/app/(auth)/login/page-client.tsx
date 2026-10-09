"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Sparkles, Shield, Bot } from "lucide-react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { safeInternalPath } from "@/lib/utils";
import type { Profile } from "@/types";

const DEMO_USERS = [
  {
    email: "admin@spendsmith.demo",
    label: "Continue as Admin",
    description: "Full access — team, connections, client access",
    icon: Shield,
  },
  {
    email: "operator@spendsmith.demo",
    label: "Continue as Operator",
    description: "Client workspace, approvals, and monitoring",
    icon: Bot,
  },
] as const;

type AuthMode = {
  demoMode: boolean;
};

export default function LoginPageClient() {
  const searchParams = useSearchParams();
  const [mode, setMode] = useState<AuthMode | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<"signin" | "register">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiFetch<AuthMode>("/api/auth/mode");
        if (!cancelled) setMode({ demoMode: Boolean(data.demoMode) });
      } catch {
        if (!cancelled) setMode({ demoMode: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function goNext() {
    const next = safeInternalPath(searchParams.get("next"));
    // Full document navigation so the auth cookie from this response is
    // definitely sent. Client-side router.push raced the cookie on first click.
    window.location.assign(next);
  }

  async function demoLogin(demoEmail: string) {
    setBusy(demoEmail);
    try {
      await apiFetch<{
        user: { id: string; email: string; profile: Profile };
      }>("/api/auth/demo-login", {
        method: "POST",
        body: JSON.stringify({ email: demoEmail }),
      });
      toast.success(`Signed in as ${demoEmail}`);
      goNext();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Login failed");
    } finally {
      setBusy(null);
    }
  }

  async function signIn() {
    setBusy("signin");
    try {
      await apiFetch("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      toast.success("Signed in");
      goNext();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Sign in failed");
    } finally {
      setBusy(null);
    }
  }

  async function register() {
    setBusy("register");
    try {
      const data = await apiFetch<{
        needsEmailConfirmation?: boolean;
        message?: string;
      }>("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({
          email,
          password,
          fullName: fullName || undefined,
        }),
      });
      toast.success(data.message ?? "Account created");
      if (data.needsEmailConfirmation) {
        setTab("signin");
      } else {
        goNext();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Registration failed");
    } finally {
      setBusy(null);
    }
  }

  const loadingMode = mode === null;
  const demoMode = mode?.demoMode ?? true;

  return (
    <div className="relative flex min-h-screen atmosphere-login">
      <div className="absolute inset-0 bg-gradient-to-br from-transparent via-transparent to-black/40" />

      <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-col justify-center px-6 py-16 lg:flex-row lg:items-center lg:gap-20 lg:px-10">
        <div className="mb-12 max-w-xl lg:mb-0">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent-muted px-3 py-1 text-xs font-medium text-accent">
            <Sparkles className="h-3.5 w-3.5" />
            AI Meta Ads Operations
          </div>
          <h1 className="text-5xl font-semibold tracking-tight text-foreground sm:text-6xl">
            Spendsmith
          </h1>
          <p className="mt-4 text-lg leading-relaxed text-muted">
            Enterprise agent workspace for auditing Meta accounts, proposing
            changes, and executing only after human approval.
          </p>
          <div className="mt-8 flex flex-wrap gap-3 text-sm text-muted">
            <span className="rounded-md border border-border bg-card/60 px-3 py-1.5">
              Diagnose freely
            </span>
            <span className="rounded-md border border-border bg-card/60 px-3 py-1.5">
              Approve executes
            </span>
            <span className="rounded-md border border-border bg-card/60 px-3 py-1.5">
              Full audit trail
            </span>
          </div>
        </div>

        <div className="w-full max-w-md rounded-2xl border border-border bg-card/80 p-6 shadow-[var(--shadow-glow)] backdrop-blur">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">Sign in</h2>
              <p className="mt-1 text-sm text-muted">
                {loadingMode
                  ? "Loading…"
                  : demoMode
                    ? "Choose a demo persona to enter the ops console."
                    : "Sign in with your work email and password."}
              </p>
            </div>
            {demoMode ? (
              <Badge variant="warning">DEMO MODE</Badge>
            ) : (
              <Badge variant="success">LIVE</Badge>
            )}
          </div>

          {loadingMode ? (
            <p className="text-sm text-muted">Checking configuration…</p>
          ) : demoMode ? (
            <>
              <div className="space-y-3">
                {DEMO_USERS.map((user) => {
                  const Icon = user.icon;
                  return (
                    <Button
                      key={user.email}
                      variant="outline"
                      className="h-auto w-full justify-start gap-3 px-4 py-3 text-left"
                      disabled={busy !== null}
                      onClick={() => void demoLogin(user.email)}
                    >
                      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-muted text-accent">
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-foreground">
                          {busy === user.email ? "Signing in…" : user.label}
                        </span>
                        <span className="mt-0.5 block text-xs font-normal text-muted">
                          {user.description}
                        </span>
                        <span className="mt-1 block font-mono text-[11px] text-accent/80">
                          {user.email}
                        </span>
                      </span>
                    </Button>
                  );
                })}
              </div>
              <p className="mt-5 rounded-lg border border-border-subtle bg-secondary/40 px-3 py-2 text-xs leading-relaxed text-muted">
                Demo mode uses sample clients and mock Meta data so you can
                explore the workspace safely.
              </p>
            </>
          ) : (
            <>
              <div className="mb-4 flex gap-2">
                <Button
                  type="button"
                  variant={tab === "signin" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setTab("signin")}
                >
                  Sign in
                </Button>
                <Button
                  type="button"
                  variant={tab === "register" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setTab("register")}
                >
                  Register
                </Button>
              </div>

              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (tab === "signin") void signIn();
                  else void register();
                }}
              >
                {tab === "register" ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="fullName">Full name</Label>
                    <Input
                      id="fullName"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder="Jane Operator"
                      autoComplete="name"
                    />
                  </div>
                ) : null}
                <div className="space-y-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@agency.com"
                    autoComplete="email"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    required
                    minLength={tab === "register" ? 8 : 6}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    autoComplete={
                      tab === "signin" ? "current-password" : "new-password"
                    }
                  />
                </div>
                <Button
                  type="submit"
                  className="w-full"
                  disabled={busy !== null}
                >
                  {busy
                    ? "Please wait…"
                    : tab === "signin"
                      ? "Sign in"
                      : "Create account"}
                </Button>
              </form>

              <p className="mt-5 rounded-lg border border-border-subtle bg-secondary/40 px-3 py-2 text-xs leading-relaxed text-muted">
                Use <strong>Register</strong> to create an account. Ask your
                workspace admin if you need access to Admin pages.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
