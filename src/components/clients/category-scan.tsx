"use client";

import { useState } from "react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api-client";
import { filterScanCandidates, scanUnavailableMessage, type ScanCandidate } from "@/lib/clients/category-form";
import type { ClientService } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

type Candidate = ScanCandidate;

/** "Scan website": lists discovered candidates and adds the ticked ones. */
export function CategoryScan({
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
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  /** Set when the scan couldn't run: the reason the route gave ("no_website", …). */
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const view = filterScanCandidates(candidates ?? [], query);

  async function scan() {
    setBusy(true);
    try {
      const data = await apiFetch<{ candidates: Candidate[]; source: string; reason?: string }>(
        `/api/clients/${clientId}/services/discover`,
      );
      setCandidates(data.candidates);
      setUnavailable(data.source === "unavailable" ? (data.reason ?? "unknown") : null);
      setPicked(new Set());
      setQuery("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Scan failed");
    } finally {
      setBusy(false);
    }
  }

  async function addSelected() {
    setBusy(true);
    let added = 0;
    let failed = 0;
    for (const c of candidates ?? []) {
      if (!picked.has(c.name)) continue;
      try {
        await apiFetch<{ service: ClientService }>(`/api/clients/${clientId}/services`, {
          method: "POST",
          body: JSON.stringify({ name: c.name, landing_page_url: c.landing_page_url, source: "site_scan" }),
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
      <Button type="button" variant="outline" onClick={() => void scan()} disabled={busy}>
        {busy && !candidates ? "Scanning…" : "Scan website"}
      </Button>
      {candidates ? (
        <div className="space-y-2 rounded-lg border border-border-subtle p-3">
          {unavailable ? (
            <p className="text-sm text-muted">{scanUnavailableMessage(unavailable, words)}</p>
          ) : candidates.length === 0 ? (
            <p className="text-sm text-muted">No {word} candidates found on the site.</p>
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
                <label key={c.name} className="flex items-center gap-2 text-sm">
                  <Checkbox
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
                  <span className={c.alreadyAdded ? "text-muted" : undefined}>{c.name}</span>
                  {c.alreadyAdded ? <span className="text-xs text-muted">already added</span> : null}
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
