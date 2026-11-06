import { getConfig } from "@/lib/config";
import { logger } from "@/lib/observability/logger";
import type { AsrWord } from "@/lib/video/captions";

/**
 * When each word is spoken, from OpenAI's transcription with word timestamps. Used only for timing:
 * the words shown on screen are always the script's own. Returns null when it cannot run, and the
 * captions then fall back to evenly spaced timing.
 */
export async function transcribeWords(audio: Buffer, filename = "audio.wav"): Promise<AsrWord[] | null> {
  const config = getConfig();
  if (!config.OPENAI_API_KEY) return null;
  try {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), filename);
    form.set("model", "whisper-1");
    form.set("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.OPENAI_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`transcription ${res.status}`);
    const json = (await res.json()) as { words?: Array<{ word: string; start: number; end: number }> };
    return (json.words ?? []).map((w) => ({ word: w.word, start: w.start, end: w.end }));
  } catch (error) {
    logger.warn("Could not time the captions from the audio", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
