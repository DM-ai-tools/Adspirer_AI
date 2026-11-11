import { createHash } from "node:crypto";
import { generateObject } from "ai";
import { z } from "zod";
import { pickModel } from "@/lib/creatives/concept-writer";
import { getObjectStorage, type ObjectStorage } from "@/lib/storage/r2";
import { logger } from "@/lib/observability/logger";
import { evidenceCautions } from "@/lib/video/evidence";
import { pickMainStat } from "@/lib/video/required-stats";
import type { AssetSnapshot, LogoSnapshot } from "@/lib/video/generation-types";
import type { AssetPurpose, BrandManifest, EvidenceCaution } from "@/lib/video/pipeline-types";
import type { VideoAsset } from "@/lib/video/projects";

export type AssetAnalysis = {
  kind: "stats_screenshot" | "chart_or_results" | "product" | "testimonial" | "logo" | "person" | "other";
  /** What the image shows, in one sentence. */
  summary: string;
  /**
   * Numbers printed in the image, exactly as shown. `label` is the label the tool itself prints;
   * `annotationLabel` is a different label someone added on top for the same figure, kept apart so
   * the two are never merged into one claim.
   */
  stats: Array<{ value: string; label: string; annotationLabel?: string | null }>;
  /** True when a real person's face is visible (such an image cannot be given to Seedance as a reference). */
  hasFace: boolean;
  /** The one headline figure the image makes its point with, one of `stats`. The script must say it. The operator can change it. */
  mainStat?: { value: string; label: string } | null;
  /** The period selected in the tool, as printed (e.g. "1 June 2025 - 31 May 2026"). */
  dateRange?: string | null;
  /** Notes added on top of the image (callouts, arrows with text), verbatim. */
  annotations?: string[];
  /** The currency the image names (a code or a name). Null when it only prints a symbol. */
  currencyCode?: string | null;
};

const schema = z.object({
  kind: z.enum(["stats_screenshot", "chart_or_results", "product", "testimonial", "logo", "person", "other"]),
  summary: z.string().describe("One sentence: what this image shows"),
  stats: z
    .array(
      z.object({
        value: z.string().describe("The number exactly as printed, e.g. 255%, $120M+, 4.3"),
        label: z.string().describe("The label the tool or document ITSELF prints for this number, exactly as printed (e.g. 'Conv. value'). Not a note someone added."),
        annotation_label: z.string().nullable().describe("A different name for this same number that was ADDED on top of the image by a person (a callout, a coloured tag, a handwritten or typed note such as 'Sales Revenue'), exactly as written. null when there is none."),
      }),
    )
    .max(8)
    .describe("Only numbers that are actually legible in the image. Never estimate or invent one."),
  hasFace: z.boolean(),
  main_stat: z
    .object({ value: z.string(), label: z.string() })
    .nullable()
    .describe("The ONE headline figure the image is making its point with: the most prominent, or the result a viewer would care about most (for a results dashboard, its key outcome rather than a volume or cost figure). It must be one of the stats listed, copied exactly. null if there are no stats."),
  date_range: z.string().nullable().describe("The date range or period selected in the tool, exactly as printed (e.g. '1 June 2025 - 31 May 2026'). null when none is visible."),
  annotations: z.array(z.string()).max(8).describe("Every note, callout or claim that a person added on top of the image (not printed by the tool), verbatim, e.g. 'In <1 year'. Empty when there are none."),
  currency_code: z.string().nullable().describe("The currency the image names in words or as a code (AUD, USD, 'Australian dollars'). A bare symbol such as $ does not name a currency: return null for it."),
});

const PROMPT =
  "This image was uploaded by an advertiser as evidence for a video ad. Say what it is, and read out every statistic, result, rating or key number that is clearly legible in it, exactly as printed, with what each one measures. Screenshots of dashboards are often annotated by the person who made them (arrows, coloured callouts, a relabel such as 'Sales Revenue' written beside 'Conv. value', a claim such as 'In <1 year'). Keep the two apart: for each number give the label the tool itself prints, and separately any label a person added for it; list every added note; and report the date range the tool shows. If nothing is legible, return an empty list. Do not guess numbers, do not merge the tool's label with an added one, and do not work out a currency from a symbol.";

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
    const stats = (object.stats ?? []).map((s) => ({ value: s.value, label: s.label, annotationLabel: s.annotation_label?.trim() || null }));
    return {
      kind: object.kind,
      summary: object.summary,
      stats,
      hasFace: object.hasFace,
      mainStat: pickMainStat(stats, object.main_stat),
      dateRange: object.date_range?.trim() || null,
      annotations: (object.annotations ?? []).map((a) => a.trim()).filter(Boolean),
      currencyCode: object.currency_code?.trim() || null,
    };
  } catch (error) {
    logger.warn("Could not read an uploaded video image", { asset: asset.id, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** An image that carries figures is the operator's proof; anything else supports the brief. */
export function purposeOf(asset: Pick<VideoAsset, "purpose" | "analysis">): AssetPurpose {
  if (asset.purpose) return asset.purpose;
  return asset.analysis?.stats.length ? "approved_proof_screenshot" : "supporting_image";
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
      purpose: analysis && analysis.stats.length ? "approved_proof_screenshot" : "supporting_image",
    };
  });
}

/** What to settle about an image's figures before they are used. */
export function assetCautions(asset: Pick<VideoAsset, "analysis">): EvidenceCaution[] {
  return evidenceCautions(asset.analysis);
}

// ------------------------------------------------------------------ identity of a file

export const sha256 = (bytes: Buffer | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * The uploaded files exactly as they stand now, to be kept with a video when it is started. The job
 * then uses these records, not the project's current list: a later upload, a replaced file or a
 * changed selection cannot alter a video that is already under way. A file that cannot be read is
 * still recorded, with no checksum, so its absence is visible instead of silent.
 */
export async function snapshotAssets(assets: VideoAsset[], storage: ObjectStorage = getObjectStorage()): Promise<AssetSnapshot[]> {
  return Promise.all(
    assets.map(async (a) => {
      let hash = a.sha256 ?? null;
      let size = a.bytes ?? null;
      if (!hash) {
        const bytes = await storage.get(a.key).catch(() => null);
        if (bytes) {
          hash = sha256(bytes);
          size = bytes.length;
        }
      }
      return { id: a.id, name: a.name, purpose: purposeOf(a), key: a.key, mime: a.mime, version: a.version ?? 1, sha256: hash, bytes: size };
    }),
  );
}

export async function snapshotLogo(manifest: BrandManifest | null | undefined, storage: ObjectStorage = getObjectStorage()): Promise<LogoSnapshot | null> {
  const logo = manifest?.logo;
  if (!logo) return null;
  const bytes = await storage.get(logo.storageKey).catch(() => null);
  return { key: logo.storageKey, mime: logo.mime, sha256: bytes ? sha256(bytes) : null, bytes: bytes ? bytes.length : null, sourceUrl: logo.sourceUrl, origin: logo.origin };
}

export type OriginalFile = { bytes: Buffer; snapshot: AssetSnapshot };

/**
 * The original bytes of a file a video was started with. Refuses anything that is not byte for byte
 * the file that was selected: a missing file or a changed one is an error with the file's name, never
 * a silent skip or a substitute.
 */
export async function loadOriginal(snapshot: AssetSnapshot, storage: ObjectStorage = getObjectStorage()): Promise<OriginalFile> {
  const bytes = await storage.get(snapshot.key);
  if (!bytes) throw new Error(`The uploaded file "${snapshot.name}" is no longer in storage. Upload it again; nothing else is used in its place.`);
  if (snapshot.sha256 && sha256(bytes) !== snapshot.sha256) throw new Error(`The stored copy of "${snapshot.name}" is not the file that was selected for this video (its checksum differs). It is not used.`);
  return { bytes, snapshot };
}

/** The files a video works from: its own snapshot once it has one, else the project's current files. */
export function jobAssets(project: { assets: VideoAsset[]; plan?: { assets?: AssetSnapshot[] } | null }): AssetSnapshot[] {
  if (project.plan?.assets) return project.plan.assets;
  return project.assets.map((a) => ({ id: a.id, name: a.name, purpose: purposeOf(a), key: a.key, mime: a.mime, version: a.version ?? 1, sha256: a.sha256 ?? null, bytes: a.bytes ?? null }));
}
