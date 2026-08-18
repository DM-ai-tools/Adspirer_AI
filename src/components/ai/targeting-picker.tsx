"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import type {
  CampaignTargetingSelection,
  MetaCustomAudience,
  MetaTargetingOption,
} from "@/lib/adspirer/targeting";
import { emptyTargetingSelection } from "@/lib/adspirer/targeting";

type SearchType = "interest" | "behavior" | "location";

type Props = {
  clientId: string;
  accountId?: string | null;
  disabled?: boolean;
  onConfirm: (selection: CampaignTargetingSelection) => void;
  onSkip: () => void;
};

function formatCount(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

type AudienceSnapshot = {
  loading: boolean;
  error: string | null;
  audiences: MetaCustomAudience[];
};

type SearchSnapshot = {
  searching: boolean;
  error: string | null;
  options: MetaTargetingOption[];
  /** True when options came from category browse rather than a query. */
  browsed: boolean;
};

const RADIUS_TYPES = new Set(["city", "region", "zip", "place"]);

function emptySearchSnapshot(): SearchSnapshot {
  return { searching: false, error: null, options: [], browsed: false };
}

export function TargetingPickerCard({
  clientId,
  accountId,
  disabled,
  onConfirm,
  onSkip,
}: Props) {
  const [audienceSnap, setAudienceSnap] = useState<AudienceSnapshot>({
    loading: true,
    error: null,
    audiences: [],
  });

  const [searchType, setSearchType] = useState<SearchType>("location");
  const [query, setQuery] = useState("");
  const [searchSnap, setSearchSnap] =
    useState<SearchSnapshot>(emptySearchSnapshot);

  const [selection, setSelection] = useState<CampaignTargetingSelection>(
    emptyTargetingSelection,
  );

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ clientId });
    if (accountId) params.set("accountId", accountId);
    void apiFetch<{ accountId: string; audiences: MetaCustomAudience[] }>(
      `/api/meta/audiences?${params.toString()}`,
    )
      .then((data) => {
        if (cancelled) return;
        setAudienceSnap({
          loading: false,
          error: null,
          audiences: data.audiences ?? [],
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setAudienceSnap({
          loading: false,
          error:
            err instanceof Error ? err.message : "Failed to load audiences",
          audiences: [],
        });
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, accountId]);

  const trimmedQuery = query.trim();
  const browsing = trimmedQuery.length < 2;
  // Locations have no browsable category — they need a query.
  const skipFetch = browsing && searchType === "location";

  useEffect(() => {
    if (skipFetch) return;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      setSearchSnap((prev) => ({ ...prev, searching: true, error: null }));
      const params = new URLSearchParams({
        clientId,
        searchType,
        query: trimmedQuery,
      });
      if (accountId) params.set("accountId", accountId);
      void apiFetch<{ options: MetaTargetingOption[]; browsed?: boolean }>(
        `/api/meta/targeting/search?${params.toString()}`,
      )
        .then((data) => {
          if (cancelled) return;
          setSearchSnap({
            searching: false,
            error: null,
            options: data.options ?? [],
            browsed: Boolean(data.browsed),
          });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setSearchSnap({
            searching: false,
            error: err instanceof Error ? err.message : "Search failed",
            options: [],
            browsed: false,
          });
        });
    }, browsing ? 0 : 350);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [clientId, accountId, searchType, trimmedQuery, browsing, skipFetch]);

  const displayOptions = skipFetch ? [] : searchSnap.options;

  // Adspirer truncates long audience names, so surface status/size and put
  // usable (non-expired) audiences first to keep look-alikes distinguishable.
  const sortedAudiences = useMemo(() => {
    const rank = (a: MetaCustomAudience) =>
      /expired/i.test(a.delivery_status ?? "") ? 1 : 0;
    return [...audienceSnap.audiences].sort((a, b) => rank(a) - rank(b));
  }, [audienceSnap.audiences]);

  const selectedAudienceIds = useMemo(
    () => new Set(selection.custom_audiences.map((a) => a.id)),
    [selection.custom_audiences],
  );
  const selectedInterestIds = useMemo(
    () => new Set(selection.interests.map((i) => i.id)),
    [selection.interests],
  );
  const selectedBehaviorIds = useMemo(
    () => new Set(selection.behaviors.map((b) => b.id)),
    [selection.behaviors],
  );
  const selectedLocationKeys = useMemo(
    () => new Set(selection.locations.map((l) => l.key ?? l.id ?? l.name)),
    [selection.locations],
  );

  const selectedCount =
    selection.custom_audiences.length +
    selection.interests.length +
    selection.behaviors.length +
    selection.locations.length;

  function toggleAudience(a: MetaCustomAudience) {
    setSelection((prev) => {
      const exists = prev.custom_audiences.some((x) => x.id === a.id);
      return {
        ...prev,
        custom_audiences: exists
          ? prev.custom_audiences.filter((x) => x.id !== a.id)
          : [...prev.custom_audiences, { id: a.id, name: a.name }],
      };
    });
  }

  function toggleOption(opt: MetaTargetingOption) {
    setSelection((prev) => {
      if (searchType === "behavior") {
        const exists = prev.behaviors.some((x) => x.id === opt.id);
        return {
          ...prev,
          behaviors: exists
            ? prev.behaviors.filter((x) => x.id !== opt.id)
            : [...prev.behaviors, { id: opt.id, name: opt.name }],
        };
      }
      if (searchType === "location") {
        const key = opt.key ?? opt.id;
        const exists = prev.locations.some(
          (x) => (x.key ?? x.id ?? x.name) === key,
        );
        const type = (opt.type ?? "city").toLowerCase();
        return {
          ...prev,
          locations: exists
            ? prev.locations.filter((x) => (x.key ?? x.id ?? x.name) !== key)
            : [
                ...prev.locations,
                {
                  id: opt.id,
                  name: opt.name,
                  key,
                  type,
                  country_code: opt.country_code ?? null,
                  // Meta needs a radius for sub-country keys; 25km is its default.
                  radius: RADIUS_TYPES.has(type) ? 25 : null,
                  distance_unit: RADIUS_TYPES.has(type) ? "kilometer" : null,
                },
              ],
        };
      }
      const exists = prev.interests.some((x) => x.id === opt.id);
      return {
        ...prev,
        interests: exists
          ? prev.interests.filter((x) => x.id !== opt.id)
          : [...prev.interests, { id: opt.id, name: opt.name }],
      };
    });
  }

  function setLocationRadius(key: string, radius: number) {
    setSelection((prev) => ({
      ...prev,
      locations: prev.locations.map((l) =>
        (l.key ?? l.id ?? l.name) === key
          ? { ...l, radius, distance_unit: l.distance_unit ?? "kilometer" }
          : l,
      ),
    }));
  }

  function isOptionSelected(opt: MetaTargetingOption): boolean {
    if (searchType === "behavior") return selectedBehaviorIds.has(opt.id);
    if (searchType === "location")
      return selectedLocationKeys.has(opt.key ?? opt.id);
    return selectedInterestIds.has(opt.id);
  }

  return (
    <div className="mt-3 space-y-3 border-t border-border/60 pt-3">
      <div>
        <p className="text-xs font-semibold text-foreground">
          Advanced targeting
        </p>
        <p className="mt-0.5 text-[11px] text-muted">
          Pick locations, custom audiences and detailed targeting by name. Meta
          IDs are applied automatically on create. Skipping means broad
          targeting in the United States.
        </p>
      </div>

      <div className="space-y-2">
        <p className="text-[11px] font-medium text-foreground">
          Custom audiences
        </p>
        {audienceSnap.loading ? (
          <p className="text-[11px] text-muted">Loading audiences…</p>
        ) : audienceSnap.error ? (
          <p className="text-[11px] text-danger">{audienceSnap.error}</p>
        ) : audienceSnap.audiences.length === 0 ? (
          <p className="text-[11px] text-muted">
            No custom audiences found on this ad account.
          </p>
        ) : (
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border/70 bg-secondary/20 p-1.5">
            {sortedAudiences.map((a) => {
              const selected = selectedAudienceIds.has(a.id);
              const size = formatCount(a.approximate_count);
              const expired = /expired/i.test(a.delivery_status ?? "");
              return (
                <button
                  key={a.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => toggleAudience(a)}
                  className={cn(
                    "flex w-full items-start justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[11px] transition-colors",
                    selected
                      ? "bg-accent/15 text-foreground ring-1 ring-accent/40"
                      : "hover:bg-secondary/60 text-muted",
                  )}
                >
                  <span>
                    <span className="font-medium text-foreground">{a.name}</span>
                    {a.subtype ? (
                      <span className="ml-1 text-muted">· {a.subtype}</span>
                    ) : null}
                    {expired ? (
                      <span className="ml-1 text-warning">· expired</span>
                    ) : null}
                  </span>
                  {size ? (
                    <span className="shrink-0 font-mono text-[10px] text-muted">
                      ~{size}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-[11px] font-medium text-foreground">
          Detailed targeting
        </p>
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              ["location", "Locations"],
              ["interest", "Interests"],
              ["behavior", "Behaviors"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              disabled={disabled}
              onClick={() => {
                setSearchType(value);
                setQuery("");
                setSearchSnap(emptySearchSnapshot());
              }}
              className={cn(
                "rounded-md border px-2 py-1 text-[11px]",
                searchType === value
                  ? "border-accent/50 bg-accent/10 text-foreground"
                  : "border-border text-muted hover:border-accent/30",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          type="search"
          value={query}
          disabled={disabled}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            searchType === "location"
              ? "Search cities, regions, countries…"
              : searchType === "behavior"
                ? "Search behaviors…"
                : "Search interests…"
          }
          className="h-8 w-full rounded-md border border-border bg-card px-2 text-xs text-foreground outline-none placeholder:text-muted focus:border-accent/50"
        />
        {searchSnap.searching ? (
          <p className="text-[11px] text-muted">
            {browsing ? "Loading options…" : "Searching…"}
          </p>
        ) : searchSnap.error ? (
          <p className="text-[11px] text-danger">{searchSnap.error}</p>
        ) : displayOptions.length ? (
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border/70 bg-secondary/20 p-1.5">
            {searchSnap.browsed ? (
              <p className="px-2 pb-1 text-[10px] text-muted">
                Common {searchType === "behavior" ? "behaviors" : "interests"} —
                type to search all of Meta.
              </p>
            ) : null}
            {displayOptions.map((opt) => {
              const selected = isOptionSelected(opt);
              const size = formatCount(opt.audience_size);
              const isGeo = searchType === "location";
              return (
                <button
                  key={`${opt.type}-${opt.id}`}
                  type="button"
                  disabled={disabled}
                  onClick={() => toggleOption(opt)}
                  className={cn(
                    "flex w-full items-start justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[11px] transition-colors",
                    selected
                      ? "bg-accent/15 text-foreground ring-1 ring-accent/40"
                      : "hover:bg-secondary/60 text-muted",
                  )}
                >
                  <span>
                    <span className="font-medium text-foreground">
                      {opt.name}
                    </span>
                    {isGeo && opt.type ? (
                      <span className="ml-1 text-muted">· {opt.type}</span>
                    ) : null}
                    {opt.path ? (
                      <span className="mt-0.5 block text-[10px] text-muted">
                        {opt.path}
                      </span>
                    ) : null}
                  </span>
                  {size ? (
                    <span className="shrink-0 font-mono text-[10px] text-muted">
                      ~{size}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : skipFetch ? (
          <p className="text-[11px] text-muted">
            Search a country, city, region or postcode. If you skip locations,
            Meta defaults to the United States.
          </p>
        ) : (
          <p className="text-[11px] text-muted">No matches.</p>
        )}
      </div>

      {selection.locations.length ? (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium text-foreground">
            Selected locations
          </p>
          {selection.locations.map((l) => {
            const key = l.key ?? l.id ?? l.name;
            const needsRadius = RADIUS_TYPES.has((l.type ?? "").toLowerCase());
            return (
              <div
                key={key}
                className="flex items-center justify-between gap-2 text-[11px]"
              >
                <span className="text-foreground">
                  {l.name}
                  {l.type ? (
                    <span className="ml-1 text-muted">· {l.type}</span>
                  ) : null}
                </span>
                {needsRadius ? (
                  <label className="flex shrink-0 items-center gap-1 text-muted">
                    <input
                      type="number"
                      min={1}
                      max={80}
                      value={l.radius ?? 25}
                      disabled={disabled}
                      onChange={(e) =>
                        setLocationRadius(key, Number(e.target.value) || 25)
                      }
                      className="h-6 w-14 rounded border border-border bg-card px-1 text-right text-[11px] text-foreground outline-none focus:border-accent/50"
                    />
                    km radius
                  </label>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {selectedCount > 0 ? (
        <p className="text-[11px] text-muted">
          Selected:{" "}
          {[
            selection.custom_audiences.length
              ? `${selection.custom_audiences.length} audience${selection.custom_audiences.length === 1 ? "" : "s"}`
              : null,
            selection.interests.length
              ? `${selection.interests.length} interest${selection.interests.length === 1 ? "" : "s"}`
              : null,
            selection.behaviors.length
              ? `${selection.behaviors.length} behavior${selection.behaviors.length === 1 ? "" : "s"}`
              : null,
            selection.locations.length
              ? `${selection.locations.length} location${selection.locations.length === 1 ? "" : "s"}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          className="h-8"
          disabled={disabled || selectedCount === 0}
          onClick={() => onConfirm(selection)}
        >
          Use selected targeting
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-8"
          disabled={disabled}
          onClick={onSkip}
        >
          Skip advanced targeting
        </Button>
      </div>
    </div>
  );
}
