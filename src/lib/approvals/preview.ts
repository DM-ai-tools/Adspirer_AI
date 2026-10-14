import type { AdPreviewInput } from "@/lib/adspirer/provider";
import type { WorkspaceExecutionBackend } from "@/lib/runtime/workspace-context";

/** Where the ad shows, in the order the card lists them. */
export const PREVIEW_FORMATS = [
  { format: "MOBILE_FEED_STANDARD", label: "Facebook feed" },
  { format: "INSTAGRAM_STANDARD", label: "Instagram feed" },
  { format: "INSTAGRAM_REELS", label: "Reels" },
] as const;

const PREVIEW_TOOLS = new Set(["create_meta_image_campaign", "create_meta_video_campaign", "create_ad"]);

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** The (first) ad an approval would create, or null when it creates no ad. */
export function previewArgsFor(toolName: string, args: Record<string, unknown>): AdPreviewInput | null {
  if (!PREVIEW_TOOLS.has(toolName)) return null;
  const account_id = str(args.account_id);
  const primary_text = str(args.primary_text);
  const landing_page_url = str(args.landing_page_url);
  if (!account_id || !primary_text || !landing_page_url) return null;
  return {
    account_id,
    primary_text,
    landing_page_url,
    ad_type: toolName === "create_meta_video_campaign" || args.ad_type === "video" ? "video" : "image",
    headline: str(args.headline),
    description: str(args.description),
    call_to_action: str(args.call_to_action),
    display_link: str(args.display_link),
    image_url: str(args.image_url),
    existing_image_hash: str(args.existing_image_hash),
    video_url: str(args.video_url),
    existing_video_id: str(args.existing_video_id),
    thumbnail_url: str(args.thumbnail_url),
    facebook_page_id: str(args.facebook_page_id),
    instagram_account_id: str(args.instagram_account_id),
    lead_form_id: str(args.lead_form_id),
  };
}

export type ApprovalPreview = {
  previews: Array<{ format: string; label: string; iframeSrc: string | null }>;
  /** Why there is no Meta preview (or what it doesn't show). */
  note: string | null;
};

/** Meta's rendering of the ad an approval would create; nothing is created. */
export async function previewApproval(approval: {
  tool_name: string;
  proposed_args: Record<string, unknown>;
  edited_args?: Record<string, unknown> | null;
}): Promise<ApprovalPreview> {
  const args = (approval.edited_args ?? approval.proposed_args) as Record<string, unknown>;
  const input = previewArgsFor(approval.tool_name, args);
  if (!input) return { previews: [], note: "This change doesn't create an ad, so there's nothing to preview." };
  const { resolveProvider } = await import("@/lib/adspirer/client");
  const backend = typeof args.__provider_backend === "string" ? (args.__provider_backend as WorkspaceExecutionBackend) : null;
  const provider = await resolveProvider(backend);
  if (!provider.previewAd) return { previews: [], note: "Previews aren't available for this connection." };
  try {
    const previews = await provider.previewAd(
      input,
      PREVIEW_FORMATS.map((f) => f.format),
    );
    const label = (format: string) => PREVIEW_FORMATS.find((f) => f.format === format)?.label ?? format;
    const extra = Array.isArray(args.extra_ads) && args.extra_ads.length;
    return {
      previews: previews.map((p) => ({ ...p, label: label(p.format) })),
      note: extra ? `Shows the first ad; ${extra} more will be created in the same ad set.` : null,
    };
  } catch (error) {
    return { previews: [], note: error instanceof Error ? error.message : String(error) };
  }
}
