import type { AgentHistoryMessage } from "@/lib/agent/history";
import { looksLikeAuditBriefReply } from "@/lib/agent/audit-brief";

export type TaskStepState =
  | "pending"
  | "active"
  | "done"
  /** The agent asked the operator something and stopped; not running, not finished. */
  | "waiting"
  | "error"
  | "skipped";

export type TaskStep = {
  id: string;
  label: string;
  state: TaskStepState;
};

export type RequestIntent =
  | "audit"
  | "list_campaigns"
  | "budget"
  | "export"
  | "create_campaign"
  | "generate_creatives"
  | "scrape_services"
  | "ad_copy"
  | "copy_approved"
  | "optimize"
  | "general"
  | "out_of_scope";

export function detectRequestIntent(request: string): RequestIntent {
  const text = request.toLowerCase();
  if (
    /weather|recipe|code|python|javascript|write a poem|joke|crypto|stock|linkedin|tiktok|google ads(?!.*meta)/i.test(
      text,
    ) &&
    !/meta|facebook|instagram|campaign|ad\s?set|budget|audit|ads|create|website|scrape|service|copy|headline|optimiz/.test(
      text,
    )
  ) {
    return "out_of_scope";
  }
  // Queue / apply optimized changes → Approvals path (before export "send report")
  if (
    /\b(send|queue|submit|put|push|add)\b[\s\S]{0,48}\bapprov/.test(text) ||
    /\b(apply|implement|execute)\b[\s\S]{0,40}\b(optim|recommend|change|these|those)\b/.test(
      text,
    ) ||
    /\b(don'?t|do not|can'?t|cannot|doesn'?t)\s+see\b[\s\S]{0,48}\bapprov/.test(
      text,
    ) ||
    /\bnothing\b[\s\S]{0,24}\bapprov/.test(text) ||
    /\bqueue (?:the |these |those )?(?:optim|change|recommend|budget)/.test(text)
  ) {
    return "optimize";
  }
  if (
    /\b(optimiz|creative fatigue|refresh (the )?ad|improve (the )?ad|placement optim)\b/.test(
      text,
    ) ||
    /\bselected ad\b.*\boptim/.test(text) ||
    /\boptimize\b.*\b(ad|campaign|budget|placement)/.test(text)
  ) {
    return "optimize";
  }
  // Image / still generation before scrape or ad_copy — "create an image for
  // this ad copy for URL …" must not become website scrape or copy-only.
  if (
    mentionsCreativeGeneration(text) ||
    (/\b(generate|create|make|produce|design|render)\b/.test(text) &&
      /\b(images?|creatives?|stills?|visuals?|ad\s*images?)\b/.test(text))
  ) {
    return "generate_creatives";
  }
  // Scrape only when the operator wants services/offerings pulled — not merely
  // because a URL / "landing" / "website" appears next to image or copy work.
  if (
    /\b(https?:\/\/|www\.)\S+/i.test(text) &&
    /\b(scrape|services?|offerings?)\b/.test(text) &&
    !/\b(images?|stills?|creatives?|visuals?)\b/.test(text)
  ) {
    return "scrape_services";
  }
  // Report / export before create so "create a report" doesn't become campaign create
  if (
    /\b(pdf|docx?|word|export|download)\b/.test(text) ||
    (/\b(report|recap|briefing|write-?up|summary)\b/.test(text) &&
      /\b(give|generate|create|write|produce|make|draft|prepare|build|share|send|get)\b/.test(
        text,
      ) &&
      !/\bad copy|headline|primary text\b/.test(text)) ||
    /\bgive me a report\b|\bgenerate a report\b|\breport for (our|this|the) (task|session|chat|work)\b/.test(
      text,
    )
  ) {
    return "export";
  }
  if (
    /\buse approved ad copy variant\b/i.test(text) ||
    /\bapproved ad copy variant\b/i.test(text)
  ) {
    return "copy_approved";
  }
  if (
    /\b(ad copy|ad copies|primary text|headline|write copy|generate copy|copy variants|cta)\b/.test(
      text,
    ) ||
    (/\b(write|generate|draft|create)\b/.test(text) &&
      /\b(headline|primary text|ad copy|copies)\b/.test(text))
  ) {
    return "ad_copy";
  }
  if (
    /\b(create|launch|build|set up|setup|new)\b.*\b(campaign|ad set|adset|ads?)\b/.test(
      text,
    ) ||
    /\b(campaign|ad set|adset)\b.*\b(create|launch|build)\b/.test(text) ||
    /\bselected services\b/.test(text) ||
    /\bcreate_adset\b|\bcreate_ad\b|\bcreate_meta_image_campaign\b|\bcreate_meta_video_campaign\b/.test(
      text,
    )
  ) {
    return "create_campaign";
  }
  if (/\b(budget|bid|increase|decrease|scale spend)\b/.test(text)) {
    return "budget";
  }
  if (
    (/\b(list|show|which)\b.*\bcampaign/.test(text) ||
      (/\bcampaigns?\b/.test(text) && /\blist|show\b/.test(text))) &&
    !/\bcreate|launch|build\b/.test(text)
  ) {
    return "list_campaigns";
  }
  if (
    /\b(audit|diagnos|analy[sz]|health|review|perform|deliver|spend|risk|under-?deliver)\b/.test(
      text,
    )
  ) {
    return "audit";
  }
  return "general";
}

/**
 * Same as detectRequestIntent, but keeps short follow-ups ("last 30 days",
 * "entire account") on the audit path when the recent chat is mid-brief.
 */
export function detectRequestIntentWithHistory(
  request: string,
  history: AgentHistoryMessage[] = [],
): RequestIntent {
  const primary = detectRequestIntent(request);
  if (primary !== "general") return primary;

  const recent = history.slice(-10);
  const assistantAskedAudit = recent.some(
    (m) =>
      m.role === "assistant" &&
      /\b(audit|date range|entire ad account|specific campaign|best-practice audit|competitor landing)\b/i.test(
        m.content,
      ),
  );
  const userAskedAudit = recent.some(
    (m) => m.role === "user" && detectRequestIntent(m.content) === "audit",
  );
  if ((assistantAskedAudit || userAskedAudit) && looksLikeAuditBriefReply(request)) {
    return "audit";
  }

  const assistantOfferedOptimize = recent.some(
    (m) =>
      m.role === "assistant" &&
      /\b(optimiz|recommendation|rebalance|budget|Approvals|pause|SCALE|TRIM)\b/i.test(
        m.content,
      ),
  );
  const userAskedOptimize = recent.some(
    (m) => m.role === "user" && detectRequestIntent(m.content) === "optimize",
  );
  if (
    (assistantOfferedOptimize || userAskedOptimize) &&
    /\b(approv|queue|apply|implement|send|optim)/i.test(request)
  ) {
    return "optimize";
  }

  return primary;
}

/**
 * Did the operator ask for generated ad imagery? Only their words may start a
 * batch — UI copy like "Generate images here" must not count.
 */
export function mentionsCreativeGeneration(
  text: string | null | undefined,
): boolean {
  if (!text) return false;
  const imagery =
    /\b(?:generat|render|produc|creat|mak|design)\w*\b[^.\n]{0,40}\b(?:images?|stills?|visuals?|(?:image|creative|visual)\s+variations?)\b/i;
  const explicit =
    /\b(?:generate|generating|render|rendering|produce|producing)\b[^.\n]{0,40}\b(?:creatives?|ad\s+images?)\b/i;
  return imagery.test(text) || explicit.test(text);
}

/**
 * Build a request-specific progress checklist (ChatGPT-style dynamic steps).
 */
export function planTaskSteps(
  request: string,
  intentOverride?: RequestIntent,
): TaskStep[] {
  const intent = intentOverride ?? detectRequestIntent(request);
  const base: TaskStep[] = [
    { id: "queued", label: "Queued", state: "pending" },
    { id: "research", label: "Context research", state: "pending" },
  ];

  switch (intent) {
    case "audit":
      return [
        ...base,
        {
          id: "clarify_brief",
          label: "Confirm scope, dates & competitor LPs",
          state: "pending",
        },
        { id: "fetch_overview", label: "Fetch account overview", state: "pending" },
        { id: "list_campaigns", label: "List Meta campaigns", state: "pending" },
        {
          id: "pull_insights",
          label: "Pull spend & performance",
          state: "pending",
        },
        {
          id: "landing_pages",
          label: "Analyse landing pages",
          state: "pending",
        },
        {
          id: "apply_framework",
          label: "Apply audit checklist",
          state: "pending",
        },
        { id: "write_report", label: "Write audit report", state: "pending" },
        { id: "complete", label: "Complete", state: "pending" },
      ];
    case "list_campaigns":
      return [
        ...base,
        { id: "list_campaigns", label: "List Meta campaigns", state: "pending" },
        { id: "write_report", label: "Summarize campaigns", state: "pending" },
        { id: "complete", label: "Complete", state: "pending" },
      ];
    case "budget":
      return [
        ...base,
        { id: "diagnose", label: "Inspect budgets / delivery", state: "pending" },
        { id: "write_report", label: "Draft recommendation", state: "pending" },
        { id: "approval", label: "Queue Approvals (if needed)", state: "pending" },
        { id: "complete", label: "Complete", state: "pending" },
      ];
    case "generate_creatives":
      return [
        ...base,
        { id: "intake", label: "Collect creative brief", state: "pending" },
        { id: "generate_creatives", label: "Generate GPT Image stills", state: "pending" },
        { id: "pick_creative", label: "Review & select creative", state: "pending" },
        { id: "complete", label: "Await next instruction", state: "pending" },
      ];
    case "create_campaign":
      return [
        ...base,
        { id: "format_choice", label: "Choose image or video", state: "pending" },
        { id: "intake", label: "Collect campaign brief", state: "pending" },
        { id: "advanced_targeting", label: "Custom audiences & detailed targeting", state: "pending" },
        { id: "creative_asset", label: "Creative URL or generate (image)", state: "pending" },
        { id: "queue_create", label: "Queue campaign create (Approvals)", state: "pending" },
        { id: "proof_campaign", label: "Confirm campaign proof IDs", state: "pending" },
        { id: "ask_website", label: "Ask for website URL", state: "pending" },
        { id: "scrape_services", label: "Scrape services (Firecrawl)", state: "pending" },
        { id: "pick_services", label: "Operator picks services", state: "pending" },
        { id: "queue_adsets_ads", label: "Queue ad sets + ads", state: "pending" },
        { id: "complete", label: "Complete", state: "pending" },
      ];
    case "scrape_services":
      return [
        ...base,
        { id: "scrape_services", label: "Scrape website services", state: "pending" },
        { id: "pick_services", label: "Present services to pick", state: "pending" },
        { id: "write_report", label: "Next-step guidance", state: "pending" },
        { id: "complete", label: "Complete", state: "pending" },
      ];
    case "ad_copy":
      return [
        ...base,
        { id: "intake", label: "Collect copy brief", state: "pending" },
        { id: "generate_copy", label: "Generate ad copy variants", state: "pending" },
        { id: "pick_copy", label: "Present copies to pick", state: "pending" },
        { id: "complete", label: "Complete", state: "pending" },
      ];
    case "copy_approved":
      return [
        ...base,
        { id: "pick_copy", label: "Confirm approved copy", state: "pending" },
        { id: "complete", label: "Await next instruction", state: "pending" },
      ];
    case "optimize":
      return [
        ...base,
        { id: "list_ads", label: "List account ads", state: "pending" },
        { id: "pick_ad", label: "Operator picks ad", state: "pending" },
        { id: "optimize", label: "Run Adspirer optimize tools", state: "pending" },
        { id: "write_report", label: "Present recommendations", state: "pending" },
        { id: "approval", label: "Queue Approvals (if needed)", state: "pending" },
        { id: "complete", label: "Complete", state: "pending" },
      ];
    case "export":
      return [
        ...base,
        { id: "gather", label: "Gather chat + Meta evidence", state: "pending" },
        { id: "draft_report", label: "Draft report (OpenAI)", state: "pending" },
        { id: "write_report", label: "Format report for display", state: "pending" },
        { id: "complete", label: "Ready to download", state: "pending" },
      ];
    case "out_of_scope":
      return [
        ...base,
        { id: "write_report", label: "Scope reminder", state: "pending" },
        { id: "complete", label: "Complete", state: "pending" },
      ];
    default:
      return [
        ...base,
        { id: "diagnose", label: "Gather client Meta context", state: "pending" },
        { id: "write_report", label: "Respond", state: "pending" },
        { id: "complete", label: "Complete", state: "pending" },
      ];
  }
}

export function setStepState(
  steps: TaskStep[],
  id: string,
  state: TaskStepState,
): TaskStep[] {
  return steps.map((s) => (s.id === id ? { ...s, state } : s));
}

export function activateStep(steps: TaskStep[], id: string): TaskStep[] {
  if (!steps.some((s) => s.id === id)) return steps;
  return steps.map((s) => {
    if (s.id === id) return { ...s, state: "active" as const };
    if (s.state === "active") return { ...s, state: "done" as const };
    return s;
  });
}

export function failStep(steps: TaskStep[], id: string): TaskStep[] {
  return steps.map((s) =>
    s.id === id ? { ...s, state: "error" as const } : s,
  );
}

export function completeStepsThrough(steps: TaskStep[], id: string): TaskStep[] {
  const idx = steps.findIndex((s) => s.id === id);
  if (idx < 0) return steps;
  return steps.map((s, i) => {
    if (i < idx) return { ...s, state: s.state === "error" ? s.state : "done" };
    if (i === idx) return { ...s, state: "done" };
    return s;
  });
}

export function markRemainingSkipped(steps: TaskStep[]): TaskStep[] {
  return steps.map((s) =>
    s.state === "pending" || s.state === "active" || s.state === "waiting"
      ? { ...s, state: "skipped" as const }
      : s,
  );
}

/**
 * A turn that ends by asking the operator something has not finished its plan.
 * Park the step in progress as waiting and leave the downstream steps pending —
 * flipping them to "done" made the checklist claim a campaign had been created
 * while the agent was still collecting the brief.
 */
export function holdStepsForOperator(steps: TaskStep[]): TaskStep[] {
  return steps.map((s) =>
    s.state === "active" ? { ...s, state: "waiting" as const } : s,
  );
}
