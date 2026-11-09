import { createOpenAI } from "@ai-sdk/openai";
import { getConfig } from "@/lib/config";
import { pickModel } from "@/lib/creatives/concept-writer";
import { logger } from "@/lib/observability/logger";

type Model = NonNullable<ReturnType<typeof pickModel>>;

/**
 * The language models this deployment can call, in order of preference. The first is what the rest
 * of the app uses; when a second provider has a key it follows, so an account that has run out of
 * credit, hit a rate limit or is briefly down does not stop the inspections that gate delivery.
 * Empty when no model is configured.
 */
export function modelCandidates(): Model[] {
  const primary = pickModel();
  if (!primary) return [];
  const config = getConfig();
  const out: Model[] = [primary];
  const primaryIsAnthropic = config.hasAnthropic && Boolean(config.ANTHROPIC_API_KEY);
  if (primaryIsAnthropic && config.hasOpenAI && config.OPENAI_API_KEY) {
    out.push(createOpenAI({ apiKey: config.OPENAI_API_KEY })(config.OPENAI_MODEL));
  }
  return out;
}

/** Run a model call with the first model, and with the next if it fails. Throws the first error when every model fails. */
export async function withModelFallback<T>(run: (model: Model) => Promise<T>, candidates: Model[] = modelCandidates()): Promise<T> {
  if (!candidates.length) throw new Error("No language model is configured (set ANTHROPIC_API_KEY or OPENAI_API_KEY).");
  let first: unknown = null;
  for (const [i, model] of candidates.entries()) {
    try {
      return await run(model);
    } catch (error) {
      first ??= error;
      if (i < candidates.length - 1) logger.warn("A language model call failed; trying the next provider", { error: error instanceof Error ? error.message : String(error) });
    }
  }
  throw first instanceof Error ? first : new Error(String(first));
}
