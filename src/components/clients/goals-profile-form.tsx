"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { Client } from "@/types";
import { apiFetch } from "@/lib/api-client";
import {
  ATTRIBUTION_SETTINGS,
  BUSINESS_MODELS,
  GOALS_DEFAULTS,
  SPECIAL_AD_CATEGORIES,
  goalsFormValues,
  goalsProfileFromForm,
} from "@/lib/clients/goals";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const selectClassName =
  "flex h-9 w-full rounded-lg border border-border bg-input px-3 py-1 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

const BUSINESS_LABEL: Record<(typeof BUSINESS_MODELS)[number], string> = {
  ecommerce: "E-commerce",
  lead_gen: "Lead generation",
  local_service: "Local service",
  b2b: "B2B",
  other: "Other",
};
const ATTRIBUTION_LABEL: Record<(typeof ATTRIBUTION_SETTINGS)[number], string> = {
  "7d_click_1d_view": "7-day click, 1-day view",
  "7d_click": "7-day click",
  "1d_click": "1-day click",
};
const CATEGORY_LABEL: Record<(typeof SPECIAL_AD_CATEGORIES)[number], string> = {
  NONE: "None",
  HOUSING: "Housing",
  EMPLOYMENT: "Employment",
  CREDIT: "Credit",
  FINANCIAL_PRODUCTS_SERVICES: "Financial products and services",
};

function Field(props: {
  name: string;
  label: string;
  hint?: string;
  defaultValue?: string;
  type?: string;
  step?: string;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={`goals-${props.name}`}>{props.label}</Label>
      <Input
        id={`goals-${props.name}`}
        name={props.name}
        type={props.type ?? "text"}
        step={props.step}
        inputMode={props.type === "number" ? "decimal" : undefined}
        placeholder={props.placeholder}
        defaultValue={props.defaultValue ?? ""}
      />
      {props.hint ? <p className="text-xs text-muted">{props.hint}</p> : null}
    </div>
  );
}

function SelectField<T extends string>(props: {
  name: string;
  label: string;
  options: readonly T[];
  labels: Record<T, string>;
  defaultValue?: string;
  emptyLabel: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={`goals-${props.name}`}>{props.label}</Label>
      <select
        id={`goals-${props.name}`}
        name={props.name}
        defaultValue={props.defaultValue ?? ""}
        className={selectClassName}
      >
        <option value="">{props.emptyLabel}</option>
        {props.options.map((o) => (
          <option key={o} value={o}>
            {props.labels[o]}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Targets and guardrails every audit, optimisation and approval measures
 * against. Blank fields use the defaults shown as placeholders.
 */
export function GoalsProfileForm({
  client,
  onSaved,
}: {
  client: Client;
  onSaved: (client: Client) => void;
}) {
  const [saving, setSaving] = useState(false);
  const values = goalsFormValues(client.goals_profile ?? {});
  const currency = client.currency || "USD";
  const policy = GOALS_DEFAULTS.policy;

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    const form = new FormData(e.currentTarget);
    const raw: Record<string, string> = {};
    form.forEach((v, k) => {
      raw[k] = String(v);
    });
    try {
      const data = await apiFetch<{ client: Client }>(`/api/clients/${client.id}`, {
        method: "PATCH",
        body: JSON.stringify({ goals_profile: goalsProfileFromForm(raw) }),
      });
      onSaved(data.client);
      toast.success("Goals and guardrails saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save goals");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Goals and guardrails</CardTitle>
        <p className="text-sm text-muted">
          Audits, budget recommendations and approvals are judged against these. Blank fields use the
          default shown.
        </p>
      </CardHeader>
      <CardContent>
        <form className="space-y-6" onSubmit={save}>
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-foreground">Targets</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                name="business_model"
                label="Business model"
                options={BUSINESS_MODELS}
                labels={BUSINESS_LABEL}
                defaultValue={values.business_model}
                emptyLabel="Not set"
              />
              <Field
                name="optimisation_event"
                label="Optimisation event"
                hint="The result campaigns optimise for, e.g. LEAD, PURCHASE, COMPLETE_REGISTRATION."
                defaultValue={values.optimisation_event}
              />
              <Field name="target_cpa" label={`Target cost per result (${currency})`} type="number" step="0.01" defaultValue={values.target_cpa} />
              <Field name="target_roas" label="Target ROAS" type="number" step="0.01" placeholder="e.g. 3" defaultValue={values.target_roas} />
              <Field name="average_value" label={`Average order or lead value (${currency})`} type="number" step="0.01" defaultValue={values.average_value} />
              <Field name="gross_margin_pct" label="Gross margin (%)" type="number" step="0.1" defaultValue={values.gross_margin_pct} />
              <SelectField
                name="attribution"
                label="Attribution setting"
                options={ATTRIBUTION_SETTINGS}
                labels={ATTRIBUTION_LABEL}
                defaultValue={values.attribution}
                emptyLabel={`Default (${ATTRIBUTION_LABEL[GOALS_DEFAULTS.attribution]})`}
              />
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-foreground">Budget guardrails</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                name="daily_account_cap"
                label={`Daily account cap (${currency})`}
                hint="All live daily budgets on the account together may not exceed this."
                type="number"
                step="0.01"
                defaultValue={values.daily_account_cap}
              />
              <Field
                name="max_budget_change_pct"
                label="Max budget increase per approval (%)"
                hint="Larger increases are high risk and need an admin."
                type="number"
                placeholder={String(GOALS_DEFAULTS.max_budget_change_pct)}
                defaultValue={values.max_budget_change_pct}
              />
              <Field name="monthly_cap" label={`Monthly spend cap (${currency})`} type="number" step="0.01" defaultValue={values.monthly_cap} />
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-foreground">Compliance</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                name="allowed_countries"
                label="Allowed countries"
                hint="2-letter codes, comma-separated, e.g. AU, NZ."
                defaultValue={values.allowed_countries}
              />
              <SelectField
                name="special_ad_category"
                label="Special Ad Category"
                options={SPECIAL_AD_CATEGORIES}
                labels={CATEGORY_LABEL}
                defaultValue={values.special_ad_category}
                emptyLabel="Not set"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="goals-compliance_notes">Compliance notes</Label>
              <Textarea id="goals-compliance_notes" name="compliance_notes" defaultValue={values.compliance_notes ?? ""} />
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-foreground">Decision rules</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field name="scale_step_pct" label="Scale step (%)" type="number" placeholder={String(policy.scale_step_pct)} defaultValue={values.scale_step_pct} />
              <Field
                name="kill_multiple"
                label="Pause after spend of (× target cost) with no results"
                type="number"
                step="0.1"
                placeholder={String(policy.kill_multiple)}
                defaultValue={values.kill_multiple}
              />
              <Field name="min_days_of_data" label="Minimum days of data" type="number" placeholder={String(policy.min_days_of_data)} defaultValue={values.min_days_of_data} />
              <Field
                name="prospecting_frequency_max"
                label="Max 7-day frequency, prospecting"
                type="number"
                step="0.1"
                placeholder={String(policy.prospecting_frequency_max)}
                defaultValue={values.prospecting_frequency_max}
              />
              <Field
                name="retargeting_frequency_max"
                label="Max 7-day frequency, retargeting"
                type="number"
                step="0.1"
                placeholder={String(policy.retargeting_frequency_max)}
                defaultValue={values.retargeting_frequency_max}
              />
            </div>
          </section>

          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save goals and guardrails"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
