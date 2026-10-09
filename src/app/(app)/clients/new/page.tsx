"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { apiFetch, formatCents } from "@/lib/api-client";
import { useApp } from "@/components/layout/app-provider";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import type { Client } from "@/types";

export default function NewClientPage() {
  const router = useRouter();
  const { refresh } = useApp();
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [industry, setIndustry] = useState("");
  const [website, setWebsite] = useState("");
  const [budget, setBudget] = useState("5000");
  const [notes, setNotes] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const budgetCents = Math.round(Number(budget) * 100);
      const data = await apiFetch<{ client: Client }>("/api/clients", {
        method: "POST",
        body: JSON.stringify({
          name,
          industry: industry || null,
          website_url: website || null,
          budget_ceiling_cents: Number.isFinite(budgetCents)
            ? budgetCents
            : null,
          notes: notes || null,
        }),
      });

      await refresh().catch(() => undefined);
      toast.success(`Created ${data.client.name}`, {
        description:
          "Next: open Connections → Sync ad accounts → map this client to a Meta ad account.",
      });
      router.push("/admin/connections");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="New client"
        description="Creates an agency client. Connect a Meta ad account afterward from Connections."
      />
      <Card>
        <CardContent className="p-6">
          <form className="space-y-4" onSubmit={onSubmit}>
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Modern Dental Centre"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="industry">Industry</Label>
              <Input
                id="industry"
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
                placeholder="Healthcare — Dental"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="website">Website</Label>
              <Input
                id="website"
                type="url"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                placeholder="https://example.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="budget">Budget ceiling (USD)</Label>
              <Input
                id="budget"
                type="number"
                min={0}
                step={100}
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
              />
              <p className="text-xs text-muted">
                Stored as{" "}
                <span className="font-mono">
                  {formatCents(Math.round(Number(budget || 0) * 100))}
                </span>
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                placeholder="Optional internal notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => router.back()}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !name.trim()}>
                {busy ? "Creating…" : "Create client"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
