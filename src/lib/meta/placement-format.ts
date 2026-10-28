/**
 * An ad set's placements as the app reads them. Dependency-free so the approval card
 * (a client component) can use it without pulling in the Graph code.
 */
export type PlacementState = {
  /** facebook / instagram / audience_network / messenger; null = automatic (Advantage+) placements. */
  publisher_platforms: string[] | null;
  facebook_positions: string[] | null;
  instagram_positions: string[] | null;
  audience_network_positions: string[] | null;
  messenger_positions: string[] | null;
  /** mobile / desktop; null = all devices. */
  device_platforms: string[] | null;
};

const PLATFORM_NAME: Record<string, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  audience_network: "Audience Network",
  messenger: "Messenger",
};

/** "Facebook (feed, story) + Instagram (stream)", or "automatic (Advantage+)". */
export function describePlacements(state: PlacementState | null | undefined): string {
  if (!state || !state.publisher_platforms) return "automatic (Advantage+)";
  const parts = state.publisher_platforms.map((p) => {
    const positions = state[`${p}_positions` as keyof PlacementState] as string[] | null | undefined;
    const name = PLATFORM_NAME[p] ?? p;
    return positions?.length ? `${name} (${positions.map((x) => x.replaceAll("_", " ")).join(", ")})` : name;
  });
  const devices = state.device_platforms?.length ? `, ${state.device_platforms.join(" + ")} only` : "";
  return `${parts.join(" + ")}${devices}`;
}
