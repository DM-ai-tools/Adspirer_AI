import { generateObject } from "ai";
import { z } from "zod";
import { pickModel } from "@/lib/creatives/concept-writer";
import { getObjectStorage } from "@/lib/storage/r2";
import { logger } from "@/lib/observability/logger";
import { pickMainStat } from "@/lib/video/required-stats";
import type { VideoAsset } from "@/lib/video/projects";

export type AssetAnalysis = {
  kind: "stats_screenshot" | "chart_or_results" | "product" | "testimonial" | "logo" | "person" | "other";
  /** What the image shows, in one sentence. */
  summary: string;
  /** Numbers printed in the image, exactly as shown, each with what it measures. */
  stats: Array<{ value: string; label: string }>;
  /** True when a real person's face is visible (such an image cannot be given to Seedance as a reference). */
  hasFace: boolean;
  /** The one headline figure the image makes its point with, one of `stats`. The script must say it. The operator can change it. */
  mainStat?: { value: string; label: string } | null;
};

const schema = z.object({
  kind: z.enum(["stats_screenshot", "chart_or_results", "product", "testimonial", "logo", "person", "other"]),
  summary: z.string().describe("One sentence: what this image shows"),
  stats: z
    .array(z.object({ value: z.string().describe("The number exactly as printed, e.g. 255%, $120M+, 4.3"), label: z.string().describe("What it measures, from the text beside it") }))
    .max(8)
    .describe("Only numbers that are actually legible in the image. Never estimate or invent one."),
  hasFace: z.boolean(),
  main_stat: z
    .object({ value: z.string(), label: z.string() })
    .nullable()
    .describe("The ONE headline figure the image is making its point with: the most prominent, or the result a viewer would care about most (for a results dashboard, its key outcome rather than a volume or cost figure). It must be one of the stats listed, copied exactly. null if there are no stats."),
});

const PROMPT =
  "This image was uploaded by an advertiser to be used inside a video ad. Say what it is, and read out every statistic, result, rating or key number that is clearly legible in it, exactly as printed, with what each one measures. If nothing is legible, return an empty list. Do not guess numbers.";

/** Read an uploaded image: what it is and which stats it carries. Failures return null so the ad can still be written. */
export async function analyzeAsset(asset: VideoAsset): Promise<AssetAnalysis | null> {
  const model = pickModel();
  if (!model) return null;
  try {
    const bytes = await getObjectStorage().get(asset.key);
    if (!bytes) return null;
    const { object } = await generateObject({
      model,
      schema,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            { type: "image", image: new Uint8Array(bytes), mediaType: asset.mime },
          ],
        },
      ],
    });
    const { main_stat: chosen, ...rest } = object;
    return { ...rest, mainStat: pickMainStat(rest.stats, chosen) };
  } catch (error) {
    logger.warn("Could not read an uploaded video image", { asset: asset.id, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** Read every uploaded image at once and fill in what each is and whether it should be highlighted. */
export async function analyzeAssets(assets: VideoAsset[]): Promise<VideoAsset[]> {
  const results = await Promise.all(assets.map((a) => (a.analysis ? Promise.resolve(a.analysis) : analyzeAsset(a))));
  return assets.map((a, i) => {
    const analysis = results[i] ?? null;
    return {
      ...a,
      analysis,
      caption: a.caption || analysis?.summary || "",
      // An image that carries stats is highlighted; anything else is simply shown.
      role: analysis && analysis.stats.length ? "highlight" : "show",
    };
  });
}
