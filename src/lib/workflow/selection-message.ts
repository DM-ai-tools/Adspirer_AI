/**
 * The chat message after a creative is picked.
 *
 * Picking an image does not queue a campaign: a campaign needs the ad copy,
 * objective, budget and locations, and queueing from defaults produced an
 * approval that could not be approved. With nothing pending, the operator is
 * asked about the copy next; when the image was attached to approvals already
 * waiting for it, they are told to approve.
 */
export function selectionFollowUpMessage(
  draft: { headline: string; primary_text: string },
  attachedToPendingApprovals: number,
): string {
  if (attachedToPendingApprovals > 0) {
    return `Selected creative **${draft.headline}** and attached \`image_url\` to ${attachedToPendingApprovals} pending ad approval${attachedToPendingApprovals === 1 ? "" : "s"}. Approve below when ready — nothing goes live until you do.`;
  }
  const primary = draft.primary_text.trim();
  return [
    `Selected creative **${draft.headline}**. Nothing is queued yet.`,
    "",
    "Next is the **ad copy**. This image came with:",
    `- **Headline:** ${draft.headline}`,
    primary ? `- **Primary text:** ${primary.slice(0, 400)}${primary.length > 400 ? "…" : ""}` : null,
    "",
    "Do you want to use this copy as is, change it (tell me what), or have me write new variants? After that I'll ask for the rest (objective, budget, locations, tracking) and queue the campaign for approval with this image.",
  ]
    .filter((line) => line !== null)
    .join("\n");
}
