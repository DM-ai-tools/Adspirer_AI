"use client";

import { useState } from "react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api-client";
import {
  filterScanCandidates,
  googleCandidateFacts,
  googleCandidateServiceBody,
  googleImportUnavailableMessage,
} from "@/lib/clients/category-form";
import type { GoogleCandidatesResult, GoogleCategoryCandidate } from "@/lib/google/category-candidates";
import type { ClientService } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

/**
 * "Import from Google": the client's categories from its mapped GA4 property
 * and Search Console site, with revenue, clicks and order value; adds the
 * ticked ones. Rows that earned revenue start ticked.
 */
export function CategoryGoogleImport({
  clientId,
  word,
  onAdded,
}: {
  clientId: string;
  word: "category" | "service";
  onAdded: () => void;
}) {
  const words = word === "category" ? "categories" : "services";
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<GoogleCategoryCandidate[] | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);
  /** Set when Google couldn't be read: the reason the route gave ("not_mapped", …). */
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const view = filterScanCandidates(candidates ?? [], query);

  async function load() {
    setBusy(true);
    try {
      const data = await apiFetch<GoogleCandidatesResult>(`/api/clients/${clientId}/services/google-candidates`);
      setCandidates(data.candidates);
      setCurrency(data.source === "google" ? data.currency : null);
      setUnavailable(data.source === "unavailable" ? data.reason : null);
      setPicked(new Set(data.candidates.filter((c) => c.preselect && !c.alreadyAdded).map((c) => c.name)));
      setQuery("");
      if (data.source === "google" && data.warnings.length) toast.warning(data.warnings.join(" · "));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't read Google right now; try again.");
    } finally {
      setBusy(false);
    }
  }

  async function addSelected() {
    setBusy(true);
    let added = 0;
    let failed = 0;
    for (const c of candidates ?? []) {
      if (!picked.has(c.name) || c.alreadyAdded) continue;
      try {
        await apiFetch<{ service: ClientService }>(`/api/clients/${clientId}/services`, {
          method: "POST",
          body: JSON.stringify(googleCandidateServiceBody(c)),
        });
        added += 1;
      } catch {
        failed += 1;
      }
    }
    setBusy(false);
    if (added) onAdded();
    toast[failed ? "warning" : "success"](`Added ${added}${failed ? `, ${failed} failed` : ""}`);
    setCandidates(null);
  }

  return (
    <div className="space-y-2">
      <Button type="button" variant="outline" onClick={() => void load()} disabled={busy}>
        {busy && !candidates ? "Reading Google…" : "Import from Google"}
      </Button>
      {candidates ? (
        <div className="space-y-2 rounded-lg border border-border-subtle p-3">
          {unavailable ? (
            <p className="text-sm text-muted">{googleImportUnavailableMessage(unavailable)}</p>
          ) : candidates.length === 0 ? (
            <p className="text-sm text-muted">No {words} found in GA4 or Search Console.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`Search ${candidates.length} ${words}, e.g. bar stools`}
                  className="max-w-xs"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={view.selectable.length === 0}
                  onClick={() => setPicked((prev) => new Set([...prev, ...view.selectable]))}
                >
                  Select all shown ({view.selectable.length})
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={picked.size === 0}
                  onClick={() => setPicked(new Set())}
                >
                  Deselect all ({picked.size})
                </Button>
                <span className="text-xs text-muted">
                  {view.matched > view.shown.length
                    ? `Showing ${view.shown.length} of ${view.matched}; search to narrow it down`
                    : `${view.matched} of ${candidates.length} shown`}
                </span>
              </div>
              <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
                {view.shown.map((c) => (
                  <label key={c.name} className="flex items-start gap-2 text-sm">
                    <Checkbox
                      className="mt-0.5"
                      disabled={c.alreadyAdded}
                      checked={c.alreadyAdded || picked.has(c.name)}
                      onCheckedChange={(on) =>
                        setPicked((prev) => {
                          const next = new Set(prev);
                          if (on === true) next.add(c.name);
                          else next.delete(c.name);
                          return next;
                        })
                      }
                    />
                    <span className="min-w-0">
                      <span className={c.alreadyAdded ? "text-muted" : undefined}>{c.name}</span>
                      {c.alreadyAdded ? <span className="ml-2 text-xs text-muted">already added</span> : null}
                      <span className="block text-xs text-muted">
                        {[...googleCandidateFacts(c, currency), c.landing_page_url ? null : "no page found"]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              <Button type="button" size="sm" disabled={busy || picked.size === 0} onClick={() => void addSelected()}>
                Add selected ({picked.size})
              </Button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
