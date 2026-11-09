import type { VideoScene, VideoScript } from "@/lib/video/script";

/**
 * Mechanical repairs for the few problems a model keeps reintroducing however it is told not to:
 * an unconditional "free" the sources only give with a condition, a "best" or ranking nobody
 * substantiates, and a web address or phone number that was altered. They run after the editor, so
 * these never reach the operator or the video, and every change is recorded in the script's warnings.
 * They only ever REMOVE an unsupported word or put back the exact contact detail the sources give;
 * they never add words. Scenes the operator edited are left alone (the editor reports them instead).
 */

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
const squash = (s: string) => s.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[^a-z0-9]/g, "");

const DOMAIN = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[\w\-./]*)?/gi;
const PHONE = /\+?\d[\d\s-]{7,}\d/g;

function tokens(text: string, re: RegExp): string[] {
  return [...text.matchAll(new RegExp(re.source, re.flags))].map((m) => m[0].replace(/[.,;:!?]+$/, ""));
}

/** The web addresses and phone numbers in a text: contact details are trusted from the page itself, not from what was summarised. */
export function contactTokens(text: string): string[] {
  return [...new Set([...tokens(text, DOMAIN), ...tokens(text, PHONE)])];
}

export function repairText(text: string, sourceText: string): { text: string; changes: string[] } {
  const source = norm(sourceText);
  const sourceSquashed = squash(sourceText);
  const changes: string[] = [];
  let out = text;

  // "free": kept only where the sources say "free <the next word>" (or the word before it); otherwise the word is dropped.
  out = out.replace(/(?<![\w-])free\b(\s+)?(\w+)?/gi, (match, _space: string | undefined, next: string | undefined) => {
    if (next && source.includes(`free ${next.toLowerCase()}`)) return match;
    if (next && source.includes(`${next.toLowerCase()} free`)) return match;
    changes.push(`removed an unsupported "free"`);
    return next ?? "";
  });

  // Rankings and "best": dropped unless the sources use the word themselves.
  out = out.replace(/\b(best|leading|top[- ]rated|number one|world[- ]class)\b\s*/gi, (match, word: string) => {
    if (new RegExp(`\\b${word.toLowerCase().replace(/[- ]/g, "[- ]")}\\b`, "i").test(sourceText)) return match;
    changes.push(`removed an unsupported "${word.toLowerCase()}"`);
    return "";
  });
  out = out.replace(/#\s?1\b\s*/g, () => (/#\s?1/.test(sourceText) ? "#1 " : (changes.push('removed an unsupported "#1"'), "")));

  // Contact details: put back exactly what the sources give when the same one was altered.
  const sourceDomains = tokens(sourceText, DOMAIN);
  for (const token of tokens(out, DOMAIN)) {
    const key = squash(token);
    if (key.length < 7 || sourceSquashed.includes(key)) continue;
    // The same site written another way: they share a name label ("trafficradius" in trafficradius.com.au and googleaudit.trafficradius.com.au).
    const labelsOf = (d: string) => d.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[./]/).filter((l) => l.length >= 5 && !["example", "audit"].includes(l));
    const mine = labelsOf(token);
    const original = sourceDomains.find((d) => labelsOf(d).some((l) => mine.includes(l)));
    if (original) {
      out = out.replace(token, original.replace(/^https?:\/\//, "").replace(/^www\./, ""));
      changes.push(`put back the web address exactly as the page gives it`);
    }
  }
  const sourcePhones = tokens(sourceText, PHONE);
  for (const token of tokens(out, PHONE)) {
    const key = squash(token);
    if (key.length < 8 || sourceSquashed.includes(key)) continue;
    if (sourcePhones.length === 1) {
      out = out.replace(token, sourcePhones[0]!);
      changes.push("put back the phone number exactly as the page gives it");
    }
  }

  // Urgency the sources do not state: the sentence is dropped (never rewritten) when it would leave something to say.
  const URGENCY = /\b(don'?t wait|before it'?s too late|hurry|act (?:now|fast|today)|last chance|limited time|today only|while (?:spots|stocks?|supplies) last|running out|don'?t miss out)\b/i;
  const sentences = out.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((s) => {
    const m = s.match(URGENCY);
    if (m && !source.includes(norm(m[0]))) {
      changes.push(`removed unsupported urgency ("${m[0].toLowerCase()}")`);
      return false;
    }
    return true;
  });
  if (kept.length && kept.length < sentences.length) out = kept.join(" ");

  out = out.replace(/\s{2,}/g, " ").replace(/\s+([.,!?])/g, "$1").trim();
  return { text: out, changes };
}

/** The script with those repairs applied to every scene the operator has not edited, the closing line and the ad copy; the closing line always matches the last thing said. */
export function repairScript(script: VideoScript, sourceText: string): VideoScript {
  const notes: string[] = [];
  const scenes: VideoScene[] = script.scenes.map((s) => {
    if (s.edited || !s.line.trim()) return s;
    const r = repairText(s.line, sourceText);
    if (r.changes.length) notes.push(`Scene ${s.number}: ${[...new Set(r.changes)].join(", ")}.`);
    return r.changes.length ? { ...s, line: r.text } : s;
  });
  const copy = (value: string, label: string) => {
    const r = repairText(value, sourceText);
    if (r.changes.length) notes.push(`${label}: ${[...new Set(r.changes)].join(", ")}.`);
    return r.text;
  };
  const adCopy = { ...script.adCopy, primaryText: copy(script.adCopy.primaryText, "Ad copy"), headline: copy(script.adCopy.headline, "Headline"), description: copy(script.adCopy.description, "Description") };
  // The closing line is whatever is said last.
  const lastSpoken = [...scenes].reverse().find((s) => s.line.trim())?.line;
  const cta = script.cta ? { ...script.cta, spoken: lastSpoken ?? script.cta.spoken } : script.cta;
  if (!notes.length && (!cta || cta.spoken === script.cta?.spoken)) return script;
  return { ...script, scenes, adCopy, ...(cta ? { cta } : {}), warnings: [...script.warnings, ...notes.map((n) => `Corrected automatically: ${n}`)] };
}
