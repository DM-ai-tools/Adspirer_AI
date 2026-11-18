import { isStillAction, STATIC_CAMERA } from "@/lib/video/visual-rules";
import type { PlanCharacter, SceneBrief } from "@/lib/video/pipeline-types";

/**
 * Guards for the prompt sent to the video model. Each one answers a failure seen in a real run
 * ("The Translator", clip 2): a person who speaks on camera with no picture of them attached (the model invented a
 * new face), no language named (the model spoke Mandarin), a man given a female voice, and shots written as still
 * ("the camera holds on the empty chairs" for nine seconds of voiceover, which came out as frozen frames).
 * Everything here is pure, so each guard is tested against the real data.
 */

// ------------------------------------------------------------------ language

const ACCENT: Record<string, string> = {
  "en-au": "an Australian English accent",
  "en-us": "an American English accent",
  "en-gb": "a British English accent",
  "en-nz": "a New Zealand English accent",
};

export function accentFor(locale: string): string {
  return ACCENT[locale.toLowerCase()] ?? "a natural accent";
}

/** The spoken language of a locale such as "en-AU" or "es-ES". Anything that cannot be read is English. */
export function languageFor(locale: string): { language: string; accent: string | null } {
  const lang = (locale ?? "").trim().replace(/_/g, "-").split("-")[0].toLowerCase();
  let language = "English";
  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(lang);
    if (name && name.toLowerCase() !== lang) language = name;
  } catch {
    /* an unreadable locale is English */
  }
  const accent = language === "English" ? accentFor(locale ?? "") : null;
  return { language, accent };
}

/**
 * The video model is trained mostly on Chinese video: told nothing, it may speak Chinese and translate the quoted
 * lines. So the language is named once, up front, and the quoted words are said to be exact.
 */
export function languageRule(locale: string): string {
  const { language, accent } = languageFor(locale);
  const others = language === "English" ? "Chinese or any other language" : "any other language";
  return `Language: every spoken word, on camera or off, is in ${language}${accent ? ` with ${accent}` : ""}. The quoted lines are the exact words: say each one in ${language}, word for word, never translated and never in ${others}.`;
}

/** The last line before the clip ends: the language, said a second time where the model reads last. */
export function languageReminder(locale: string): string {
  return `All speech in this clip is ${languageFor(locale).language}, word for word as quoted.`;
}

// ------------------------------------------------------------------ people

const norm = (s: string) =>
  (s ?? "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:the|a|an) /, "");

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The names a character goes by in the plan's own text: its id and its role, with "the" dropped. */
function nameKeys(c: PlanCharacter): string[] {
  const keys = [norm(c.id), norm(c.role), norm((c.role ?? "").split(/[,(:–—-]/)[0])];
  return [...new Set(keys.filter((k) => k.length >= 3))];
}

const mentionedIn = (text: string, c: PlanCharacter) => {
  const flat = ` ${norm(text)} `;
  return nameKeys(c).some((k) => new RegExp(`\\b${escape(k)}\\b`).test(flat));
};

/** The character a voice belongs to ("new arrival" is the voice of the character New Arrival), or null. */
export function characterOfVoice(characters: PlanCharacter[], who: string): PlanCharacter | null {
  return characters.find((c) => mentionedIn(who, c)) ?? null;
}

const EMPTY_SHOT = /\b(empty|deserted|vacant|nobody|no one)\b/i;

/**
 * Everyone who is in a scene: its main character, anyone the shot is written to show (named in the subject,
 * framing, action or setting) and anyone who speaks on camera (found by the name of their voice). A scene's
 * characterId names one person only, so a two-shot, or an answer from someone who just walked in, would otherwise
 * be filmed with no picture of that person.
 */
export function sceneCharacterIds(characters: PlanCharacter[], brief: Pick<SceneBrief, "characterId" | "subject" | "framing" | "action" | "setting">, onCameraSpeakers: string[] = []): string[] {
  const out = new Set<string>();
  if (brief.characterId) out.add(brief.characterId);
  const text = [brief.subject, brief.framing, brief.action, brief.setting].filter(Boolean).join(" . ");
  // A shot of an empty place shows no one, even when the place is where a person just was.
  if (!brief.characterId && !onCameraSpeakers.length && EMPTY_SHOT.test(brief.subject ?? "")) return [];
  for (const c of characters) if (mentionedIn(text, c)) out.add(c.id);
  for (const who of onCameraSpeakers) {
    const c = characterOfVoice(characters, who);
    if (c) out.add(c.id);
  }
  return characters.filter((c) => out.has(c.id)).map((c) => c.id).concat([...out].filter((id) => !characters.some((c) => c.id === id)));
}

// ------------------------------------------------------------------ voices

type Gender = "male" | "female";

function genderOf(text: string): Gender | null {
  if (/\b(female|woman|girl|she|her)\b/i.test(text)) return "female";
  if (/\b(male|man|boy|he|his)\b/i.test(text)) return "male";
  return null;
}

const SWAP: Record<string, string> = { female: "male", woman: "man", girl: "boy", male: "female", man: "woman", boy: "girl" };

/**
 * A voice described as one gender for a person shown as the other makes the model pick one and lose the other.
 * The person on screen is the fact; the voice description is changed to match it.
 */
export function reconcileVoicesWithCast<T extends { who: string; description: string }>(voices: T[], characters: PlanCharacter[]): T[] {
  return voices.map((v) => {
    const person = characterOfVoice(characters, v.who);
    if (!person) return v;
    const shown = genderOf(person.description);
    const voiced = genderOf(v.description);
    if (!shown || !voiced || shown === voiced) return v;
    const description = /\b(female|male|woman|man|girl|boy)\b/i.test(v.description)
      ? v.description.replace(/\b(female|male|woman|man|girl|boy)\b/i, (m) => {
          const to = SWAP[m.toLowerCase()];
          return m[0] === m[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to;
        })
      : `${shown === "male" ? "Male" : "Female"}, ${v.description}`;
    return { ...v, description };
  });
}

// ------------------------------------------------------------------ movement

/** A shot size or angle written as static ("Wide static shot") loses the word; the camera line carries the move. */
export function liveFraming(framing: string): string {
  const flat = framing.replace(/\s+/g, " ").trim();
  const out = flat
    .replace(/\b(?:static|locked[- ]?off|stationary|tripod(?:[- ]mounted)?)\s+/gi, "")
    .replace(/,?\s+and still\b/gi, "")
    .replace(/\s+,/g, ",")
    .trim();
  return out || "Medium shot";
}

const CAMERA_HOLDS = /\b(?:the )?camera (?:holds?|lingers?|rests?|stays?|remains?|stares?) (on|at|over)\b/i;

/**
 * An action that leaves the video model nothing to move. A camera that "holds on" something becomes one that
 * drifts across it with the light and dust moving; a person who "sits perfectly still" keeps breathing and shifting.
 */
export function liveAction(action: string): string {
  const flat = action.replace(/\s+/g, " ").trim();
  if (!flat || !isStillAction(flat)) return flat;
  if (CAMERA_HOLDS.test(flat)) {
    const out = flat.replace(CAMERA_HOLDS, "The camera drifts slowly across");
    return `${out.replace(/[.\s]+$/, "")}, the light flickering and dust moving in the air`;
  }
  return `${flat.replace(/[.\s]+$/, "")}, never frozen: breathing, shifting their weight, small natural movements`;
}

// ------------------------------------------------------------------ the check before the money is spent

export type PromptCheck = {
  prompt: string;
  /** True when anyone speaks in this clip. */
  speaks: boolean;
  /** Characters who appear in this clip. */
  requiredPeople: string[];
  /** Characters whose reference picture is attached to the request. */
  attachedPeople: string[];
};

/**
 * What must be true of a clip's prompt before it is sent (a clip costs about $10). Returns the problems, empty when
 * the prompt is good. Each rule is a failure that already cost a clip.
 */
export function lintClipPrompt(input: PromptCheck): string[] {
  const problems: string[] = [];
  if (input.speaks && !/^Language:/m.test(input.prompt)) problems.push("The prompt does not say which language is spoken, so the video model may speak Chinese.");
  for (const id of input.requiredPeople) {
    if (!input.attachedPeople.includes(id)) problems.push(`"${id}" appears in this clip but no reference picture of them is attached, so the model would invent a new face.`);
  }
  for (const line of input.prompt.split("\n")) {
    const m = line.match(/^\d+s-\d+s: Shot (\d+)\./);
    if (!m) continue;
    const cut = line.indexOf("Light:");
    const filmed = (cut > 0 ? line.slice(0, cut) : line).replace(/"[^"]*"/g, "");
    if (STATIC_CAMERA.test(filmed) || /\bcamera (?:holds?|lingers?) on\b/i.test(filmed)) problems.push(`Shot ${m[1]} is written with a static camera or a held frame, which comes out as frozen footage.`);
    if (!/Movement:/.test(line)) problems.push(`Shot ${m[1]} has no movement line.`);
  }
  return problems;
}

// ------------------------------------------------------------------ the language that was heard

const SCRIPTS: Array<[RegExp, string]> = [
  [/\p{Script=Han}/u, "Chinese"],
  [/[\p{Script=Hiragana}\p{Script=Katakana}]/u, "Japanese"],
  [/\p{Script=Hangul}/u, "Korean"],
  [/\p{Script=Cyrillic}/u, "Russian"],
  [/\p{Script=Arabic}/u, "Arabic"],
  [/\p{Script=Devanagari}/u, "Hindi"],
  [/\p{Script=Thai}/u, "Thai"],
  [/\p{Script=Hebrew}/u, "Hebrew"],
  [/\p{Script=Greek}/u, "Greek"],
];

/**
 * The language the clip was spoken in when it is not the script's: found from the letters of the transcript, for
 * a script written in the Latin alphabet. Null when the transcript is in the script's own writing system.
 */
export function wrongLanguageHeard(expected: string, heard: string): string | null {
  const letters = (t: string) => [...t].filter((ch) => /\p{L}/u.test(ch));
  const isLatin = (ch: string) => /\p{Script=Latin}/u.test(ch);
  const wanted = letters(expected);
  if (!wanted.length || wanted.filter(isLatin).length / wanted.length < 0.8) return null;
  const got = letters(heard);
  if (got.length < 6) return null;
  const foreign = got.filter((ch) => !isLatin(ch));
  if (foreign.length / got.length < 0.3) return null;
  const sample = foreign.join("");
  return SCRIPTS.find(([re]) => re.test(sample))?.[1] ?? "another language";
}
