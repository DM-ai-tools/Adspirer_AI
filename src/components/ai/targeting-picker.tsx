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
  apiBase?: string;
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

const RADIUS_TYPES = new Set(["city"]);

const PLACEMENT_OPTIONS = [
  { id: "facebook", label: "Facebook" },
  { id: "instagram", label: "Instagram" },
  { id: "audience_network", label: "Audience Network" },
  { id: "messenger", label: "Messenger" },
] as const;

function emptySearchSnapshot(): SearchSnapshot {
  return { searching: false, error: null, options: [], browsed: false };
}

const selectClassName =
  "h-8 w-full rounded-md border border-border bg-card px-2 text-xs text-foreground outline-none focus:border-accent/50 disabled:opacity-50";

function SelectionChip({
  label,
  onRemove,
  disabled,
}: {
  label: string;
  onRemove: () => void;
  disabled?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-accent/10 px-2 py-0.5 text-[11px] text-foreground ring-1 ring-accent/30">
      <span>{label}</span>
      <button
        type="button"
        disabled={disabled}
        onClick={onRemove}
        className="text-muted hover:text-foreground"
        aria-label={`Remove ${label}`}
      >
        ×
      </button>
    </span>
  );
}

export function TargetingPickerCard({
  clientId,
  accountId,
  apiBase = "/api",
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
      `${apiBase}/meta/audiences?${params.toString()}`,
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
  }, [clientId, accountId, apiBase]);

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
        `${apiBase}/meta/targeting/search?${params.toString()}`,
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
  }, [clientId, accountId, apiBase, searchType, trimmedQuery, browsing, skipFetch]);

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
          Add custom audiences, locations, interests, and behaviors. Nothing sends
          until you click <span className="font-medium">Add to message</span> and
          then press Send in the composer.
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
          <div className="space-y-2">
            <select
              disabled={disabled}
              value=""
              onChange={(e) => {
                const id = e.target.value;
                if (!id) return;
                const audience = sortedAudiences.find((a) => a.id === id);
                if (audience) toggleAudience(audience);
              }}
              className={selectClassName}
            >
              <option value="">Select custom audience…</option>
              {sortedAudiences
                .filter((a) => !selectedAudienceIds.has(a.id))
                .map((a) => {
                  const size = formatCount(a.approximate_count);
                  const expired = /expired/i.test(a.delivery_status ?? "");
                  return (
                    <option key={a.id} value={a.id}>
                      {a.name}
                      {a.subtype ? ` · ${a.subtype}` : ""}
                      {expired ? " · expired" : ""}
                      {size ? ` · ~${size}` : ""}
                    </option>
                  );
                })}
            </select>
            {selection.custom_audiences.length ? (
              <div className="flex flex-wrap gap-1.5">
                {selection.custom_audiences.map((a) => (
                  <SelectionChip
                    key={a.id}
                    label={a.name}
                    disabled={disabled}
                    onRemove={() => toggleAudience({ id: a.id, name: a.name })}
                  />
                ))}
              </div>
            ) : null}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-[11px] font-medium text-foreground">
          Detailed targeting
        </p>
        <select
          disabled={disabled}
          value={searchType}
          onChange={(e) => {
            setSearchType(e.target.value as SearchType);
            setQuery("");
            setSearchSnap(emptySearchSnapshot());
          }}
          className={selectClassName}
        >
          <option value="location">Locations</option>
          <option value="interest">Interests</option>
          <option value="behavior">Behaviors</option>
        </select>
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
          <div className="space-y-2">
            {searchSnap.browsed ? (
              <p className="text-[10px] text-muted">
                Common {searchType === "behavior" ? "behaviors" : "interests"}{" "}
                — type above to search all of Meta.
              </p>
            ) : null}
            <select
              disabled={disabled}
              value=""
              onChange={(e) => {
                const id = e.target.value;
                if (!id) return;
                const opt = displayOptions.find((o) => o.id === id);
                if (opt && !isOptionSelected(opt)) toggleOption(opt);
              }}
              className={selectClassName}
            >
              <option value="">
                {searchType === "location"
                  ? "Select location…"
                  : searchType === "behavior"
                    ? "Select behavior…"
                    : "Select interest…"}
              </option>
              {displayOptions
                .filter((opt) => !isOptionSelected(opt))
                .map((opt) => {
                  const size = formatCount(opt.audience_size);
                  const isGeo = searchType === "location";
                  return (
                    <option key={`${opt.type}-${opt.id}`} value={opt.id}>
                      {opt.name}
                      {isGeo && opt.type ? ` · ${opt.type}` : ""}
                      {opt.path ? ` · ${opt.path}` : ""}
                      {size ? ` · ~${size}` : ""}
                    </option>
                  );
                })}
            </select>
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

      {selectedCount > 0 ? (
        <div className="space-y-2 rounded-lg border border-border/70 bg-secondary/20 p-2">
          <p className="text-[11px] font-medium text-foreground">
            Your selections
          </p>
          <div className="flex flex-wrap gap-1.5">
            {selection.custom_audiences.map((a) => (
              <SelectionChip
                key={`aud-${a.id}`}
                label={`Audience: ${a.name}`}
                disabled={disabled}
                onRemove={() => toggleAudience({ id: a.id, name: a.name })}
              />
            ))}
            {selection.locations.map((l) => (
              <SelectionChip
                key={`loc-${l.key ?? l.id ?? l.name}`}
                label={`Location: ${l.name}`}
                disabled={disabled}
                onRemove={() =>
                  toggleOption({
                    id: l.id ?? l.name,
                    name: l.name,
                    key: l.key ?? l.id,
                    type: l.type ?? "city",
                  })
                }
              />
            ))}
            {selection.interests.map((i) => (
              <SelectionChip
                key={`int-${i.id}`}
                label={`Interest: ${i.name}`}
                disabled={disabled}
                onRemove={() =>
                  toggleOption({ id: i.id, name: i.name, type: "interest" })
                }
              />
            ))}
            {selection.behaviors.map((b) => (
              <SelectionChip
                key={`beh-${b.id}`}
                label={`Behavior: ${b.name}`}
                disabled={disabled}
                onRemove={() =>
                  toggleOption({ id: b.id, name: b.name, type: "behavior" })
                }
              />
            ))}
          </div>
        </div>
      ) : null}

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

      <div className="space-y-1.5">
        <p className="text-[11px] font-medium text-foreground">Placements</p>
        <p className="text-[10px] text-muted">
          Leave all unchecked for Advantage+ (Meta chooses). Or pick platforms
          manually.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {PLACEMENT_OPTIONS.map((p) => {
            const selected = selection.publisher_platforms.includes(p.id);
            return (
              <button
                key={p.id}
                type="button"
                disabled={disabled}
                onClick={() =>
                  setSelection((prev) => ({
                    ...prev,
                    publisher_platforms: selected
                      ? prev.publisher_platforms.filter((x) => x !== p.id)
                      : [...prev.publisher_platforms, p.id],
                  }))
                }
                className={cn(
                  "rounded-md px-2 py-1 text-[11px] transition-colors",
                  selected
                    ? "bg-accent/15 text-foreground ring-1 ring-accent/40"
                    : "bg-secondary/40 text-muted hover:bg-secondary/60",
                )}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      </div>

      {selectedCount > 0 || selection.publisher_platforms.length > 0 ? (
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
            selection.publisher_platforms.length
              ? `${selection.publisher_platforms.length} placement${selection.publisher_platforms.length === 1 ? "" : "s"}`
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
          disabled={
            disabled ||
            (selectedCount === 0 && selection.publisher_platforms.length === 0)
          }
          onClick={() => onConfirm(selection)}
        >
          Add to message
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-8"
          disabled={disabled}
          onClick={onSkip}
        >
          Add skip to message
        </Button>
      </div>
    </div>
  );
}
