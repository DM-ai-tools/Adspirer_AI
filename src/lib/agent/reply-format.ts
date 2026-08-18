export type FormattedToolCall = {
  name: string;
  args: Record<string, unknown>;
  rationale?: string;
};

export type FormattedServicePicker = {
  services: Array<{ id: string; name: string; description?: string }>;
};

export type FormattedCopyPicker = {
  copies: Array<{
    id: string;
    angle: string;
    primary_text: string;
    headline: string;
    description?: string;
    cta?: string;
  }>;
};

export type FormattedAdPicker = {
  ads: Array<{
    id: string;
    name: string;
    status?: string;
    creative_summary?: string;
    adset_id?: string;
    campaign_id?: string;
  }>;
};

export type FormattedImageChoice = {
  landing_page_url?: string;
  headline?: string;
  primary_text?: string;
};

/** Image vs video campaign format picker (asked first in campaign intake). */
export type FormattedFormatChoice = {
  selected?: "image" | "video" | null;
};

/** Ask for a public video URL or existing Meta video ID (no generation). */
export type FormattedVideoChoice = {
  landing_page_url?: string;
  headline?: string;
  primary_text?: string;
};

/** Opens the advanced targeting picker (custom audiences + detailed targeting). */
export type FormattedTargetingPicker = {
  account_id?: string | null;
};

/**
 * Strip machine JSON appendix blocks and bare JSON payloads from model text.
 */
export function stripMachineJson(text: string): string {
  let out = text.replace(/```json\s*([\s\S]*?)```/gi, (full, body) => {
    try {
      const parsed = JSON.parse(String(body).trim()) as Record<string, unknown>;
      if (isMachinePayload(parsed)) return "";
    } catch {
      // keep unrecognized fenced blocks
    }
    return full;
  });

  // Strip trailing/unfenced machine JSON objects embedded in prose
  out = stripEmbeddedMachineObjects(out);

  out = out.trim();
  if (looksLikeJsonObject(out) || looksLikeJsonArray(out)) {
    try {
      const parsed = JSON.parse(out) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        isMachinePayload(parsed as Record<string, unknown>)
      ) {
        return "";
      }
    } catch {
      // keep
    }
  }

  return out.replace(/\n{3,}/g, "\n\n").trim();
}

export function isMachinePayload(parsed: Record<string, unknown>): boolean {
  if (parsed.ui === "service_picker" && Array.isArray(parsed.services)) return true;
  if (parsed.ui === "copy_picker" && Array.isArray(parsed.copies)) return true;
  if (parsed.ui === "ad_picker" && Array.isArray(parsed.ads)) return true;
  if (parsed.ui === "image_choice") return true;
  if (parsed.ui === "format_choice") return true;
  if (parsed.ui === "video_choice") return true;
  if (parsed.ui === "targeting_picker") return true;
  if (typeof parsed.tool === "string" && parsed.args && typeof parsed.args === "object") {
    return true;
  }
  return false;
}

export function looksLikeJsonObject(text: string): boolean {
  const t = text.trim();
  return t.startsWith("{") && t.endsWith("}");
}

export function looksLikeJsonArray(text: string): boolean {
  const t = text.trim();
  return t.startsWith("[") && t.endsWith("]");
}

/**
 * A short line is still a complete reply when it asks something. Treating every
 * reply under 24 characters as "too thin" replaced questions like "Daily budget?"
 * with the generic sign-off, so the chat looked finished while it was waiting.
 */
function isUsableProse(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= 24 || (trimmed.length > 0 && trimmed.includes("?"));
}

/**
 * If Claude returns JSON-only (or prose that's too thin), build a normal chat reply.
 * Machine JSON is kept separately via extractors — not in the operator-facing text.
 */
export function humanizeAgentReply(raw: string): {
  display: string;
  toolCalls: FormattedToolCall[];
  servicePicker: FormattedServicePicker | null;
  copyPicker: FormattedCopyPicker | null;
  adPicker: FormattedAdPicker | null;
  imageChoice: FormattedImageChoice | null;
  formatChoice: FormattedFormatChoice | null;
  videoChoice: FormattedVideoChoice | null;
  targetingPicker: FormattedTargetingPicker | null;
} {
  const toolCalls = extractToolProposals(raw);
  const servicePicker = extractServicePicker(raw);
  const copyPicker = extractCopyPicker(raw);
  const adPicker = extractAdPicker(raw);
  const imageChoice = extractImageChoice(raw);
  const formatChoice = extractFormatChoice(raw);
  const videoChoice = extractVideoChoice(raw);
  const targetingPicker = extractTargetingPicker(raw);

  const fillThin = (display: string) => {
    if (isUsableProse(display)) return display;
    return synthesizeFromPayloads(
      toolCalls,
      servicePicker,
      copyPicker,
      adPicker,
      imageChoice,
      raw,
      formatChoice,
      videoChoice,
      targetingPicker,
    );
  };

  // Known chat-wrapper JSON shapes → pull the human message out first
  const fromShape = extractChatJsonShape(raw);
  if (fromShape) {
    return {
      display: fillThin(stripMachineJson(fromShape)).trim(),
      toolCalls,
      servicePicker,
      copyPicker,
      adPicker,
      imageChoice,
      formatChoice,
      videoChoice,
      targetingPicker,
    };
  }

  let display = stripMachineJson(raw);

  // Anything that is still pure JSON (object or array) becomes readable markdown
  if (looksLikeJsonObject(display) || looksLikeJsonArray(display)) {
    try {
      display = jsonToReadableMarkdown(JSON.parse(display.trim()));
    } catch {
      // keep
    }
  }

  if ((!display || display.length < 24) && (looksLikeJsonObject(raw.trim()) || looksLikeJsonArray(raw.trim()))) {
    try {
      display = jsonToReadableMarkdown(JSON.parse(raw.trim()));
    } catch {
      // fall through
    }
  }

  display = fillThin(display);
  display = stripMachineJson(display);
  if (!display.trim()) {
    display = synthesizeFromPayloads(
      toolCalls,
      servicePicker,
      copyPicker,
      adPicker,
      imageChoice,
      raw,
      formatChoice,
      videoChoice,
      targetingPicker,
    );
  }

  // Final guard: never leave raw JSON braces as the operator-facing reply
  if (looksLikeJsonObject(display) || looksLikeJsonArray(display)) {
    try {
      display = jsonToReadableMarkdown(JSON.parse(display.trim()));
    } catch {
      display = synthesizeFromPayloads(
        toolCalls,
        servicePicker,
        copyPicker,
        adPicker,
        imageChoice,
        raw,
        formatChoice,
        videoChoice,
        targetingPicker,
      );
    }
  }

  return {
    display: display.trim(),
    toolCalls,
    servicePicker,
    copyPicker,
    adPicker,
    imageChoice,
    formatChoice,
    videoChoice,
    targetingPicker,
  };
}

/** Clean history so the model doesn't keep imitating JSON-only replies. */
export function sanitizeHistoryContent(content: string): string {
  const humanized = humanizeAgentReply(content);
  if (humanized.display.trim().length >= 20) return humanized.display;
  return humanized.display || "(prior assistant note)";
}

/**
 * Pull operator-facing text from common LLM JSON wrapper shapes.
 */
function extractChatJsonShape(raw: string): string | null {
  const trimmed = raw.trim();
  // Fenced JSON that is a whole reply
  const fenced = trimmed.match(/^```json\s*([\s\S]*?)```$/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  if (!looksLikeJsonObject(candidate)) return null;

  try {
    const obj = JSON.parse(candidate) as Record<string, unknown>;
    if (isMachinePayload(obj)) return null;

    const primary =
      pickString(obj, [
        "message",
        "reply",
        "response",
        "content",
        "text",
        "answer",
        "summary",
        "body",
        "assistant_message",
      ]) ?? null;

    const parts: string[] = [];
    if (primary) parts.push(primary);

    const stages = obj.stages ?? obj.stage_status ?? obj.status;
    if (stages) {
      parts.push("", "### Stage status", jsonToReadableMarkdown(stages, 1));
    }

    const next = pickString(obj, ["next_step", "next", "cta", "follow_up"]);
    if (next) parts.push("", next);

    const questions = obj.questions ?? obj.ask;
    if (Array.isArray(questions) && questions.length) {
      parts.push("", "### Questions");
      for (const q of questions) {
        parts.push(`- ${typeof q === "string" ? q : JSON.stringify(q)}`);
      }
    }

    if (parts.join("").trim().length >= 10) {
      return parts.join("\n").trim();
    }

    // Generic object → readable markdown (not machine-only)
    return jsonToReadableMarkdown(obj);
  } catch {
    return null;
  }
}

function pickString(
  obj: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function stripEmbeddedMachineObjects(text: string): string {
  let out = text;
  // Remove standalone JSON objects that look like tool / service_picker payloads
  const re = /\{[\s\S]*?\}/g;
  out = out.replace(re, (match) => {
    if (match.length > 8000) return match;
    try {
      const parsed = JSON.parse(match) as Record<string, unknown>;
      if (isMachinePayload(parsed)) return "";
    } catch {
      return match;
    }
    return match;
  });
  return out;
}

/**
 * Last-resort reply when the model returned no prose and nothing interactive.
 * Exported so callers that attach pickers *after* the reply was written can
 * recognise the filler and replace it — saying "done" under a question is the
 * one thing this text must never do.
 */
export const GENERIC_FALLBACK_REPLY = "Done — let me know what you'd like next.";

/**
 * Prose for whatever the turn is waiting on. Anything interactive on screen
 * needs a sentence explaining it, whether the model wrote one or not.
 */
export function describeInteractivePayloads(payloads: {
  servicePicker?: FormattedServicePicker | null;
  copyPicker?: FormattedCopyPicker | null;
  adPicker?: FormattedAdPicker | null;
  imageChoice?: FormattedImageChoice | null;
  formatChoice?: FormattedFormatChoice | null;
  videoChoice?: FormattedVideoChoice | null;
  targetingPicker?: FormattedTargetingPicker | null;
  creativePicker?: {
    drafts?: Array<{ id?: string }>;
    status?: string | null;
  } | null;
}): string | null {
  const {
    servicePicker,
    copyPicker,
    adPicker,
    imageChoice,
    formatChoice,
    videoChoice,
    targetingPicker,
    creativePicker,
  } = payloads;

  if (formatChoice) {
    return [
      "Do you want an **image** ad/campaign or a **video** ad/campaign?",
      "",
      "Use the buttons below — this chooses which Adspirer create tool we queue (image stills vs video URL).",
    ].join("\n");
  }

  if (targetingPicker) {
    return [
      "Set **advanced targeting** for the ad set — custom audiences and detailed targeting (interests / behaviors / locations).",
      "",
      "Pick by name in the panel below (Meta IDs are applied automatically), or **Skip** to use broad / Advantage+ defaults.",
    ].join("\n");
  }

  if (creativePicker?.drafts?.length) {
    const count = creativePicker.drafts.length;
    const rendering = creativePicker.status === "generating";
    return rendering
      ? `Rendering **${count}** creative variation${count === 1 ? "" : "s"} from your landing page brand — they fill in below as each still finishes (30–90s each). Pick one with **Use for campaign** when ready, or **Rework** any you want changed.`
      : `Review the **${count}** creative concept${count === 1 ? "" : "s"} below and pick one with **Use for campaign**.`;
  }

  if (adPicker?.ads?.length) {
    return [
      `I found **${adPicker.ads.length} ads** in the account. Pick one to optimize with Adspirer.`,
      "",
      ...adPicker.ads.slice(0, 12).map(
        (a, i) =>
          `${i + 1}. **${a.name}** (\`${a.id}\`)${
            a.status ? ` · ${a.status}` : ""
          }${a.creative_summary ? ` — ${a.creative_summary}` : ""}`,
      ),
    ].join("\n");
  }

  if (videoChoice) {
    return [
      "I need a **public video URL** (MP4/MOV) or an existing Meta **video ID** for this campaign.",
      videoChoice.landing_page_url
        ? `Landing page on file: ${videoChoice.landing_page_url}`
        : "Share a landing page URL if you have not already.",
      "",
      "Adspirer does not generate videos — use the buttons below or paste a URL / video ID in chat.",
    ].join("\n");
  }

  if (imageChoice) {
    return [
      "Do you already have a public **image URL** (or Meta image hash), or should I **generate creatives** from your ad copy + landing page?",
      imageChoice.landing_page_url
        ? `Landing page on file: ${imageChoice.landing_page_url}`
        : "Share a landing page URL so we can pull brand colours / logo cues.",
      "",
      "Use the buttons below — if you pick **Generate**, the stills appear right here for you to approve or rework.",
    ].join("\n");
  }

  if (copyPicker?.copies?.length) {
    const lines = copyPicker.copies.map(
      (c, i) =>
        `${i + 1}. **${c.headline}** (${c.angle})\n   ${c.primary_text.slice(0, 160)}${
          c.primary_text.length > 160 ? "…" : ""
        }`,
    );
    return [
      `I drafted **${copyPicker.copies.length} Meta ad copy variants**. Pick one below (or reply with the id).`,
      "",
      ...lines,
      "",
      "After you pick, I’ll queue create via Approvals (PAUSED).",
    ].join("\n");
  }

  if (servicePicker?.services?.length) {
    const lines = servicePicker.services
      .slice(0, 20)
      .map(
        (s, i) =>
          `${i + 1}. **${s.name}**${s.description ? ` — ${s.description}` : ""}`,
      );
    return [
      `I found **${servicePicker.services.length} services** you can build ad sets for.`,
      "Select the ones you want below (or reply with the names).",
      "",
      "### Services",
      ...lines,
      "",
      "### Stage status",
      "- **B Website services** — done",
      "- **C Ad sets + ads** — waiting for your pick",
    ].join("\n");
  }

  return null;
}

function synthesizeFromPayloads(
  toolCalls: FormattedToolCall[],
  servicePicker: FormattedServicePicker | null,
  copyPicker: FormattedCopyPicker | null,
  adPicker: FormattedAdPicker | null,
  imageChoice: FormattedImageChoice | null,
  raw: string,
  formatChoice: FormattedFormatChoice | null = null,
  videoChoice: FormattedVideoChoice | null = null,
  targetingPicker: FormattedTargetingPicker | null = null,
): string {
  const interactive = describeInteractivePayloads({
    servicePicker,
    copyPicker,
    adPicker,
    imageChoice,
    formatChoice,
    videoChoice,
    targetingPicker,
  });
  if (interactive) return interactive;

  if (toolCalls.length) {
    const lines = toolCalls.map((t, i) => {
      const name =
        typeof t.args.name === "string"
          ? t.args.name
          : typeof t.args.campaign_name === "string"
            ? t.args.campaign_name
            : null;
      return `${i + 1}. \`${t.name}\`${name ? ` — ${name}` : ""}${
        t.rationale ? ` (${t.rationale})` : ""
      }`;
    });
    return [
      `I've prepared **${toolCalls.length}** action${toolCalls.length === 1 ? "" : "s"} for Approvals.`,
      "Nothing is applied to Meta until you approve and execute — new entities stay **PAUSED**.",
      "",
      "### Proposed actions",
      ...lines,
      "",
      "### What's next",
      "1. Open **Approvals** in the left sidebar.",
      "2. Approve (or Edit) each item.",
      "3. Reply here after execution and I’ll continue the next stage.",
    ].join("\n");
  }

  if (looksLikeJsonObject(raw.trim()) || looksLikeJsonArray(raw.trim())) {
    try {
      return jsonToReadableMarkdown(JSON.parse(raw.trim()));
    } catch {
      // fall through
    }
  }

  return raw.trim() || GENERIC_FALLBACK_REPLY;
}

export function jsonToReadableMarkdown(value: unknown, depth = 0): string {
  if (value == null) return "_empty_";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (!value.length) return "_none_";
    if (value.every((v) => typeof v !== "object" || v === null)) {
      return value.map((v) => `- ${String(v)}`).join("\n");
    }
    return value
      .map((item, i) => {
        if (item && typeof item === "object") {
          const obj = item as Record<string, unknown>;
          if (typeof obj.tool === "string") {
            return `- **${obj.tool}**${
              typeof obj.rationale === "string" ? ` — ${obj.rationale}` : ""
            }`;
          }
          const title =
            (typeof obj.name === "string" && obj.name) ||
            (typeof obj.title === "string" && obj.title) ||
            (typeof obj.id === "string" && obj.id) ||
            `Item ${i + 1}`;
          const desc =
            typeof obj.description === "string" ? ` — ${obj.description}` : "";
          return `- **${title}**${desc}`;
        }
        return `- ${String(item)}`;
      })
      .join("\n");
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.ui === "service_picker" && Array.isArray(obj.services)) {
      return synthesizeFromPayloads(
        [],
        {
          services: (obj.services as Array<Record<string, unknown>>).map((s, i) => ({
            id: String(s.id ?? `svc_${i + 1}`),
            name: String(s.name ?? `Service ${i + 1}`),
            description:
              typeof s.description === "string" ? s.description : undefined,
          })),
        },
        null,
        null,
        null,
        "",
      );
    }
    if (obj.ui === "copy_picker" && Array.isArray(obj.copies)) {
      return synthesizeFromPayloads(
        [],
        null,
        {
          copies: (obj.copies as Array<Record<string, unknown>>).map((c, i) => ({
            id: String(c.id ?? `copy_${i + 1}`),
            angle: String(c.angle ?? `Angle ${i + 1}`),
            primary_text: String(c.primary_text ?? ""),
            headline: String(c.headline ?? ""),
            description:
              typeof c.description === "string" ? c.description : undefined,
            cta: typeof c.cta === "string" ? c.cta : undefined,
          })),
        },
        null,
        null,
        "",
      );
    }
    if (obj.ui === "ad_picker" && Array.isArray(obj.ads)) {
      return synthesizeFromPayloads(
        [],
        null,
        null,
        {
          ads: (obj.ads as Array<Record<string, unknown>>).map((a, i) => ({
            id: String(a.id ?? `ad_${i + 1}`),
            name: String(a.name ?? `Ad ${i + 1}`),
            status: typeof a.status === "string" ? a.status : undefined,
            creative_summary:
              typeof a.creative_summary === "string"
                ? a.creative_summary
                : undefined,
          })),
        },
        null,
        "",
      );
    }
    if (obj.ui === "image_choice") {
      return synthesizeFromPayloads(
        [],
        null,
        null,
        null,
        {
          landing_page_url:
            typeof obj.landing_page_url === "string"
              ? obj.landing_page_url
              : undefined,
          headline: typeof obj.headline === "string" ? obj.headline : undefined,
          primary_text:
            typeof obj.primary_text === "string" ? obj.primary_text : undefined,
        },
        "",
      );
    }
    if (obj.ui === "format_choice") {
      return synthesizeFromPayloads([], null, null, null, null, "", {}, null);
    }
    if (obj.ui === "video_choice") {
      return synthesizeFromPayloads(
        [],
        null,
        null,
        null,
        null,
        "",
        null,
        {
          landing_page_url:
            typeof obj.landing_page_url === "string"
              ? obj.landing_page_url
              : undefined,
          headline: typeof obj.headline === "string" ? obj.headline : undefined,
          primary_text:
            typeof obj.primary_text === "string" ? obj.primary_text : undefined,
        },
      );
    }
    if (typeof obj.tool === "string") {
      return synthesizeFromPayloads(
        [
          {
            name: obj.tool,
            args: (obj.args as Record<string, unknown>) ?? {},
            rationale: typeof obj.rationale === "string" ? obj.rationale : undefined,
          },
        ],
        null,
        null,
        null,
        null,
        "",
      );
    }

    const lines: string[] = [];
    if (depth === 0) lines.push("Here's what I found:");
    for (const [key, val] of Object.entries(obj)) {
      const label = key.replace(/_/g, " ");
      if (val && typeof val === "object") {
        lines.push("", `### ${label}`, jsonToReadableMarkdown(val, depth + 1));
      } else {
        lines.push(`- **${label}:** ${String(val)}`);
      }
    }
    return lines.join("\n").trim();
  }
  return String(value);
}

function extractBalancedJsonValues(text: string): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "{" && text[i] !== "[") continue;
    const open = text[i];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let j = i; j < text.length; j += 1) {
      const ch = text[j];
      if (inString) {
        if (escape) escape = false;
        else if (ch === "\\") escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === open) depth += 1;
      if (ch === close) depth -= 1;
      if (depth === 0) {
        const slice = text.slice(i, j + 1);
        try {
          out.push(JSON.parse(slice));
        } catch {
          // ignore
        }
        i = j;
        break;
      }
    }
  }
  return out;
}

function extractJsonBlocks(text: string): unknown[] {
  const blocks: unknown[] = [];
  const re = /```json\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    try {
      blocks.push(JSON.parse(match[1]));
    } catch {
      // ignore
    }
  }
  if (!blocks.length) {
    blocks.push(...extractBalancedJsonValues(text));
  } else {
    // Also pick up unfenced tool objects that may sit beside prose
    for (const value of extractBalancedJsonValues(text)) {
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        isMachinePayload(value as Record<string, unknown>)
      ) {
        blocks.push(value);
      }
    }
  }
  return blocks;
}

export function extractToolProposals(text: string): FormattedToolCall[] {
  const out: FormattedToolCall[] = [];
  const seen = new Set<string>();
  for (const parsed of extractJsonBlocks(text)) {
    if (!parsed || typeof parsed !== "object") continue;
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (!item || typeof item !== "object") continue;
        const obj = item as {
          tool?: string;
          args?: Record<string, unknown>;
          rationale?: string;
        };
        if (!obj.tool || !obj.args) continue;
        const key = `${obj.tool}:${JSON.stringify(obj.args)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          name: obj.tool,
          args: obj.args,
          rationale: obj.rationale,
        });
      }
      continue;
    }
    const obj = parsed as {
      tool?: string;
      args?: Record<string, unknown>;
      rationale?: string;
      ui?: string;
      actions?: unknown;
    };
    if (obj.ui === "service_picker") continue;
    if (obj.ui === "copy_picker") continue;
    if (obj.ui === "ad_picker") continue;
    if (obj.ui === "image_choice") continue;
    if (obj.ui === "format_choice") continue;
    if (obj.ui === "video_choice") continue;
    if (obj.ui === "targeting_picker") continue;
    if (Array.isArray(obj.actions)) {
      for (const item of obj.actions) {
        if (!item || typeof item !== "object") continue;
        const action = item as {
          tool?: string;
          args?: Record<string, unknown>;
          rationale?: string;
        };
        if (!action.tool || !action.args) continue;
        out.push({
          name: action.tool,
          args: action.args,
          rationale: action.rationale,
        });
      }
    }
    if (!obj.tool || !obj.args) continue;
    const key = `${obj.tool}:${JSON.stringify(obj.args)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name: obj.tool,
      args: obj.args,
      rationale: obj.rationale,
    });
  }
  return out;
}

export function extractServicePicker(text: string): FormattedServicePicker | null {
  for (const parsed of extractJsonBlocks(text)) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const obj = parsed as {
      ui?: string;
      services?: Array<{ id?: string; name?: string; description?: string }>;
    };
    if (obj.ui !== "service_picker" || !Array.isArray(obj.services)) continue;
    const services = obj.services
      .filter((s) => s?.name?.trim())
      .map((s, i) => ({
        id: s.id?.trim() || `svc_${i + 1}`,
        name: String(s.name).trim(),
        description: s.description?.trim(),
      }));
    if (services.length) return { services };
  }
  return null;
}

export function extractCopyPicker(text: string): FormattedCopyPicker | null {
  for (const parsed of extractJsonBlocks(text)) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const obj = parsed as {
      ui?: string;
      copies?: Array<{
        id?: string;
        angle?: string;
        primary_text?: string;
        headline?: string;
        description?: string;
        cta?: string;
      }>;
    };
    if (obj.ui !== "copy_picker" || !Array.isArray(obj.copies)) continue;
    const copies = obj.copies
      .filter((c) => c?.headline?.trim() && c?.primary_text?.trim())
      .map((c, i) => ({
        id: c.id?.trim() || `copy_${i + 1}`,
        angle: String(c.angle ?? `Angle ${i + 1}`),
        primary_text: String(c.primary_text).trim(),
        headline: String(c.headline).trim(),
        description: c.description?.trim(),
        cta: c.cta?.trim(),
      }));
    if (copies.length) return { copies };
  }
  return null;
}

export function extractAdPicker(text: string): FormattedAdPicker | null {
  for (const parsed of extractJsonBlocks(text)) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const obj = parsed as {
      ui?: string;
      ads?: Array<{
        id?: string;
        name?: string;
        status?: string;
        creative_summary?: string;
        adset_id?: string;
        campaign_id?: string;
      }>;
    };
    if (obj.ui !== "ad_picker" || !Array.isArray(obj.ads)) continue;
    const ads = obj.ads
      .filter((a) => a?.id && a?.name)
      .map((a) => ({
        id: String(a.id).trim(),
        name: String(a.name).trim(),
        status: a.status?.trim(),
        creative_summary: a.creative_summary?.trim(),
        adset_id: a.adset_id?.trim(),
        campaign_id: a.campaign_id?.trim(),
      }));
    if (ads.length) return { ads };
  }
  return null;
}

export function extractImageChoice(text: string): FormattedImageChoice | null {
  for (const parsed of extractJsonBlocks(text)) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const obj = parsed as {
      ui?: string;
      landing_page_url?: string;
      headline?: string;
      primary_text?: string;
    };
    if (obj.ui !== "image_choice") continue;
    return {
      landing_page_url: obj.landing_page_url?.trim(),
      headline: obj.headline?.trim(),
      primary_text: obj.primary_text?.trim(),
    };
  }
  return null;
}

export function extractFormatChoice(text: string): FormattedFormatChoice | null {
  for (const parsed of extractJsonBlocks(text)) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const obj = parsed as { ui?: string; selected?: string };
    if (obj.ui !== "format_choice") continue;
    const selected =
      obj.selected === "image" || obj.selected === "video" ? obj.selected : null;
    return { selected };
  }
  return null;
}

export function extractVideoChoice(text: string): FormattedVideoChoice | null {
  for (const parsed of extractJsonBlocks(text)) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const obj = parsed as {
      ui?: string;
      landing_page_url?: string;
      headline?: string;
      primary_text?: string;
    };
    if (obj.ui !== "video_choice") continue;
    return {
      landing_page_url: obj.landing_page_url?.trim(),
      headline: obj.headline?.trim(),
      primary_text: obj.primary_text?.trim(),
    };
  }
  return null;
}

export function extractTargetingPicker(
  text: string,
): FormattedTargetingPicker | null {
  for (const parsed of extractJsonBlocks(text)) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const obj = parsed as { ui?: string; account_id?: string };
    if (obj.ui !== "targeting_picker") continue;
    return {
      account_id: obj.account_id?.trim() || null,
    };
  }
  return null;
}

