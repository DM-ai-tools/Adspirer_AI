/**
 * The art styles a bulk run draws from.
 *
 * A bulk run is a creative test, so the images must not all look alike: Meta's delivery system
 * favours genuinely different creative (different concepts and formats), and a viewer scrolling
 * past four takes on one look sees one ad. Each hook in a run is handed a different style from a
 * different family, chosen to suit its angle. The styles are modern static-ad looks that perform
 * on Meta (native-looking posts, tactile 3D, editorial collage, proof cards, comparison layouts,
 * cinematic and lifestyle photography). The visual IDEA is still the model's; the style is the
 * treatment it is made in.
 */
import type { BulkAngle } from "@/lib/creatives/bulk/angles";

export type StyleFamily = "photo" | "render3d" | "graphic" | "native" | "proof" | "compare" | "reference";

/** Most reference images one run takes. */
export const STYLE_IMAGE_LIMIT = 3;
/** Images that follow the operator's reference closely when they have not asked for all of them. */
export const REFERENCE_CLOSE_COUNT = 5;

export type BulkStyle = {
  key: string;
  name: string;
  family: StyleFamily;
  /** Angle kinds this style suits best. */
  fits: Array<BulkAngle["kind"]>;
  brief: string;
};

export const BULK_STYLES: BulkStyle[] = [
  // Photography
  { key: "ugc_phone", name: "UGC phone photo", family: "photo", fits: ["pain", "proof", "hope"], brief: "Looks like a real person's phone photo or selfie: natural light, slightly imperfect framing, a real lived-in setting, a casual handwritten or caption-style headline. It must not look like an ad." },
  { key: "cinematic_hero", name: "Cinematic hero shot", family: "photo", fits: ["hope", "belief"], brief: "One dramatic hero subject shot like a campaign still: low or three-quarter angle, shallow depth of field, rim light and atmosphere, a strong colour grade in the brand palette." },
  { key: "lifestyle_moment", name: "Lifestyle in context", family: "photo", fits: ["hope", "pain"], brief: "The audience in a real, aspirational moment of living the outcome: candid framing, warm natural light, an environment that tells the story, headline set in calm space." },
  { key: "macro_detail", name: "Macro close-up", family: "photo", fits: ["proof", "belief"], brief: "An extreme close-up of a texture or detail that signals quality or the problem, very shallow depth of field, rich materials and light, minimal type." },
  { key: "flatlay", name: "Overhead flat-lay", family: "photo", fits: ["belief", "proof"], brief: "A top-down arrangement of relevant real objects on a coloured or textured surface, neat spacing and long soft shadows, with the words set in the open space." },
  { key: "staged_scene", name: "Staged surreal scene", family: "photo", fits: ["pain", "belief"], brief: "A staged, slightly surreal photograph that dramatises the idea with real objects in an unexpected arrangement, clean studio or location lighting, crisp and believable." },
  // 3D / render
  { key: "clay_3d", name: "Tactile 3D render", family: "render3d", fits: ["hope", "belief"], brief: "Soft, glossy or clay-like 3D objects and icons that stand for the idea, floating on a clean gradient, studio lighting, soft shadows, playful depth." },
  { key: "isometric_scene", name: "Isometric 3D scene", family: "render3d", fits: ["belief", "proof"], brief: "A small isometric 3D scene or mini-world that shows the mechanism or journey, tidy and detailed, soft colour and light." },
  { key: "dark_luxe", name: "Dark luxe glow", family: "render3d", fits: ["proof", "hope"], brief: "A deep dark background with a luminous brand-colour glow and reflective glassy or metallic objects, premium and high-contrast, restrained elegant type." },
  // Graphic / editorial
  { key: "type_poster", name: "Bold typographic poster", family: "graphic", fits: ["belief", "hope"], brief: "Oversized confident type is the image: tight kerning, one word picked out in the accent colour, a few graphic shapes, almost no photography. Reads in a blink at thumbnail size." },
  { key: "editorial_collage", name: "Editorial cut-out collage", family: "graphic", fits: ["pain", "belief"], brief: "A magazine collage: cut-out photos with white edges, torn paper, tape, halftone texture and hand-drawn circles and arrows, layered with a clear headline." },
  { key: "flat_illustration", name: "Flat graphic illustration", family: "graphic", fits: ["pain", "belief", "hope"], brief: "Big simple vector shapes in a limited brand palette, a clear visual metaphor for the problem and its fix, confident outlines and generous space for type." },
  { key: "retro_poster", name: "Retro print poster", family: "graphic", fits: ["hope", "belief"], brief: "A vintage print look: limited ink colours, grain and misregistration, bold shapes and a classic poster layout with modern content." },
  { key: "magazine_cover", name: "Magazine cover", family: "graphic", fits: ["proof", "hope"], brief: "A glossy magazine cover: masthead-style brand name, a strong cover image, cover-line headlines, the offer as the cover story." },
  // Native
  { key: "notes_app", name: "Notes-app / message native", family: "native", fits: ["pain", "belief"], brief: "Designed to look like an organic post: a notes-app or messaging-style card with plain text on a simple background and one highlighted line. No real app UI or logos." },
  { key: "sticky_whiteboard", name: "Sticky notes & whiteboard", family: "native", fits: ["belief", "pain"], brief: "A real-looking desk scene of sticky notes, marker scrawl and a whiteboard or cork board that works through the idea, shot from above at a slight angle." },
  { key: "handwritten_photo", name: "Hand-annotated photo", family: "native", fits: ["pain", "proof"], brief: "A candid photo marked up by hand: circled details, arrows and a scrawled marker comment, like a friend pointing something out." },
  { key: "newspaper_headline", name: "Newspaper headline", family: "native", fits: ["belief", "proof"], brief: "A convincing newspaper front-page or clipping with the idea as the headline, newsprint texture and columns, one striking photo." },
  // Proof
  { key: "review_card", name: "Testimonial / review card", family: "proof", fits: ["proof"], brief: "A pull-quote in elegant type with a star rating, shown as a clean review card over a warm textured or photographic background (only if the facts give a real quote; otherwise a rating or result from the facts)." },
  { key: "stat_hero", name: "Proof-led hero stat", family: "proof", fits: ["proof"], brief: "A giant number or result from the facts as the focal point with a short caption and a small supporting visual, clean and credible." },
  { key: "polaroid_scrapbook", name: "Polaroid scrapbook", family: "proof", fits: ["proof", "hope"], brief: "Real-looking polaroids and prints pinned or taped on a surface, with handwritten captions that show results or moments." },
  // Comparison
  { key: "before_after_split", name: "Before / after split", family: "compare", fits: ["pain", "hope"], brief: "A clean split of the painful before and the better after, same framing on both sides, a clear divider and simple labels." },
  { key: "versus_columns", name: "Versus comparison", family: "compare", fits: ["belief", "objection"], brief: "Two sides, the usual way against this way, shown with real objects or clear simple graphics, with a highlighted winning side." },
  { key: "objection_answer", name: "Objection, answered", family: "compare", fits: ["objection"], brief: "The doubt shown big and in quotation marks, with the answer visible right beside it as a real object, scene or fact." },
  { key: "bright_clean", name: "Bright high-key clean", family: "compare", fits: ["objection", "hope", "belief"], brief: "Airy, bright and minimal with lots of white space, one crisp subject, soft shadows and a single bold accent colour. Calm and trustworthy." },
];

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * One style per angle, none repeated. Each pick prefers a style that suits the angle's kind and
 * comes from the family used least so far, so a run mixes photography, 3D, graphic, native, proof
 * and comparison looks instead of fifteen variations of one.
 */
export function pickBulkStyles(angles: BulkAngle[], random: () => number = Math.random): BulkStyle[] {
  const pool = shuffled(BULK_STYLES, random);
  const used = new Set<string>();
  const familyCount = new Map<StyleFamily, number>();
  return angles.map((angle) => {
    const free = pool.filter((s) => !used.has(s.key));
    const candidates = free.length ? free : pool;
    const fitting = candidates.filter((s) => s.fits.includes(angle.kind));
    const from = fitting.length ? fitting : candidates;
    const least = Math.min(...from.map((s) => familyCount.get(s.family) ?? 0));
    const choice = from.find((s) => (familyCount.get(s.family) ?? 0) === least)!;
    used.add(choice.key);
    familyCount.set(choice.family, (familyCount.get(choice.family) ?? 0) + 1);
    return choice;
  });
}
