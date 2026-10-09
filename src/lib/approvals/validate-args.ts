import type { Client } from "@/types";
import { ApprovalValidationError, isAppError } from "@/lib/errors";
import { getExecuteToolSchema } from "@/lib/tools/execute/schemas";
import { normalizeMetaApprovalArgs } from "@/lib/meta/normalize-approval-args";
import { normalizeCreateAdArgs } from "@/lib/meta/resolve-ad-set";
import {
  MISSING_LOCATION_MESSAGE,
  hasTargetingLocation,
  normalizeCallToAction,
} from "@/lib/meta/targeting-builder";
import {
  assertWithinBudgetCeiling,
  computeBudgetImpactCents,
} from "@/lib/approvals/validator";

/** Internal bookkeeping keys (`__provider_backend`, `__account_currency`, `_notes`). */
function isInternalKey(key: string): boolean {
  return key.startsWith("_");
}

const CREATE_TOOLS = new Set([
  "create_campaign",
  "create_meta_image_campaign",
  "create_meta_video_campaign",
  "create_adset",
  "create_ad",
]);

/** Create tools whose ad set needs a targeting location. */
const NEEDS_LOCATION = new Set([
  "create_meta_image_campaign",
  "create_meta_video_campaign",
  "create_adset",
]);

/**
 * Fields Meta supports but this executor does not build yet. They used to be
 * forwarded and silently dropped; now the proposal is rejected so nobody
 * believes e.g. a spend cap was applied when it was not.
 */
const UNSUPPORTED_KEYS: Record<string, string> = {
  multi_advertiser: "multi-advertiser ads opt-in",
  advantage_plus_creative: "Advantage+ creative enhancements",
  disabled_creative_features: "Advantage+ creative feature opt-outs",
  primary_texts: "multiple primary texts (dynamic creative)",
  headlines: "multiple headlines (dynamic creative)",
  descriptions: "multiple descriptions (dynamic creative)",
  story_image_url: "a separate Stories image",
  right_column_image_url: "a separate right-column image",
  daily_min_spend_target: "ad set minimum daily spend",
  daily_spend_cap: "ad set daily spend cap",
  custom_conversion_id: "custom conversion optimisation",
};

/** Numeric args and whether they must be whole numbers. */
const NUMERIC_KEYS: Record<string, "int" | "decimal"> = {
  daily_budget_cents: "int",
  previous_daily_budget_cents: "int",
  budget_daily: "decimal",
  daily_budget: "decimal",
  budget_lifetime: "decimal",
  age_min: "int",
  age_max: "int",
};

const BOOLEAN_KEYS = ["campaign_budget_optimization"];

function fail(message: string, details?: Record<string, unknown>): never {
  throw new ApprovalValidationError(message, details);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeActId(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("act_") ? trimmed : `act_${trimmed}`;
}

/**
 * Coerce "5500" → 5500 for the numeric args. Anything that is not a plain
 * number (e.g. "$55", "55 dollars", "1e9") is rejected rather than guessed.
 */
function coerceNumbers(toolName: string, args: Record<string, unknown>): void {
  for (const [key, kind] of Object.entries(NUMERIC_KEYS)) {
    const raw = args[key];
    if (raw == null) continue;
    if (typeof raw === "string") {
      if (!raw.trim()) {
        delete args[key];
        continue;
      }
      if (!/^\s*-?\d+(\.\d+)?\s*$/.test(raw)) {
        fail(`${toolName}: ${key} must be a plain number, got "${raw}".`, {
          field: key,
        });
      }
      args[key] = Number(raw);
    } else if (typeof raw !== "number" || !Number.isFinite(raw)) {
      fail(`${toolName}: ${key} must be a number.`, { field: key });
    }
    const n = args[key] as number;
    if (kind === "int" && !Number.isInteger(n)) {
      fail(
        `${toolName}: ${key} must be a whole number${key.endsWith("_cents") ? " of cents" : ""}, got ${n}.`,
        { field: key },
      );
    }
  }
  for (const key of BOOLEAN_KEYS) {
    const raw = args[key];
    if (typeof raw === "string") {
      const v = raw.trim().toLowerCase();
      if (v === "true") args[key] = true;
      else if (v === "false") args[key] = false;
    }
  }
}

/**
 * Fill create_adset fields older approvals left out. A missing landing page
 * is left missing so the schema reports it (a URL is never invented).
 */
export function normalizeCreateAdSetArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const name = optionalString(args.name) ?? "Ad Set";
  const landing =
    optionalString(args.landing_page_url) ??
    optionalString(args.website_url) ??
    optionalString(args.url) ??
    optionalString(args.landing_url);
  const primary = optionalString(args.primary_text) ?? `${name} — Learn more.`;

  return {
    ...args,
    name,
    ad_type: args.ad_type ?? "image",
    primary_text: primary,
    ...(landing ? { landing_page_url: landing } : {}),
    headline: optionalString(args.headline) ?? name.slice(0, 40),
  };
}

function canonicalize(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  let args = normalizeMetaApprovalArgs(toolName, { ...input });

  const account =
    optionalString(args.account_id) ?? optionalString(args.ad_account_id);
  if (account) args.account_id = normalizeActId(account);
  delete args.ad_account_id;

  if (
    (toolName === "create_meta_image_campaign" ||
      toolName === "create_meta_video_campaign") &&
    !optionalString(args.campaign_name) &&
    optionalString(args.name)
  ) {
    args.campaign_name = optionalString(args.name);
  }
  if (toolName === "create_campaign" && !optionalString(args.name)) {
    const name = optionalString(args.campaign_name);
    if (name) args.name = name;
  }
  if (typeof args.objective === "string") {
    args.objective = args.objective.trim().toUpperCase();
  }
  if (toolName === "create_adset") args = normalizeCreateAdSetArgs(args);
  if (toolName === "create_ad") args = normalizeCreateAdArgs(args);

  coerceNumbers(toolName, args);

  // create_campaign budgets are cents; accept a major-unit budget too.
  if (toolName === "create_campaign" && args.daily_budget_cents == null) {
    const major =
      typeof args.budget_daily === "number"
        ? args.budget_daily
        : typeof args.daily_budget === "number"
          ? args.daily_budget
          : undefined;
    if (major != null) args.daily_budget_cents = Math.round(major * 100);
    delete args.budget_daily;
    delete args.daily_budget;
  }

  if (args.call_to_action != null) {
    try {
      const cta = normalizeCallToAction(args.call_to_action);
      if (cta) args.call_to_action = cta;
      else delete args.call_to_action;
    } catch (error) {
      fail(error instanceof Error ? error.message : "Invalid call_to_action", {
        field: "call_to_action",
      });
    }
  }
  return args;
}

type Issue = { path: PropertyKey[]; message: string };

function valueAt(args: Record<string, unknown>, path: PropertyKey[]): unknown {
  let cur: unknown = args;
  for (const key of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key as string];
  }
  return cur;
}

/** A required value that is simply absent (vs. present but wrong). */
function isMissing(args: Record<string, unknown>, issue: Issue): boolean {
  if (!issue.path.length) return true; // cross-field "provide X or Y" checks
  const value = valueAt(args, issue.path);
  return value === undefined || value === null || value === "";
}

function formatIssues(
  args: Record<string, unknown>,
  issues: ReadonlyArray<Issue>,
): string {
  return issues
    .slice(0, 6)
    .map((issue) => {
      const field = issue.path.map(String).join(".");
      if (field && isMissing(args, issue) && !/required|provide|requires/i.test(issue.message)) {
        return `${field} is required`;
      }
      return field ? `${field}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

export type MappedAccount = {
  meta_account_id: string;
  access_status: string;
  currency: string | null;
};

export type PreparedApprovalArgs = {
  args: Record<string, unknown>;
  budgetImpactCents: number | null;
  /**
   * Only with `allowIncomplete`: required values that are still missing. The
   * approval can be queued (flagged "needs fix") but cannot execute until an
   * edit supplies them.
   */
  incomplete: string | null;
};

/**
 * The single gate for approval args: used when an approval is proposed, when
 * it is edited, and again right before execution. Canonicalises aliases,
 * coerces numeric strings, validates against the execute tool's zod schema,
 * checks the account is one of the client's granted Meta accounts, and
 * enforces the client budget ceiling on the coerced values.
 */
export async function prepareApprovalArgs(input: {
  toolName: string;
  clientId: string;
  args: Record<string, unknown>;
  client?: Pick<Client, "id" | "budget_ceiling_cents" | "currency"> | null;
  /**
   * Proposal time only: queue an approval whose only problem is missing
   * required values (e.g. a creative queued for the operator to add a budget
   * and location). Wrong values are always rejected.
   */
  allowIncomplete?: boolean;
  /** Injected for tests; defaults to the client's mapped Meta accounts. */
  loadAccounts?: (clientId: string) => Promise<MappedAccount[]>;
}): Promise<PreparedApprovalArgs> {
  const { toolName } = input;
  const schema = getExecuteToolSchema(toolName);
  if (!schema) {
    fail(
      `"${toolName}" cannot be executed from an approval — Spendsmith has no executor for it. Use create_meta_image_campaign / create_meta_video_campaign, create_adset, create_ad, update_adset_budget, pause_campaign, resume_campaign or pause_ad.`,
      { toolName },
    );
  }

  const internal: Record<string, unknown> = {};
  const core: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.args ?? {})) {
    if (isInternalKey(key)) internal[key] = value;
    else core[key] = value;
  }

  if (CREATE_TOOLS.has(toolName)) {
    const unsupported = Object.keys(core).filter(
      (key) => key in UNSUPPORTED_KEYS && core[key] != null,
    );
    if (unsupported.length) {
      fail(
        `${toolName} uses fields Spendsmith cannot apply yet: ${unsupported
          .map((k) => `${k} (${UNSUPPORTED_KEYS[k]})`)
          .join(", ")}. Remove them with Edit, or set them in Ads Manager after creation.`,
        { fields: unsupported },
      );
    }
  }

  let args: Record<string, unknown>;
  try {
    args = canonicalize(toolName, core);
  } catch (error) {
    if (isAppError(error)) throw error;
    fail(error instanceof Error ? error.message : String(error));
  }

  // The ad account must be one this client has mapped AND granted.
  const loadAccounts =
    input.loadAccounts ??
    (async (clientId: string) => {
      const { loadMappedMetaAccounts } = await import(
        "@/lib/adspirer/resolve-meta-account"
      );
      return loadMappedMetaAccounts(clientId);
    });
  const granted = (await loadAccounts(input.clientId)).filter(
    (a) => a.access_status === "granted",
  );
  if (!optionalString(args.account_id) && granted.length === 1) {
    args.account_id = normalizeActId(granted[0].meta_account_id);
  }
  const accountId = optionalString(args.account_id);
  if (accountId) {
    const match = granted.find(
      (a) => normalizeActId(a.meta_account_id) === accountId,
    );
    if (!match) {
      fail(
        `Ad account ${accountId} is not a granted Meta account for this client${
          granted.length
            ? ` (allowed: ${granted.map((a) => normalizeActId(a.meta_account_id)).join(", ")})`
            : " — connect and grant an ad account first"
        }.`,
        { account_id: accountId },
      );
    }
    if (match.currency) internal.__account_currency = match.currency.toUpperCase();
  }

  const missing: string[] = [];
  if (NEEDS_LOCATION.has(toolName) && !hasTargetingLocation(args.locations)) {
    if (Array.isArray(args.locations) && args.locations.length) {
      // Locations were given but none is usable — that is a wrong value.
      fail(`${toolName}: ${MISSING_LOCATION_MESSAGE}`, { field: "locations" });
    }
    missing.push(MISSING_LOCATION_MESSAGE);
  }

  const parsed = schema.safeParse(args);
  let data: Record<string, unknown> = {};
  if (parsed.success) {
    data = parsed.data as Record<string, unknown>;
  } else {
    const issues = parsed.error.issues;
    const invalid = issues.filter((i) => !isMissing(args, i));
    const details = {
      issues: issues.map((i) => ({
        path: i.path.map(String).join("."),
        message: i.message,
      })),
    };
    if (invalid.length) {
      fail(
        `${toolName} has invalid values — ${formatIssues(args, invalid)}. Use Edit to fix them, then approve.`,
        details,
      );
    }
    missing.unshift(formatIssues(args, issues));
  }

  if (missing.length && !input.allowIncomplete) {
    fail(
      `${toolName} is missing required values — ${missing.join("; ")}. Use Edit to add them, then approve.`,
      { missing },
    );
  }

  const merged: Record<string, unknown> = {
    ...args,
    ...data,
    ...internal,
  };

  const budgetImpactCents = computeBudgetImpactCents(toolName, merged);
  if (input.client) {
    assertWithinBudgetCeiling(input.client, merged, budgetImpactCents);
  }

  return {
    args: merged,
    budgetImpactCents,
    incomplete: missing.length
      ? `Needs edits before it can run — ${missing.join("; ")}`
      : null,
  };
}
