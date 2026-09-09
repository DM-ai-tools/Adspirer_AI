import { getMetaGraphVersion } from "@/lib/meta/auth";

type GraphValue = string | number | boolean | null | undefined;

type GraphErrorBody = {
  message?: string;
  error_user_msg?: string;
  error_user_title?: string;
  code?: number;
  error_subcode?: number;
  error_data?: string;
  fbtrace_id?: string;
};

function formatGraphError(error: GraphErrorBody | undefined, fallback: string): string {
  if (!error) return fallback;

  const hint =
    metaErrorHint(error.error_subcode) ?? metaErrorHintForCode(error.code);
  if (hint) return hint;

  const parts: string[] = [];
  if (error.error_user_title) parts.push(error.error_user_title);
  if (error.error_user_msg) parts.push(error.error_user_msg);
  else if (error.message) parts.push(error.message);
  if (error.code != null) parts.push(`code ${error.code}`);
  if (error.error_subcode != null) parts.push(`subcode ${error.error_subcode}`);
  return parts.length ? parts.join(" — ") : fallback;
}

/** Actionable hints for Meta errors we've hit in production approvals. */
function metaErrorHint(subcode: number | undefined): string | null {
  switch (subcode) {
    case 1885183:
      return [
        "Your Meta app is in Development mode — switch it to Live in Meta Developer Console",
        "(developers.facebook.com → your app → toggle Live), complete Business Verification",
        "and App Review for ads_management, then reconnect Facebook in Connections.",
        "Development mode cannot create ads on real ad accounts. (subcode 1885183)",
      ].join(" ");
    case 1487061:
      return [
        "Missing daily ad set budget — set budget_daily in the approval args",
        "(major currency units, e.g. 5 for £5/day). (subcode 1487061)",
      ].join(" ");
    case 1487079:
      return [
        "Radius targeting is only allowed on cities, not regions or postcodes.",
        "Remove radius from region locations or switch to a city target. (subcode 1487079)",
      ].join(" ");
    case 2490562:
      return [
        "The video_feeds placement is deprecated — use feed, story, facebook_reels, or marketplace instead.",
        "(subcode 2490562)",
      ].join(" ");
    case 4834011:
      return [
        "Meta requires is_adset_budget_sharing_enabled when budget is set on the ad set.",
        "This is handled automatically — retry approval; if it persists, contact support. (subcode 4834011)",
      ].join(" ");
    case 1815143:
      return [
        "This ad set optimizes for off-site conversions but is missing a Meta Pixel.",
        "Add pixel_id (and optional pixel_event_name, e.g. PURCHASE or LEAD) in the approval args,",
        "or use objective OUTCOME_TRAFFIC for link-click optimization without a pixel. (subcode 1815143)",
      ].join(" ");
    default:
      return null;
  }
}

function metaErrorHintForCode(code: number | undefined): string | null {
  if (code === 2) {
    return [
      "Meta API is temporarily unavailable (code 2). Wait 1–2 minutes and approve again.",
      "If it keeps failing, verify ad_set_id is the real ID from Ads Manager (not a placeholder),",
      "and that landing_page_url is set. Video uploads to Meta can also trigger this — retry helps.",
    ].join(" ");
  }
  return null;
}

export class MetaGraphClient {
  private readonly version = getMetaGraphVersion();
  private readonly baseUrl = "https://graph.facebook.com";

  constructor(private readonly accessToken: string) {}

  async get<T>(
    path: string,
    params: Record<string, GraphValue> = {},
  ): Promise<T> {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value == null) continue;
      qs.set(key, String(value));
    }
    qs.set("access_token", this.accessToken);
    const res = await fetch(
      `${this.baseUrl}/${this.version}/${path}?${qs.toString()}`,
      {
        method: "GET",
      },
    );
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok || json.error) {
      throw new Error(
        formatGraphError(
          json.error as GraphErrorBody | undefined,
          `Meta Graph GET failed (${res.status})`,
        ),
      );
    }
    return json as T;
  }

  async post<T>(
    path: string,
    body: Record<string, GraphValue> = {},
  ): Promise<T> {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (value == null) continue;
      form.set(key, String(value));
    }
    form.set("access_token", this.accessToken);
    const res = await fetch(`${this.baseUrl}/${this.version}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok || json.error) {
      throw new Error(
        formatGraphError(
          json.error as GraphErrorBody | undefined,
          `Meta Graph POST failed (${res.status})`,
        ),
      );
    }
    return json as T;
  }
}
