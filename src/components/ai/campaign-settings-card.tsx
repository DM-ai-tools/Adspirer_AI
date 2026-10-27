"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api-client";
import type { CampaignOptions } from "@/lib/meta/campaign-options";
import {
  META_CONVERSION_EVENTS,
  type BudgetLevel,
  type CampaignSettings,
} from "@/lib/meta/campaign-rules";
import { applyChange, canConfirm } from "@/lib/meta/campaign-settings-state";

type Labels = Partial<Record<keyof CampaignSettings, string>>;

type Props = {
  clientId: string;
  accountId?: string | null;
  objective: string;
  stated?: Partial<CampaignSettings>;
  apiBase?: string;
  disabled?: boolean;
  onConfirm: (settings: CampaignSettings, labels: Labels) => void;
  onSkip: () => void;
};

const selectClassName =
  "h-8 w-full rounded-md border border-border bg-card px-2 text-xs text-foreground outline-none focus:border-accent/50 disabled:opacity-50";
const inputClassName =
  "h-8 w-20 rounded-md border border-border bg-card px-2 text-xs text-foreground outline-none focus:border-accent/50 disabled:opacity-50";

const BUDGET_LEVELS: { id: BudgetLevel; label: string; description: string }[] = [
  {
    id: "campaign",
    label: "Campaign budget",
    description: "One budget for the whole campaign; Meta shifts spend to the best ad set.",
  },
  {
    id: "ad_set",
    label: "Ad set budget",
    description: "You set the budget on each ad set for tighter control.",
  },
];

function toMetaEvent(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, "$1_$2").replace(/[\s-]+/g, "_").toUpperCase();
}

function FieldShell(props: {
  label: string;
  description: string;
  reason?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-semibold text-foreground">{props.label}</p>
      {props.children}
      <p className="text-[11px] text-muted">{props.description}</p>
      {props.reason ? (
        <p className="text-[11px] text-accent">Suggested: {props.reason}</p>
      ) : null}
    </div>
  );
}

function CheckList(props: {
  options: { id: string; label: string }[];
  value: string[];
  disabled?: boolean;
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {props.options.map((option) => (
        <label key={option.id} className="flex items-center gap-1.5 text-xs text-foreground">
          <input
            type="checkbox"
            checked={props.value.includes(option.id)}
            disabled={props.disabled}
            onChange={(event) =>
              props.onChange(
                event.target.checked
                  ? [...props.value, option.id]
                  : props.value.filter((v) => v !== option.id),
              )
            }
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}

export function CampaignSettingsCard({
  clientId,
  accountId,
  objective,
  stated,
  apiBase = "/api",
  disabled,
  onConfirm,
  onSkip,
}: Props) {
  const [options, setOptions] = useState<CampaignOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settings, setSettings] = useState<CampaignSettings>({});

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ clientId, objective });
    if (accountId) params.set("accountId", accountId);
    if (stated && Object.keys(stated).length) params.set("stated", JSON.stringify(stated));
    apiFetch<CampaignOptions>(`${apiBase}/meta/campaign-options?${params.toString()}`)
      .then((loaded) => {
        if (cancelled) return;
        setOptions(loaded);
        setSettings(loaded.suggestion.settings);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "Couldn't load options");
      });
    return () => {
      cancelled = true;
    };
    // `stated` is a fresh object per render of the parent; its content is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, accountId, objective, apiBase, JSON.stringify(stated ?? {})]);

  const verdict = useMemo(
    () => (options ? canConfirm(settings, options) : null),
    [options, settings],
  );

  if (loadError) {
    return (
      <div className="mt-3 space-y-2 border-t border-border/60 pt-3">
        <p className="text-xs font-semibold text-foreground">Campaign settings</p>
        <p className="text-[11px] text-danger">{loadError}</p>
        <Button type="button" size="sm" variant="secondary" className="h-8" onClick={onSkip} disabled={disabled}>
          Skip — use defaults
        </Button>
      </div>
    );
  }
  if (!options) {
    return (
      <div className="mt-3 flex items-center gap-2 border-t border-border/60 pt-3 text-[11px] text-muted" role="status">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading campaign settings from Meta…
      </div>
    );
  }

  const set = (change: Partial<CampaignSettings>) =>
    setSettings((current) => applyChange(current, change, options));
  const reason = (key: keyof CampaignSettings) =>
    options.suggestion.settings[key] !== undefined &&
    JSON.stringify(options.suggestion.settings[key]) === JSON.stringify(settings[key])
      ? options.suggestion.reasons[key]
      : undefined;

  const locations = options.conversionLocations;
  const goals = options.performanceGoals[settings.conversion_location ?? (locations.length ? "" : "none")] ?? [];
  const goal = goals.find((g) => g.id === settings.optimization_goal);
  const attributionOptions = goal ? (options.attribution[goal.id] ?? []) : [];
  // Only events Meta accepts as a conversion; the chosen pixel's own events when it has any.
  const selectedPixel = options.pixels.find((p) => p.id === settings.pixel_id);
  const pixelEvents = [
    ...new Set(
      (selectedPixel?.events ?? options.pixels.flatMap((p) => p.events))
        .map(toMetaEvent)
        .filter((e) => (META_CONVERSION_EVENTS as readonly string[]).includes(e)),
    ),
  ];
  const eventChoices = [
    ...new Set([
      ...(pixelEvents.length ? pixelEvents : META_CONVERSION_EVENTS),
      ...(settings.pixel_event_name ? [settings.pixel_event_name] : []),
    ]),
  ];
  const failedLookups = [
    ...new Set(
      options.warnings
        .map((w) => /Couldn't load (.+?) from Meta/.exec(w)?.[1])
        .filter((x): x is string => Boolean(x)),
    ),
  ];
  const platforms = settings.publisher_platforms ?? [];
  const lockedLocation = locations.find((l) => l.id === settings.conversion_location);

  const labels: Labels = {
    budget_level: BUDGET_LEVELS.find((b) => b.id === settings.budget_level)?.label,
    conversion_location: lockedLocation?.label,
    optimization_goal: goal?.label,
    attribution: attributionOptions.find((a) => a.id === settings.attribution)?.label,
    pixel_id: selectedPixel?.name,
    lead_form_id: options.leadForms.find((f) => f.id === settings.lead_form_id)?.name,
  };

  const confirm = () => {
    const finished = { ...settings };
    onConfirm(finished, labels);
  };

  return (
    <div className="mt-3 space-y-3 border-t border-border/60 pt-3">
      <p className="text-xs font-semibold text-foreground">Campaign settings</p>
      <p className="text-[11px] text-muted">
        Pre-filled from your objective and what this ad account has. Change anything, then add it to your message.
      </p>

      {options.warnings.length ? (
        <p
          className="rounded-md border border-border/60 bg-secondary/40 p-2 text-[11px] text-muted"
          role="status"
          title={options.warnings.join("\n")}
        >
          Couldn&apos;t load {failedLookups.join(", ") || "some options"} from Meta (your Facebook connection may need
          refreshing). You can keep going; Meta&apos;s requirements are checked again when the campaign is created.
        </p>
      ) : null}

      <FieldShell
        label="Budget level"
        description={BUDGET_LEVELS.find((b) => b.id === settings.budget_level)?.description ?? "Where the budget is set."}
        reason={reason("budget_level")}
      >
        <select
          className={selectClassName}
          value={settings.budget_level ?? ""}
          disabled={disabled}
          onChange={(e) => set({ budget_level: (e.target.value || undefined) as BudgetLevel | undefined })}
        >
          {BUDGET_LEVELS.map((b) => (
            <option key={b.id} value={b.id}>{b.label}</option>
          ))}
        </select>
      </FieldShell>

      {locations.length ? (
        <FieldShell
          label="Conversion location"
          description={lockedLocation?.description ?? "Where people take the action you want."}
          reason={reason("conversion_location")}
        >
          <select
            className={selectClassName}
            value={settings.conversion_location ?? ""}
            disabled={disabled}
            onChange={(e) => set({ conversion_location: e.target.value as CampaignSettings["conversion_location"] })}
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id} disabled={!l.supported}>
                {l.label}
                {l.supported ? "" : ` — ${l.unsupportedReason ?? "not supported yet"}`}
              </option>
            ))}
          </select>
        </FieldShell>
      ) : null}

      <FieldShell
        label="Performance goal"
        description={goal?.description ?? "What Meta optimises delivery for."}
        reason={reason("optimization_goal")}
      >
        <select
          className={selectClassName}
          value={settings.optimization_goal ?? ""}
          disabled={disabled || !goals.length}
          onChange={(e) => set({ optimization_goal: e.target.value as CampaignSettings["optimization_goal"] })}
        >
          {goals.map((g) => (
            <option key={g.id} value={g.id}>{g.label}</option>
          ))}
        </select>
      </FieldShell>

      {goal?.needsEvent ? (
        <FieldShell
          label="Conversion event"
          description={
            options.pixels.length
              ? "The pixel event that counts as a result. Events seen on your pixel in the last 7 days are listed."
              : "The pixel event that counts as a result. This account has no pixel yet."
          }
          reason={reason("pixel_event_name")}
        >
          <select
            className={selectClassName}
            value={settings.pixel_event_name ?? ""}
            disabled={disabled}
            onChange={(e) => set({ pixel_event_name: e.target.value })}
          >
            {eventChoices.map((event) => (
              <option key={event} value={event}>{event}</option>
            ))}
          </select>
        </FieldShell>
      ) : null}

      {goal?.needsEvent && options.pixels.length ? (
        <FieldShell
          label="Pixel"
          description="The Meta pixel that measures this conversion event."
          reason={reason("pixel_id")}
        >
          <select
            className={selectClassName}
            value={settings.pixel_id ?? ""}
            disabled={disabled}
            onChange={(e) => set({ pixel_id: e.target.value })}
          >
            {options.pixels.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </FieldShell>
      ) : null}

      {settings.conversion_location === "instant_form" && options.leadForms.length ? (
        <FieldShell
          label="Lead form"
          description="The instant form people fill in. Only active forms on your Pages are listed."
          reason={reason("lead_form_id")}
        >
          <select
            className={selectClassName}
            value={settings.lead_form_id ?? ""}
            disabled={disabled}
            onChange={(e) => set({ lead_form_id: e.target.value })}
          >
            {options.leadForms.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        </FieldShell>
      ) : null}

      {attributionOptions.length ? (
        <FieldShell
          label="Attribution"
          description={attributionOptions.find((a) => a.id === settings.attribution)?.description ?? "How long after an ad interaction a conversion counts."}
          reason={reason("attribution")}
        >
          <select
            className={selectClassName}
            value={settings.attribution ?? ""}
            disabled={disabled}
            onChange={(e) => set({ attribution: e.target.value as CampaignSettings["attribution"] })}
          >
            {attributionOptions.map((a) => (
              <option key={a.id} value={a.id}>{a.label}</option>
            ))}
          </select>
        </FieldShell>
      ) : null}

      <FieldShell
        label="Age range"
        description="Meta allows 18 to 65. A minimum above 25 or a maximum below 65 turns Advantage+ audience off."
      >
        <div className="flex items-center gap-2 text-xs text-muted">
          <input
            type="number"
            min={18}
            max={65}
            className={inputClassName}
            value={settings.age_min ?? ""}
            placeholder="18"
            disabled={disabled}
            onChange={(e) => set({ age_min: e.target.value ? Number(e.target.value) : undefined })}
          />
          to
          <input
            type="number"
            min={18}
            max={65}
            className={inputClassName}
            value={settings.age_max ?? ""}
            placeholder="65"
            disabled={disabled}
            onChange={(e) => set({ age_max: e.target.value ? Number(e.target.value) : undefined })}
          />
        </div>
      </FieldShell>

      <details className="rounded-md border border-border/60 p-2">
        <summary className="cursor-pointer text-[11px] font-semibold text-foreground">
          Advanced placements — platform, placement, device, OS
        </summary>
        <div className="mt-2 space-y-3">
          <FieldShell
            label="Platforms"
            description="Leave all unticked for Advantage+ placements, where Meta picks the best places."
          >
            <CheckList
              options={options.placements.map((p) => ({ id: p.platform, label: p.label }))}
              value={platforms}
              disabled={disabled}
              onChange={(next) => set({ publisher_platforms: next })}
            />
          </FieldShell>

          {options.placements
            .filter((p) => (p.platform === "facebook" || p.platform === "instagram") && platforms.includes(p.platform))
            .map((p) => {
              const key = p.platform === "facebook" ? "facebook_positions" : "instagram_positions";
              return (
                <FieldShell key={p.platform} label={`${p.label} placements`} description={p.description}>
                  <CheckList
                    options={p.positions.map((pos) => ({ id: pos.id, label: pos.label }))}
                    value={settings[key] ?? []}
                    disabled={disabled}
                    onChange={(next) => set({ [key]: next.length ? next : undefined })}
                  />
                </FieldShell>
              );
            })}

          <FieldShell label="Device type" description="Limit delivery to phones or computers. Leave both off for all devices.">
            <CheckList
              options={[{ id: "mobile", label: "Mobile" }, { id: "desktop", label: "Desktop" }]}
              value={settings.device_platforms ?? []}
              disabled={disabled}
              onChange={(next) => set({ device_platforms: next.length ? (next as ("mobile" | "desktop")[]) : undefined })}
            />
          </FieldShell>

          <FieldShell label="Operating system" description="Limit delivery to people on specific operating systems.">
            <CheckList
              options={options.osList.map((o) => ({ id: o.id, label: o.name }))}
              value={settings.user_os ?? []}
              disabled={disabled}
              onChange={(next) => set({ user_os: next.length ? next : undefined })}
            />
          </FieldShell>

          <FieldShell label="Device models" description="Limit delivery to specific device models.">
            <div className="max-h-28 overflow-y-auto pr-1">
              <CheckList
                options={options.devices.map((d) => ({ id: d.id, label: d.name }))}
                value={settings.user_device ?? []}
                disabled={disabled}
                onChange={(next) => set({ user_device: next.length ? next : undefined })}
              />
            </div>
          </FieldShell>
        </div>
      </details>

      {verdict && !verdict.ok ? (
        <p className="text-[11px] text-danger" role="alert">{verdict.error}</p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" className="h-8" disabled={disabled || !verdict?.ok} onClick={confirm}>
          Add to message
        </Button>
        <Button type="button" size="sm" variant="secondary" className="h-8" disabled={disabled} onClick={onSkip}>
          Skip — use defaults
        </Button>
      </div>
    </div>
  );
}
