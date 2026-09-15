/**
 * Extract destination / CTA links from Meta creative Graph payloads
 * and optional page-post payloads (effective_object_story_id).
 *
 * Ads Manager "Website URL" usually maps to:
 * - video_data / link_data call_to_action.value.link
 * - link_data.link
 * - asset_feed_spec.link_urls[].website_url
 * - page post call_to_action.value.link / link (when object_story_spec is thin)
 */

const META_HOST =
  /facebook\.com|fb\.me|fb\.com|fbcdn\.net|instagram\.com|cdninstagram\.com|scontent\.|meta\.com/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  if (META_HOST.test(trimmed)) return null;
  return trimmed.replace(/[.,);]+$/g, "");
}

function pathBonus(url: string): number {
  try {
    const path = new URL(url).pathname || "/";
    if (path === "/" || path === "") return 0;
    let bonus = 8;
    if (/\/(lp|lan|landing|offer|demo|audit|book|signup|sign-up|trial)/i.test(path)) {
      bonus += 15;
    }
    if (path.length > 12) bonus += 4;
    return bonus;
  } catch {
    return 0;
  }
}

/**
 * Source rank dominates: the field a URL came from decides the winner, and the
 * path shape is only a tie-breaker inside the same field. Ranking them on one
 * flat scale let a rich page-post URL outrank the ad's real Website URL.
 */
function scoreDestination(url: string, sourceRank: number): number {
  if (META_HOST.test(url)) return -1;
  return sourceRank * 1000 + pathBonus(url);
}

type Candidate = { url: string; score: number; source: string };

function addCandidate(
  out: Candidate[],
  url: string | null,
  sourceRank: number,
  source: string,
): void {
  if (!url) return;
  const score = scoreDestination(url, sourceRank);
  if (score < 0) return;
  out.push({ url, score, source });
}

function ctaLink(node: Record<string, unknown> | null): {
  link: string | null;
  type: string | null;
} {
  if (!node) return { link: null, type: null };
  const cta = asRecord(node.call_to_action);
  const value = cta ? asRecord(cta.value) : null;
  const type =
    (typeof cta?.type === "string" && cta.type) ||
    (typeof node.call_to_action_type === "string" &&
      node.call_to_action_type) ||
    null;
  const link =
    pickLink(value?.link) ||
    pickLink(value?.website_url) ||
    pickLink(value?.link_caption) ||
    null;
  return { link, type };
}

/** Destination-like keys only — never scan ad body/message for URLs. */
function collectDestinationKeys(node: unknown, out: string[], depth = 0): void {
  if (depth > 6 || out.length >= 8) return;
  if (typeof node === "string") {
    const link = pickLink(node);
    if (link) out.push(link);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectDestinationKeys(item, out, depth + 1);
    return;
  }
  const obj = asRecord(node);
  if (!obj) return;
  for (const [key, value] of Object.entries(obj)) {
    if (
      /^(link|website_url|url|destination_url|object_url|link_url|unshimmed_url)$/i.test(
        key,
      )
    ) {
      collectDestinationKeys(value, out, depth + 1);
    } else if (
      /^(call_to_action|link_data|video_data|template_data|link_urls|asset_feed_spec|object_story_spec|value|attachments|target)$/i.test(
        key,
      )
    ) {
      collectDestinationKeys(value, out, depth + 1);
    }
  }
}

export type ExtractedCreativeDestination = {
  landing_page_url: string | null;
  call_to_action_type: string | null;
  headline: string | null;
  primary_text: string | null;
  creative_type: "video" | "image" | "unknown";
  destination_source: string | null;
  /** Ranked Website URL candidates (for audit transparency). */
  destination_candidates: string[];
};

function collectFromCreative(
  creative: Record<string, unknown>,
  candidates: Candidate[],
): {
  ctaType: string | null;
  headline: string | null;
  primary: string | null;
  creativeType: "video" | "image" | "unknown";
} {
  const story = asRecord(creative.object_story_spec);
  const linkData = story ? asRecord(story.link_data) : null;
  const videoData = story ? asRecord(story.video_data) : null;
  const templateData = story ? asRecord(story.template_data) : null;
  const assetFeed = asRecord(creative.asset_feed_spec);

  const fromLink = ctaLink(linkData);
  const fromVideo = ctaLink(videoData);
  const fromTemplate = ctaLink(templateData);
  const fromCreativeRoot = ctaLink(creative);

  // Ads Manager Destination → Website URL priority
  addCandidate(
    candidates,
    fromVideo.link,
    100,
    "video_data.call_to_action.value.link",
  );
  addCandidate(
    candidates,
    fromLink.link,
    100,
    "link_data.call_to_action.value.link",
  );
  addCandidate(
    candidates,
    fromTemplate.link,
    98,
    "template_data.call_to_action.value.link",
  );

  const linkUrls = Array.isArray(assetFeed?.link_urls)
    ? (assetFeed!.link_urls as Array<Record<string, unknown>>)
    : [];
  for (const u of linkUrls) {
    addCandidate(
      candidates,
      pickLink(u.website_url) || pickLink(u.url),
      95,
      "asset_feed_spec.link_urls.website_url",
    );
  }

  // Carousel cards keep their own Website URL per card.
  const childAttachments = Array.isArray(linkData?.child_attachments)
    ? (linkData!.child_attachments as Array<Record<string, unknown>>)
    : [];
  for (const card of childAttachments) {
    const cardCta = ctaLink(card);
    addCandidate(
      candidates,
      cardCta.link || pickLink(card.link),
      92,
      "link_data.child_attachments.link",
    );
  }

  addCandidate(candidates, pickLink(linkData?.link), 90, "link_data.link");
  addCandidate(candidates, pickLink(videoData?.link), 88, "video_data.link");
  addCandidate(
    candidates,
    pickLink(templateData?.link),
    88,
    "template_data.link",
  );
  addCandidate(candidates, pickLink(creative.link_url), 85, "creative.link_url");
  addCandidate(
    candidates,
    pickLink(creative.object_url),
    82,
    "creative.object_url",
  );
  addCandidate(
    candidates,
    fromCreativeRoot.link,
    80,
    "creative.call_to_action.value.link",
  );

  const nested: string[] = [];
  collectDestinationKeys(
    {
      object_story_spec: creative.object_story_spec,
      asset_feed_spec: creative.asset_feed_spec,
      link_url: creative.link_url,
      object_url: creative.object_url,
      call_to_action: creative.call_to_action,
    },
    nested,
  );
  for (const url of nested) {
    addCandidate(candidates, url, 20, "nested_destination_key");
  }

  const bodies = Array.isArray(assetFeed?.bodies)
    ? (assetFeed!.bodies as Array<{ text?: string }>)
    : [];
  const titles = Array.isArray(assetFeed?.titles)
    ? (assetFeed!.titles as Array<{ text?: string }>)
    : [];

  return {
    ctaType:
      fromVideo.type ||
      fromLink.type ||
      fromTemplate.type ||
      fromCreativeRoot.type ||
      (typeof creative.call_to_action_type === "string"
        ? creative.call_to_action_type
        : null),
    primary:
      (typeof creative.body === "string" && creative.body) ||
      (typeof linkData?.message === "string" && linkData.message) ||
      (typeof videoData?.message === "string" && videoData.message) ||
      bodies.find((b) => b.text)?.text ||
      null,
    headline:
      (typeof creative.title === "string" && creative.title) ||
      (typeof linkData?.name === "string" && linkData.name) ||
      (typeof videoData?.title === "string" && videoData.title) ||
      titles.find((t) => t.text)?.text ||
      null,
    creativeType:
      videoData && Object.keys(videoData).length ? "video" : "image",
  };
}

/**
 * Page post linked via effective_object_story_id. Only a FALLBACK: a post can
 * carry an older link than the ad's Ads Manager Website URL, so every page-post
 * rank stays below every creative destination field.
 */
export function collectFromPagePost(
  post: Record<string, unknown> | null | undefined,
  candidates: Candidate[],
): string | null {
  if (!post) return null;
  const fromCta = ctaLink(post);
  addCandidate(
    candidates,
    fromCta.link,
    60,
    "page_post.call_to_action.value.link",
  );
  addCandidate(candidates, pickLink(post.link), 58, "page_post.link");
  addCandidate(
    candidates,
    pickLink(post.website_url),
    58,
    "page_post.website_url",
  );

  const attachments = Array.isArray(post.attachments)
    ? post.attachments
    : asRecord(post.attachments)?.data;
  if (Array.isArray(attachments)) {
    for (const raw of attachments) {
      const att = asRecord(raw);
      if (!att) continue;
      addCandidate(
        candidates,
        pickLink(att.unshimmed_url) || pickLink(att.url),
        56,
        "page_post.attachments.unshimmed_url",
      );
      const target = asRecord(att.target);
      addCandidate(
        candidates,
        pickLink(target?.url) || pickLink(target?.unshimmed_url),
        56,
        "page_post.attachments.target.url",
      );
    }
  }

  return fromCta.type;
}

export function extractCreativeDestination(
  creative: Record<string, unknown> | null | undefined,
  pagePost?: Record<string, unknown> | null,
): ExtractedCreativeDestination {
  if (!creative && !pagePost) {
    return {
      landing_page_url: null,
      call_to_action_type: null,
      headline: null,
      primary_text: null,
      creative_type: "unknown",
      destination_source: null,
      destination_candidates: [],
    };
  }

  const candidates: Candidate[] = [];
  let meta = {
    ctaType: null as string | null,
    headline: null as string | null,
    primary: null as string | null,
    creativeType: "unknown" as "video" | "image" | "unknown",
  };

  if (creative) {
    meta = collectFromCreative(creative, candidates);
  }
  const postCtaType = collectFromPagePost(pagePost, candidates);
  if (!meta.ctaType && postCtaType) meta.ctaType = postCtaType;

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0] ?? null;
  const uniqueCandidates = [
    ...new Set(candidates.map((c) => c.url)),
  ].slice(0, 8);

  return {
    landing_page_url: best?.url ?? null,
    call_to_action_type: meta.ctaType,
    headline: meta.headline,
    primary_text: meta.primary,
    creative_type: meta.creativeType,
    destination_source: best?.source ?? null,
    destination_candidates: uniqueCandidates,
  };
}
