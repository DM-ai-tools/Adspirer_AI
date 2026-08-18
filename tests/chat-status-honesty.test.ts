import { describe, expect, it } from "vitest";
import {
  describeInteractivePayloads,
  GENERIC_FALLBACK_REPLY,
  humanizeAgentReply,
} from "@/lib/agent/reply-format";
import {
  reconcileAssistantMessage,
  resolveAssistantDisplay,
} from "@/lib/agent/message-reconcile";
import {
  holdStepsForOperator,
  mentionsCreativeGeneration,
  planTaskSteps,
} from "@/lib/agent/task-plan";
import { isRenderStalled, toPublicDraft } from "@/lib/creatives/drafts";
import {
  classifyProviderFailure,
  describeProviderFailure,
  describeProviderFallback,
} from "@/lib/agent/adspirer-agent";
import type { Message, Task } from "@/types";

describe("reply text matches what the turn is actually doing", () => {
  it("keeps a short question instead of the generic sign-off", () => {
    expect(humanizeAgentReply("Daily budget?").display).toBe("Daily budget?");
  });

  it("describes the image choice rather than signing off", () => {
    const prose = describeInteractivePayloads({
      imageChoice: { landing_page_url: "https://example.com" },
    });
    expect(prose).toContain("image URL");
    expect(prose).not.toBe(GENERIC_FALLBACK_REPLY);
  });

  it("still signs off when there is genuinely nothing pending", () => {
    expect(describeInteractivePayloads({})).toBeNull();
    expect(humanizeAgentReply("").display).toBe(GENERIC_FALLBACK_REPLY);
  });

  it("recognises explicit image generation in campaign briefs", () => {
    expect(
      mentionsCreativeGeneration(
        "no i dont have a public image URL, create the images from adspirer",
      ),
    ).toBe(true);
  });
});

describe("format and video pickers are not signed off as done", () => {
  it("describes format_choice instead of the generic sign-off", () => {
    const prose = describeInteractivePayloads({ formatChoice: {} });
    expect(prose).toContain("image");
    expect(prose).toContain("video");
    expect(prose).not.toBe(GENERIC_FALLBACK_REPLY);
  });

  it("describes video_choice without offering generation", () => {
    const prose = describeInteractivePayloads({
      videoChoice: { landing_page_url: "https://example.com" },
    });
    expect(prose).toContain("video URL");
    expect(prose).toMatch(/does not generate/i);
    expect(prose).not.toMatch(/generate creatives|generate stills/i);
  });

  it("parses format_choice and video_choice from model appendix JSON", () => {
    const humanized = humanizeAgentReply(
      'Which format?\n```json\n{"ui":"format_choice"}\n```',
    );
    expect(humanized.formatChoice).toEqual({ selected: null });
    expect(humanized.display).toContain("format");

    const video = humanizeAgentReply(
      'Need a video.\n```json\n{"ui":"video_choice","landing_page_url":"https://lp.example"}\n```',
    );
    expect(video.videoChoice?.landing_page_url).toBe("https://lp.example");
  });

  it("plans a format_choice step before creative asset for new campaigns", () => {
    const steps = planTaskSteps("let's create a new campaign");
    expect(steps.find((s) => s.id === "format_choice")).toBeTruthy();
    expect(steps.find((s) => s.id === "creative_asset")).toBeTruthy();
    expect(steps.find((s) => s.id === "image_choice")).toBeUndefined();
  });
});

describe("advanced targeting pickers", () => {
  it("describes targeting_picker instead of signing off", () => {
    const prose = describeInteractivePayloads({
      targetingPicker: { account_id: "act_1" },
    });
    expect(prose).toContain("custom audiences");
    expect(prose).not.toBe(GENERIC_FALLBACK_REPLY);
  });

  it("parses targeting_picker appendix JSON", () => {
    const humanized = humanizeAgentReply(
      'Set targeting.\n```json\n{"ui":"targeting_picker","account_id":"act_9"}\n```',
    );
    expect(humanized.targetingPicker?.account_id).toBe("act_9");
  });

  it("plans an advanced_targeting step for new campaigns", () => {
    const steps = planTaskSteps("let's create a new campaign");
    expect(steps.find((s) => s.id === "advanced_targeting")).toBeTruthy();
  });
});

describe("orphaned streaming rows recover from the linked task", () => {
  const baseMessage: Message = {
    id: "msg_1",
    conversation_id: "conv_1",
    role: "assistant",
    content: GENERIC_FALLBACK_REPLY,
    tool_call_id: null,
    metadata: { streaming: true, taskId: "task_1" },
    created_at: new Date().toISOString(),
  };

  const doneTask = {
    id: "task_1",
    status: "done",
    agent_state: {
      summary: "Rendering **3** creative variations from your landing page brand.",
      ui: {
        creativePicker: {
          drafts: [{ id: "c1" }, { id: "c2" }, { id: "c3" }],
          status: "generating",
        },
      },
    },
  } as unknown as Task;

  it("clears live and replaces filler text when the task finished", () => {
    const fixed = reconcileAssistantMessage(baseMessage, doneTask);
    expect(fixed.metadata?.streaming).toBe(false);
    expect(fixed.content).toContain("Rendering **3**");
  });

  it("resolves filler when only UI metadata is present", () => {
    expect(
      resolveAssistantDisplay(GENERIC_FALLBACK_REPLY, {
        imageChoice: { landing_page_url: "https://example.com" },
      }),
    ).toContain("image URL");
  });
});

describe("a turn that asks a question does not report a finished plan", () => {
  it("parks the active step and leaves later steps pending", () => {
    const planned = planTaskSteps("let's create a new campaign").map(
      (step) => (step.id === "intake" ? { ...step, state: "active" as const } : step),
    );

    const held = holdStepsForOperator(planned);

    expect(held.find((s) => s.id === "intake")?.state).toBe("waiting");
    expect(held.find((s) => s.id === "queue_create")?.state).toBe("pending");
    expect(held.some((s) => s.state === "done")).toBe(false);
  });
});

describe("stalled renders stop claiming to be in flight", () => {
  const draft = (image_status: string, minutesAgo: number) => ({
    image_status: image_status as never,
    updated_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  });

  it("treats a fresh render as live", () => {
    expect(isRenderStalled(draft("generating", 1))).toBe(false);
  });

  it("treats a render abandoned by a dead job as stalled", () => {
    expect(isRenderStalled(draft("generating", 45))).toBe(true);
    expect(isRenderStalled(draft("pending", 45))).toBe(true);
  });

  it("leaves finished renders alone", () => {
    expect(isRenderStalled(draft("succeeded", 5_000))).toBe(false);
    expect(isRenderStalled(draft("skipped", 5_000))).toBe(false);
  });
});

describe("a failed model call is reported, not signed off", () => {
  // Shape of the AI SDK error seen when the Anthropic workspace runs out of credit.
  const billingError = Object.assign(
    new Error(
      "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
    ),
    {
      statusCode: 400,
      responseBody:
        '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low"}}',
    },
  );

  it("classifies an out-of-credit failure as billing", () => {
    expect(classifyProviderFailure(billingError).kind).toBe("billing");
  });

  it("classifies rejected keys, models, and limits separately", () => {
    expect(
      classifyProviderFailure(
        Object.assign(new Error("invalid x-api-key"), { statusCode: 401 }),
      ).kind,
    ).toBe("auth");
    expect(
      classifyProviderFailure(
        Object.assign(new Error("model: claude-nope not_found"), {
          statusCode: 404,
        }),
      ).kind,
    ).toBe("model");
    expect(
      classifyProviderFailure(
        Object.assign(new Error("rate limit"), { statusCode: 429 }),
      ).kind,
    ).toBe("rate_limit");
    expect(
      classifyProviderFailure(new Error("socket hang up")).kind,
    ).toBe("unknown");
  });

  it("tells the operator what to fix instead of claiming the turn is done", () => {
    const summary = describeProviderFailure(
      classifyProviderFailure(billingError),
      "claude-sonnet-4-6",
    );
    expect(summary).not.toBe(GENERIC_FALLBACK_REPLY);
    expect(summary).toContain("out of credit");
    expect(summary).toContain("Nothing was sent to Meta");
    expect(humanizeAgentReply(summary).display).toContain("out of credit");
  });

  it("names the backup writer when it falls back to OpenAI", () => {
    const notice = describeProviderFallback(
      classifyProviderFailure(billingError),
      "gpt-4o-mini",
    );
    expect(notice).toContain("out of credit");
    expect(notice).toContain("gpt-4o-mini");
  });
});

describe("list payloads do not need the inline still", () => {
  it("points cards at the asset route when image_url/b64 were omitted", () => {
    const publicDraft = toPublicDraft({
      id: "crd_test",
      client_id: "c1",
      service_id: null,
      conversation_id: null,
      task_id: null,
      brief_id: null,
      concept: "Studio",
      headline: "Hello",
      primary_text: "Body",
      description: null,
      cta: null,
      creative_direction: null,
      image_url: null,
      image_b64: null,
      image_mime: "image/png",
      image_model: null,
      image_prompt: null,
      image_status: "succeeded",
      image_error: null,
      landing_page_url: null,
      brand_colors: null,
      logo_url: null,
      status: "ready",
      revision_notes: null,
      created_at: new Date().toISOString(),
      updated_at: "2026-08-17T07:21:01.093Z",
    });
    expect(publicDraft.image_url).toContain("/api/creatives/assets/crd_test");
    expect(publicDraft.image_url).not.toMatch(/^data:/);
  });
});
