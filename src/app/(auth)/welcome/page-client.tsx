"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Profile } from "@/types";

/**
 * After clicking an invite or reset link the person is signed in; here they
 * choose a password (and their name, on first visit) before entering the app.
 */
export default function WelcomePageClient() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const reset = searchParams.get("reset") === "1";
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined);
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ user: { profile: Profile } }>("/api/auth/me")
      .then((d) => {
        if (cancelled) return;
        setProfile(d.user.profile);
        setFullName(d.user.profile.full_name ?? "");
      })
      .catch(() => !cancelled && setProfile(null));
    return () => {
      cancelled = true;
    };
  }, []);

  const mismatch = confirm.length > 0 && confirm !== password;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (mismatch) return;
    setBusy(true);
    try {
      await apiFetch("/api/auth/set-password", {
        method: "POST",
        body: JSON.stringify({ password, fullName: reset ? undefined : fullName.trim() || undefined }),
      });
      toast.success(reset ? "Password updated" : "You're all set");
      // The link already started the session; just enter the app.
      router.replace("/dashboard");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't save your password");
      setBusy(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center atmosphere-login px-6 py-16">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card/80 p-6 shadow-[var(--shadow-glow)] backdrop-blur">
        {profile === undefined ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : profile === null ? (
          <div className="space-y-3">
            <h1 className="text-lg font-semibold">This link has expired</h1>
            <p className="text-sm text-muted">
              Invite and reset links work once and expire after 24 hours. Ask your administrator to send a new one.
            </p>
            <Button asChild variant="outline">
              <Link href="/login">Go to sign in</Link>
            </Button>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={submit}>
            <div>
              <h1 className="text-lg font-semibold">{reset ? "Set a new password" : "Welcome to CampaignForge"}</h1>
              <p className="mt-1 text-sm text-muted">
                {reset ? "Choose a new password for " : "Choose a password to finish setting up "}
                <span className="font-mono text-foreground">{profile.email}</span>.
              </p>
            </div>
            {!reset ? (
              <div className="space-y-1.5">
                <Label htmlFor="fullName">Your name</Label>
                <Input id="fullName" value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" />
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                required
                minLength={10}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <p className="text-[11px] text-muted">At least 10 characters, with a letter and a number.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirm">Confirm password</Label>
              <Input
                id="confirm"
                type="password"
                required
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                aria-invalid={mismatch}
              />
              {mismatch ? <p className="text-[11px] text-danger">The passwords don&apos;t match.</p> : null}
            </div>
            <Button type="submit" className="w-full" disabled={busy || mismatch || password.length < 10}>
              {busy ? "Saving…" : reset ? "Update password" : "Finish and sign in"}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
