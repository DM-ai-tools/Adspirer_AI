/**
 * Deterministic editorial checks for a spoken video-ad script.
 *
 * These are CHECKS, not a template. Every detector looks for a tell (a default opening, stacked
 * slogans, a rhetorical-question habit, "not X but Y", lists of three, jargon, an invented
 * personal experience, invented urgency or a free offer, three scripts that are one idea
 * reworded, a cliche visual) and says what is wrong and what to change. A `fix` is always an
 * instruction. No detector supplies replacement copy, and the word lists below exist only to
 * recognise bad output, never to produce good output.
 *
 * Pure, regex and structure based, no network. Severity:
 *   hard  - the script must not ship (invented facts, offers or experience, a duplicate angle)
 *   major - the script should be rewritten before it ships
 *   minor - worth a look
 */

export type QualityFinding = { code: string; severity: "hard" | "major" | "minor"; scene: number | null; message: string; fix: string; quote?: string };
export type SpokenLine = { scene: number; line: string };

type Severity = QualityFinding["severity"];

const finding = (code: string, severity: Severity, scene: number | null, message: string, fix: string, quote?: string): QualityFinding => {
  const f: QualityFinding = { code, severity, scene, message, fix };
  if (quote) f.quote = quote.trim().slice(0, 160);
  return f;
};

// ------------------------------------------------------------------ text helpers

const wc = (s: string) => s.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
const sentencesOf = (line: string) => line.split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter(Boolean);
const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Lowercase, no apostrophes, punctuation to spaces: for comparing wording against a source. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘`']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
const inSource = (srcNorm: string, phrase: string) => {
  const p = normalise(phrase);
  return p.length > 0 && ` ${srcNorm} `.includes(` ${p} `);
};

const STOP = new Set(
  (
    "a an the and or but if so then than that this these those it its it's i me my we our us you your he she they them their his her " +
    "is are was were be been being am do does did done have has had having will would can could should may might must shall " +
    "of in on at to for from by with about as into over under up down out off just very really too also not no yes " +
    "there here when where what which who whom how why all any some each every both more most much many one two " +
    "get got go goes going went make makes made say says said let lets like only own same such now still even ever " +
    "don't doesn't didn't isn't aren't wasn't weren't won't can't couldn't wouldn't shouldn't i'm i've i'll i'd you're you've you'll we're we've we'll they're they've " +
    "thing things way ways lot lots bit new back again after before while because though although yet till until"
  ).split(/\s+/),
);

/** Words that mean the same thing for comparing two scripts ("struggling" and "tired" are one idea). */
const SYNONYM_GROUPS: string[][] = [
  ["struggling", "tired", "exhausted", "frustrated", "stuck", "overwhelmed", "drained", "fed"],
  ["cost", "price", "expensive", "fee", "spend", "spent", "invoice", "bill"],
  ["fast", "quick", "rapid", "speedy", "swift", "immediate"],
  ["help", "assist", "support", "aid"],
  ["customer", "client", "buyer", "shopper", "patient", "guest"],
  ["business", "company", "firm", "brand", "shop", "store"],
  ["grow", "increase", "boost", "raise", "improve", "lift", "climb", "rise"],
  ["save", "cut", "reduce", "lower", "slash", "trim"],
  ["easy", "simple", "effortless", "straightforward", "painless"],
  ["problem", "issue", "trouble", "headache", "challenge", "pain", "mess"],
  ["start", "begin", "launch", "kick"],
  ["call", "phone", "ring", "contact", "reach"],
  ["book", "schedule", "reserve", "appointment"],
  ["waste", "leak", "lose", "lost", "throw"],
];

const doubled = (w: string) => /([^aeioulsz])\1$/.test(w);

function rawStem(word: string): string {
  let w = word;
  if (w.length <= 3) return w;
  if (w.endsWith("ies") && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("ing") && w.length > 5) {
    w = w.slice(0, -3);
    if (doubled(w)) w = w.slice(0, -1);
  } else if (w.endsWith("ed") && w.length > 4) {
    w = w.slice(0, -2);
    if (doubled(w)) w = w.slice(0, -1);
  } else if (/(?:s|x|z|ch|sh)es$/.test(w) && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) w = w.slice(0, -1);
  if (w.endsWith("ly") && w.length > 5) w = w.slice(0, -2);
  if (w.endsWith("e") && w.length > 3) w = w.slice(0, -1);
  return w;
}

const SYN = new Map<string, string>();
for (const g of SYNONYM_GROUPS) for (const w of g) if (!SYN.has(rawStem(w))) SYN.set(rawStem(w), rawStem(g[0]));

const stem = (word: string): string => {
  const r = rawStem(word);
  return SYN.get(r) ?? r;
};

/** Lowercased, stop words removed, lightly stemmed, with common synonyms folded together. */
export function contentWords(text: string): string[] {
  const tokens = text.toLowerCase().replace(/[’‘]/g, "'").match(/[a-z0-9][a-z0-9']*/g) ?? [];
  const out: string[] = [];
  for (const t of tokens) {
    if (STOP.has(t)) continue;
    const clean = t.replace(/'s$/, "").replace(/'/g, "");
    if (clean.length < 2 || STOP.has(clean)) continue;
    out.push(stem(clean));
  }
  return out;
}

export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 || B.size === 0) return 0;
  let both = 0;
  for (const x of A) if (B.has(x)) both += 1;
  return both / (A.size + B.size - both);
}

/** A digit, a quotation, or a proper noun that is not just the first word of the sentence. */
function hasConcreteAnchor(sentence: string): boolean {
  if (/\d/.test(sentence) || /["“”]/.test(sentence)) return true;
  const rest = sentence.trim().replace(/^\S+\s*/, "").replace(/\bI\b/g, "");
  return /\b[A-Z][a-z]+/.test(rest);
}

// ------------------------------------------------------------------ openings

const OPENING_CLICHES: Array<[RegExp, string]> = [
  [/\bin today'?s\b.{0,25}\b(world|age|market|landscape|economy|era)\b/i, "a stock \"in today's world\" opening"],
  [/\bfast[- ]paced\b/i, "a \"fast-paced world\" opening"],
  [/\b(take|bring|grow|elevate|push)\b.{0,30}\bto the next level\b/i, "a \"next level\" promise"],
  [/\bunlock (the )?(power|potential|secret|secrets)\b/i, "an \"unlock the power\" opening"],
  [/\bthis (changes|is going to change) everything\b/i, "a \"this changes everything\" opening"],
  [/\bare you tired of\b/i, "an \"are you tired of\" opening"],
  [/\b(what if i told you|did you know( that)?|picture this|imagine (if|a world|having|this)|ever wondered|have you ever (wondered|wished|thought))\b/i, "a stock attention-getter"],
  [/\b(look no further|say goodbye to|you won'?t believe|stop scrolling|the secret (to|of)|the truth about)\b/i, "a stock attention-getter"],
];

const ABSTRACT = new Set(
  (
    "success growth grow results potential journey solution solutions business businesses brand world future better best great amazing goals dreams " +
    "performance efficiency impact value strategy level transform transformation possibilities opportunity opportunities leading innovative marketing digital " +
    "productivity excellence quality passion vision reach online presence audience customers revenue profit scale thrive win winning"
  ).split(/\s+/),
);

/** Findings for the very first spoken line. */
export function openingFindings(first: string): QualityFinding[] {
  const text = first.trim();
  if (!text) return [];
  const out: QualityFinding[] = [];
  const firstSentence = sentencesOf(text)[0] ?? text;
  const n = wc(text);

  if (/\b(this is (an? )?(ad|advert|advertisement|commercial|video)|in this (video|ad)|welcome to (our|my|the) (video|channel)|(watch|check out) (this|our) (video|ad)|(an?|our|this) (ad|advert|commercial) (for|from|about))\b/i.test(text)) {
    out.push(finding("opening_announces_ad", "hard", 1, "The opening announces that this is an ad or a video. Viewers leave at the first sign of one.", "Start inside the situation or the point itself. Do not mention the format.", firstSentence));
  }
  if (/^\s*(hey|hi|hello|hiya|yo|what'?s up|good (morning|afternoon|evening))\b/i.test(text)) {
    out.push(finding("opening_greeting", "major", 1, "The opening is a greeting. A greeting spends the first seconds saying nothing.", "Cut the greeting and begin with the first thing that is true or surprising.", firstSentence));
  }
  if (/^\s*(attention|calling all|listen up|hey|hi|hello|dear|to all)\b[\s,]+(?:\w+\s+){0,3}(owners?|entrepreneurs?|marketers?|founders?|managers?|moms?|mums?|dads?|parents|businesses|professionals|everyone|folks|guys|people|friends|homeowners|drivers|students|agencies|shoppers)\b/i.test(text)) {
    out.push(finding("opening_group_address", "major", 1, "The opening addresses a whole group by label. It sounds like a loudspeaker, not a person.", "Talk to one person in one specific moment instead of naming the audience.", firstSentence));
  }
  for (const [re, label] of OPENING_CLICHES) {
    const m = text.match(re);
    if (m) out.push(finding("opening_cliche", "major", 1, `The opening is ${label}. It is the default way these ads start.`, "Replace it with something only this offer's viewer would recognise from their own week.", m[0]));
  }
  if (/\b(are you|do you|have you|is your|does your)\b[^.?!]{0,50}\b(struggl\w*|tired of|sick of|fed up|frustrated|looking for|ready to|want to|need to|trying to)\b/i.test(text) && /\?/.test(text)) {
    out.push(finding("opening_asks_struggle", "major", 1, "The opening asks the viewer whether they are struggling. Everyone has scrolled past this question a thousand times.", "State the situation as a fact instead of asking about it, and make it specific.", firstSentence));
  }
  if (/\b(let me tell you|i want to (tell|share|talk)|i'?d like to (tell|share|talk)|let me (show|introduce|explain)|allow me to|i'?m here to (tell|show))\b/i.test(text)) {
    out.push(finding("opening_announces_pitch", "major", 1, "The opening announces that a pitch is coming instead of starting it.", "Delete the announcement and begin with the content.", firstSentence));
  }
  const brandFirst = /^\s*(?!(?:It|This|That|There|He|She|They|One|Here|What|Everything|Nothing|Someone|Everyone|Anyone|If|When|We|You|I|My|Our|Your|The|A|An|So|But|And|Most|Some|Every|Each|No|Not|Why|How)\b)[A-Z][\w&.'’-]*(?:\s[A-Z][\w&.'’-]*){0,3}\s(?:is|are|offers?|provides?|helps?|brings?|presents?|introduces?|delivers?|has|makes?|gives?|specialises?|specializes?|was founded)\b/;
  if (/^\s*(introducing|meet|presenting|welcome to|say hello to)\b/i.test(text) || brandFirst.test(text)) {
    out.push(finding("opening_brand_first", "major", 1, "The opening names the brand before giving the viewer any reason to listen.", "Open on the viewer's situation or the claim; let the name come after the reason to care.", firstSentence));
  }
  const isQuestion = /\?\s*$/.test(firstSentence);
  const words = contentWords(firstSentence);
  const abstractCount = words.length ? (firstSentence.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => ABSTRACT.has(w)).length : 0;
  const anchored = hasConcreteAnchor(firstSentence);
  if (isQuestion && wc(firstSentence) <= 10 && !anchored && (abstractCount >= 1 || words.length <= 2)) {
    out.push(finding("opening_generic_question", "major", 1, "The opening is only a generic question with nothing concrete in it.", "Put a specific person, object, number or moment into the opening instead of a question.", firstSentence));
  }
  if (n > 22) {
    out.push(finding("opening_too_long", "major", 1, `The opening runs ${n} words before the viewer knows what this is about.`, "Cut it to one short, spoken sentence that carries a single idea.", clip(text)));
  }
  if (!anchored && words.length >= 2 && abstractCount >= 2 && abstractCount / words.length >= 0.3) {
    out.push(finding("opening_vague", "major", 1, "The opening is made of abstract words and has no concrete person, object, place or number.", "Name something that could be filmed: a specific object, action, number or moment.", firstSentence));
  }
  return out;
}

// ------------------------------------------------------------------ voice

const JARGON =
  /\b(leverag(?:e|es|ed|ing)|synerg(?:y|ies|istic)|seamless(?:ly)?|robust|cutting[- ]edge|world[- ]class|game[- ]?chang(?:er|ers|ing)|solutions?|empower(?:s|ed|ing|ment)?|holistic|unlock(?:s|ed|ing)?|elevat(?:e|es|ed|ing)|revolution(?:ary|ise|ize|ising|izing)|best[- ]in[- ]class|innovative|streamlin(?:e|es|ed|ing)|end[- ]to[- ]end|turnkey|scalable|paradigm|ecosystem|state[- ]of[- ]the[- ]art|transformative|unparalleled|bespoke|supercharg(?:e|es|ed|ing)|delve|tapestry|unleash(?:es|ed|ing)?|harness(?:es|ed|ing)?|effortless(?:ly)?|next[- ]level|cutting edge|mission[- ]critical|tailored|comprehensive|dynamic|premier)\b/i;

/** Phrases that read as machine-written or brochure copy. A detector list only: it rejects lines and never supplies replacements. */
const STOCK_PHRASE =
  /\b(imagine (?:if|having|a world|being|this|streamlining|how)|focus on what (?:really |truly )?matters|what (?:really |truly )?matters most|peace of mind|take (?:the|that) first step|your journey|(?:a|the) breeze|it(?:'s| is) (?:so |really |that )?easy to (?:get started|lose track|miss)|why not (?:try|give)|don'?t (?:wait|hesitate)|you(?:'ll| will) (?:wonder|love)|we(?:'re| are) here to help|we(?:'ve| have) got you covered|one[- ]stop[- ]shop|under one roof|trusted partner|your (?:smile|business|brand) deserves|can'?t wait to|make it happen|let'?s (?:work|brighten|get started)|a better way to|drowning in|never[- ]ending|real headache|takes forever|no stress|risk[- ]free)\b/i;

const FILLER = /\b(literally|honestly|basically|actually|you guys|hey guys|um+|uh+|you know|i mean|to be honest|no joke|seriously)\b/gi;
const SLANG = /\b(no cap|bussin|lowkey|highkey|goated|rizz|periodt|yeet|slay(?:s|ed|ing)?|fam|vibes?|lit af|sus|bet|fire emoji|iykyk|big mood)\b/i;
const CONTRACTION = /\b\w+(n't|'s|'re|'ll|'ve|'d|'m)\b|\b(gonna|wanna|gotta)\b/i;

const NOT_BUT: RegExp[] = [
  /\b(?:it(?:'s| is| isn'?t| is not)|that(?:'s| is| isn'?t)|this (?:is|isn'?t)|we(?:'re| are| aren'?t)|you(?:'re| are| aren'?t)|they(?:'re| are| aren'?t)|there(?:'s| is| isn'?t)) not\b[^.?!]{1,70}?(?:,|;|\.|—|–|-)?\s*\b(?:it(?:'s| is)|but|that(?:'s| is)|we(?:'re| are)|you(?:'re| are))\b/i,
  /\b(?:isn'?t|aren'?t|wasn'?t|weren'?t|doesn'?t|don'?t)\b[^.?!]{1,60}?(?:,|—|–)?\s*\b(?:it(?:'s| is)|but|they(?:'re| are)|that(?:'s| is))\b/i,
  /\bnot (?:just|only|merely|about)\b[^.?!]{1,70}?\b(?:but|it'?s|it is|also)\b/i,
  /\bnot\s+\w+(?:\s+\w+){0,3},?\s+but\b/i,
];

const SERIES_OF_THREE = /(?:^|[\s(])([\w'’-]+(?:\s[\w'’-]+){0,2}),\s+([\w'’-]+(?:\s[\w'’-]+){0,2}),?\s+(?:and|or)\s+([\w'’-]+(?:\s[\w'’-]+){0,2})(?=[\s.!?,;)]|$)/i;

const ADJECTIVE_LIKE = /^(?:\w{3,}(?:able|ible|ive|ful|less|ous|ant|ent|ic|al|est|ier|y)|fast|simple|easy|quick|smart|safe|cheap|fresh|clean|clear|solid|strong|small|big|free|new|flexible|reliable|secure)$/i;
const NOUNY = /^(?:\w{3,}(?:tion|sion|ment|ness|ity|ance|ence|ship|ics|ware|form|ing)|platform|solution|software|system|service|data|management|marketing|customer|business|enterprise|performance|growth|strategy|content|brand|workflow)s?$/i;

function passiveWebsiteCopy(sentence: string): string | null {
  const m = sentence.match(/\b(?:is|are|was|were|been|be)\s+(?:\w+ly\s+)?(?:designed|built|crafted|trusted|powered|backed|tailored|engineered|provided|offered|driven|developed|equipped|optimi[sz]ed|curated|delivered)\b/i) ?? sentence.match(/\b(?:is|are|was|were)\s+\w+ed\s+by\b/i);
  return m ? m[0] : null;
}

function nounStack(sentence: string): string | null {
  const tokens = sentence.replace(/[^\w\s'’-]/g, " ").split(/\s+/).filter(Boolean);
  let run: string[] = [];
  for (const t of tokens) {
    if (NOUNY.test(t)) {
      run.push(t);
      if (run.length >= 3) return run.join(" ");
    } else run = [];
  }
  return null;
}

/** Findings for the way the whole script sounds when read aloud. */
export function voiceFindings(lines: SpokenLine[]): QualityFinding[] {
  const out: QualityFinding[] = [];
  const spokenLines = lines.filter((l) => l.line.trim());
  const all: Array<{ scene: number; s: string }> = [];
  for (const l of spokenLines) for (const s of sentencesOf(l.line)) all.push({ scene: l.scene, s });

  // Rhetorical questions: one is a choice, a second is a habit.
  const questions = all.filter((x) => /\?["”')]*$/.test(x.s));
  if (questions.length > 1) {
    out.push(finding("rhetorical_questions", "major", questions[1].scene, `The script asks ${questions.length} questions. More than one rhetorical question reads as a formula.`, "Keep at most one question, only if the viewer would really ask it, and turn the others into statements.", questions[1].s));
    const openers = new Map<string, number>();
    for (const q of questions) {
      const w = q.s.toLowerCase().match(/[a-z']+/)?.[0] ?? "";
      openers.set(w, (openers.get(w) ?? 0) + 1);
    }
    const repeated = [...openers.entries()].find(([, c]) => c > 1);
    if (repeated) out.push(finding("repeated_question_opener", "major", null, `Two questions start with the same word ("${repeated[0]}").`, "Change one question into a statement or start it a different way."));
  }

  // Lists of exactly three.
  const lists = all.filter((x) => SERIES_OF_THREE.test(x.s) && (x.s.match(/,/g) ?? []).length <= 2);
  if (lists.length >= 3) {
    out.push(finding("lists_of_three", "major", lists[lists.length - 1].scene, `${lists.length} sentences list exactly three things. Three-item lists are a rhythm tic.`, "Keep the one list that matters and say the others with one or two items, or as a sentence.", lists[lists.length - 1].s));
  }

  // "Not X, but Y".
  const notBut = all.filter((x) => NOT_BUT.some((re) => re.test(x.s)));
  if (notBut.length > 1) {
    out.push(finding("not_x_but_y", "major", notBut[1].scene, `The "not this, it's that" construction appears ${notBut.length} times.`, "Say what the thing is directly in all but one place; do not define it by what it is not.", notBut[1].s));
  }

  // Stacked slogans: short polished fragments in a row with the same cadence.
  const flat = all.map((x) => ({ ...x, n: wc(x.s), personal: /\b(i|i'm|i've|i'd|my|we|we're|me|our)\b/i.test(x.s) }));
  const fragment = (r: (typeof flat)[number]) => r.n >= 1 && r.n <= 4 && !r.personal && /[.!]$/.test(r.s);
  for (let i = 0; i < flat.length; ) {
    if (!fragment(flat[i])) {
      i += 1;
      continue;
    }
    let j = i;
    while (j + 1 < flat.length && fragment(flat[j + 1])) j += 1;
    const run = flat.slice(i, j + 1);
    const spread = Math.max(...run.map((r) => r.n)) - Math.min(...run.map((r) => r.n));
    if (run.length >= 3 || (run.length === 2 && run.every((r) => r.n >= 2) && spread <= 1)) {
      out.push(finding("stacked_slogans", "major", run[0].scene, "Several very short polished fragments are stacked in a row. It sounds like a tagline reel, not a person talking.", "Join them into one spoken sentence, or keep one and develop it with a concrete detail.", run.map((r) => r.s).join(" ")));
    }
    i = j + 1;
  }
  for (const l of spokenLines) {
    const t = l.line.trim().replace(/[.!]$/, "");
    const ws = t.split(/\s+/);
    if (ws.length >= 3 && ws.length <= 6 && ws.every((w) => /^[A-Z]/.test(w) || /^(a|an|the|of|for|and|to|in|on|your|with)$/i.test(w)) && ws.filter((w) => /^[A-Z]/.test(w)).length >= 3) {
      out.push(finding("tagline_like", "minor", l.scene, "This line is written like a tagline, with every word capitalised.", "Say it the way a person would in a sentence.", l.line));
    }
  }

  // Stock phrases: the lines that sound like an ad written by a machine.
  for (const l of spokenLines) {
    const m = l.line.match(STOCK_PHRASE);
    if (m) out.push(finding("stock_phrase", "major", l.scene, `"${m[0]}" is a stock phrase that could sit in almost any ad.`, "Replace it with the specific thing that happens to this customer, in the words they would use.", l.line));
  }

  // Jargon and inflated adjectives.
  for (const l of spokenLines) {
    const m = l.line.match(JARGON);
    if (m) out.push(finding("jargon", "major", l.scene, `"${m[0]}" is corporate jargon or an inflated adjective. People do not talk like that.`, "Say the plain thing it stands for, using the words a customer would use.", l.line));
  }

  // Filler and fake authenticity.
  const fillers = all.flatMap((x) => [...x.s.matchAll(FILLER)].map((m) => ({ scene: x.scene, hit: m[0], s: x.s })));
  const heyGuys = fillers.find((f) => /hey guys|you guys/i.test(f.hit));
  if (fillers.length >= 2 || heyGuys) {
    const at = heyGuys ?? fillers[1];
    out.push(finding("filler_authenticity", "major", at.scene, `Filler or put-on casualness ("${at.hit.toLowerCase()}") appears ${fillers.length > 1 ? "more than once" : "in the script"}. It reads as acting at being real.`, "Delete the filler words; a plain sentence already sounds honest.", at.s));
  }
  for (const l of spokenLines) {
    const m = l.line.match(SLANG);
    if (m) out.push(finding("forced_slang", "minor", l.scene, `"${m[0]}" is slang that sounds forced coming from a brand.`, "Use the ordinary words the audience would use with a stranger.", l.line));
  }

  // Punctuation people do not speak.
  for (const l of spokenLines) {
    const m = l.line.match(/[—–;]|--|\s-\s|:(?!\d)/);
    if (m) out.push(finding("written_punctuation", "major", l.scene, "The line uses a dash, semicolon or colon. Those are written marks that make a line sound read out.", "Split it into two short sentences or join them with plain words.", l.line));
  }

  // Sentences too long to say in a breath.
  for (const x of all) {
    const n = wc(x.s);
    if (n > 20) out.push(finding("long_sentence", "major", x.scene, `A sentence runs ${n} words. Spoken sentences that long lose the listener.`, "Split it into two sentences at the natural turn.", x.s));
  }

  // Stiff: no contractions at all.
  const longEnough = spokenLines.filter((l) => wc(l.line) >= 6);
  if (longEnough.length >= 3 && longEnough.filter((l) => CONTRACTION.test(l.line)).length / longEnough.length < 0.3) {
    out.push(finding("no_contractions", "major", null, "Almost no line uses a contraction (I'm, it's, didn't), so it sounds stiff and read out.", "Contract the words the way a person would when saying it aloud."));
  }

  // Website copy.
  for (const x of all) {
    const passive = passiveWebsiteCopy(x.s);
    if (passive) out.push(finding("website_copy", "major", x.scene, `"${passive}" is passive, the way a website describes itself.`, "Say who does what, in the active voice.", x.s));
    const series = x.s.match(/\b([a-z]+),\s+([a-z]+),?\s+(?:and|&)\s+([a-z]+)\b/i);
    if (series && [series[1], series[2], series[3]].filter((w) => ADJECTIVE_LIKE.test(w)).length >= 2 && !/^(we|i|you|they)$/i.test(series[1])) {
      out.push(finding("website_copy", "major", x.scene, "A string of three adjectives, like a website's feature list.", "Pick the one quality that is true and show it with an example.", x.s));
    }
    const stack = nounStack(x.s);
    if (stack) out.push(finding("website_copy", "major", x.scene, `"${stack}" is a stack of nouns, the way a product page is written.`, "Turn it into a sentence with a person doing something.", x.s));
  }

  // Monotone rhythm.
  const lengths = all.map((x) => wc(x.s));
  if (lengths.length >= 5) {
    const sorted = [...lengths].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const near = lengths.filter((n) => Math.abs(n - median) <= 1).length / lengths.length;
    if (near >= 0.7) {
      out.push(finding("monotone_rhythm", "minor", null, `Most sentences are about ${median} words long, so the rhythm is monotone.`, "Vary the length: let one sentence run on and let another be very short."));
    }
  }

  return out;
}

// ------------------------------------------------------------------ invented experience

const EXPERIENCE: Array<[RegExp, string]> = [
  [/\b(?:i|we|i'?ve|we'?ve)\s+(?:(?:have|had|just|actually|recently|finally|personally|both)\s+)*(?:used|tried|tested|switched to|signed up (?:for|with)|bought|hired|worked with|joined|started using|began using|installed|ordered|subscribed to)\b/i, "using or buying the product"],
  [/\bsince (?:i|we) (?:started|began|joined|switched|signed|hired|moved)\b/i, "a result since starting"],
  [/\bi was (?:skeptical|sceptical|doubtful|unsure|hesitant|nervous|a skeptic|a sceptic)\b/i, "a conversion story"],
  [/\bi'?m (?:a|an) (?:happy |long[- ]?time |satisfied |loyal |proud )?(?:customer|client|user|member|patient)\b|\bwe'?re (?:a )?(?:happy |long[- ]?time |satisfied |loyal )?(?:customers?|clients?|users?)\b|\bi'?ve been (?:a|using|with)\b/i, "being a customer"],
  [/\b(?:it|this|that) (?:changed|saved|transformed|fixed) (?:my|our)\b/i, "a result"],
];
const FIRST_PERSON_RESULT: RegExp[] = [
  /\b(?:my|our)\s+(?:\w+\s+){0,2}(?:business|sales|revenue|traffic|leads|income|bookings|profits?|results|rankings?|followers|clients|customers|orders|savings)\s+(?:\w+\s+){0,2}(?:grew|doubled|tripled|jumped|went up|increased|improved|exploded|skyrocketed|climbed|rose|are up|is up|shot up|went through the roof)\b/i,
  /\bi\s+(?:have\s+)?(?:saved|made|earned|gained|got|lost|cut|doubled|tripled|grew|increased|boosted|reduced)\s+(?:\w+\s+){0,4}(?:\d|\$|%|more|twice|double|triple|thousand|hundreds?)/i,
  /\bwe\s+(?:have\s+)?(?:saved|made|earned|gained|got|doubled|tripled|grew|increased|boosted|reduced)\s+(?:\w+\s+){0,4}(?:\d|\$|%|twice|double|triple|thousand|hundreds?)/i,
  /\b(?:i|we)\s+(?:finally\s+)?(?:got|saw|started getting|started seeing)\s+(?:\w+\s+){0,3}(?:results|customers|clients|leads|bookings|sales)\b/i,
  /\b(?:it|this|that) (?:changed|saved|transformed|fixed) (?:my|our)\b/i,
  /\bsince (?:i|we) (?:started|began|joined|switched|signed)\b/i,
  // A presenter endorsing the product or reporting an outcome, which would read as a real customer's testimonial.
  /\b(?:works?|worked) (?:so well |really well )?for me\b/i,
  /\b(?:reach(?:ed|ing)|hit(?:ting)?|achiev(?:ed|ing)) my (?:goals?|targets?|weight|results)\b/i,
  /\b(?:fills?|filled) me with\b/i,
  /\bi(?:'ve| have)? (?:felt|feel) (?:so much )?(?:stronger|better|healthier|more confident|great|amazing)\b/i,
  /\bi (?:just |recently )?(?:booked|signed up|joined|used|switched to|started using)\b/i,
  /\bnow,? i (?:can|know|don'?t have to|barely|finally)\b/i,
  // "With <Product>, I can ...": a presenter speaking as someone who uses it (case-sensitive on purpose: the product is a proper noun).
  /\bWith [A-Z][\w-]+(?: [A-Z][\w-]+)?,? I (?:can|now|just|barely|finally|don'?t|actually)\b/,
  /\bi can actually (?:take|get|finally|relax|breathe|sleep)\b/i,
];
const INVENTED_CUSTOMERS: RegExp[] = [
  // Customers or patients shown as happy or served, which nothing in the sources says happened.
  /\b(?:another|one more|a) (?:very |really )?(?:happy|satisfied|delighted) (?:customer|client|patient|homeowner|member)\b/i,
  /\b(?:our |the |your )?(?:patients|customers|clients|members) (?:leave|walk (?:away|out)|go home|are) (?:so |really |all )?(?:happy|smiling|thrilled|delighted|satisfied)\b/i,
  /\bit(?:'s| is) (?:so |really )?(?:great|lovely|rewarding|wonderful) (?:to be )?seeing (?:our |the )?(?:patients|customers|clients|people)\b/i,
  /\byou(?:'re| are) (?:thriving|crushing it|winning)\b/i,
  /\b(?:our|my) (?:customers|clients|users|members|patients|students) (?:say|tell|love|rave|report|swear|keep telling|always say|are saying)\b/i,
  /\b(?:thousands|hundreds|millions|dozens) of (?:happy |satisfied |loyal |delighted )?(?:customers|clients|users|people|businesses|owners|families|members)\b/i,
  /\b(?:5|five)[- ]star (?:reviews?|rated|rating)\b/i,
  /\bcustomers (?:love|swear by|rave about)\b/i,
  /\bwhat (?:our|my) (?:customers|clients) (?:say|are saying)\b/i,
  /\bjoin (?:thousands|hundreds|millions)\b/i,
  /\btrusted by\b/i,
];

export function experienceFindings(lines: SpokenLine[], ctx: { dramatisation: boolean; sourceText: string }): QualityFinding[] {
  const out: QualityFinding[] = [];
  const src = normalise(ctx.sourceText);
  const seen = new Set<string>();
  const push = (f: QualityFinding) => {
    const key = `${f.code}|${f.scene}|${f.quote}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(f);
    }
  };

  for (const l of lines) {
    for (const s of sentencesOf(l.line)) {
      const supported = (phrase: string) => inSource(src, phrase) || inSource(src, s);
      for (const re of FIRST_PERSON_RESULT) {
        const m = s.match(re);
        if (m && !supported(m[0])) {
          push(
            ctx.dramatisation
              ? finding("fabricated_result", "hard", l.scene, "A person in the acted scene claims a result in the first person. A dramatisation can show a situation but must not claim an outcome.", "Take the result out of the character's mouth; show the situation and let the offer's real, sourced facts carry the claim.", s)
              : finding("fabricated_experience", "hard", l.scene, "The script has a person claim a result they got. Nothing in the source says this happened, and it would read as a real testimonial.", "Remove the first-person result, or use a real testimonial word for word from the source and say whose it is.", s),
          );
        }
      }
      if (!ctx.dramatisation) {
        for (const [re, label] of EXPERIENCE) {
          const m = s.match(re);
          if (m && !supported(m[0])) {
            push(finding("fabricated_experience", "hard", l.scene, `A first-person claim of ${label}. It is not in the source, and the speaker is not a real customer.`, "Rewrite it from the viewer's point of view or as an observation about the situation, not as something the speaker lived.", s));
          }
        }
      }
      for (const re of INVENTED_CUSTOMERS) {
        const m = s.match(re);
        if (m && !supported(m[0])) {
          push(finding("invented_customers", "hard", l.scene, "The script cites customers, reviews or trust that the source does not contain.", "Remove it, or use only the proof the source states, worded the way the source words it.", s));
        }
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ offers, urgency, numbers

const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december";
const DAYS = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";

const OFFER_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: "urgency", re: /\b(?:limited[- ]time|only today|today only|this week only|last chance|spots (?:are )?(?:filling|limited|going)|(?:filling|selling|running) (?:up )?(?:fast|out)|ends? (?:soon|tonight|today|tomorrow)|expires?(?: soon| today| tonight)?|before it'?s gone|while supplies last|act now|hurry|don'?t (?:miss out|wait)|limited (?:spots|availability|offer|stock|seats|run)|now or never|for a limited|only \d+ (?:left|spots|seats)|offer ends)\b/gi },
  { kind: "free", re: /(?<![\w-])free(?![\w-])(?:\s+([a-z]+))?/gi },
  { kind: "free", re: /\b(?:no (?:cost|charge|obligation|commitment|strings)|at no cost|complimentary|zero cost|on the house)\b/gi },
  { kind: "discount", re: /\b\d{1,3}\s?%\s*(?:off|discount)\b|\b(?:discount(?:ed)?|coupon|promo(?: code)?|half[- ]price|buy one,? get one|bogo|markdown|special offer|sale price|on sale)\b|\bsav(?:e|ing|ings)\s+(?:up to\s+)?(?:\$|€|£)?\d[\d,.]*/gi },
  { kind: "guarantee", re: /\b(?:guarantee[ds]?|money[- ]back|risk[- ]free|no[- ]risk|refund(?:s|ed)?|or your money)\b/gi },
  { kind: "superlative", re: /\b(?:best|#1|number (?:one|1)|no\.? ?1|top[- ](?:rated|ranked)|world'?s (?:best|largest|first|leading)|most trusted|award[- ]winning|(?:the|a|america'?s|\w+'s) leading(?! (?:to|you|us|me|up|the way))\b)/gi },
  { kind: "deadline", re: new RegExp(`\\b(?:by|before|until|through|ends?|expires?|deadline)\\s+(?:the\\s+)?(?:${DAYS}|tomorrow|tonight|midnight|end of (?:the )?(?:day|week|month|year)|(?:${MONTHS})(?:\\s+\\d{1,2}(?:st|nd|rd|th)?)?|\\d{1,2}(?:st|nd|rd|th)?\\s+of\\s+\\w+)\\b`, "gi") },
];

const WORD_NUMBERS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90, hundred: 100,
};

function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) out.add(m[0].replace(/,/g, "").replace(/\.$/, ""));
  for (const m of text.toLowerCase().matchAll(new RegExp(`\\b(${Object.keys(WORD_NUMBERS).join("|")})\\b`, "g"))) out.add(String(WORD_NUMBERS[m[1]]));
  return out;
}

/** "free audit" is supported by "free 30 minute audit": the same noun follows "free" within a few words. */
function freeSupported(srcNorm: string, noun: string): boolean {
  const n = normalise(noun);
  return new RegExp(`(?:^| )free(?: [a-z0-9]+){0,3}? ${n}(?: |$)`).test(srcNorm);
}

export function offerFindings(lines: SpokenLine[], ctx: { sourceText: string }): QualityFinding[] {
  const out: QualityFinding[] = [];
  const src = normalise(ctx.sourceText);
  const srcNumbers = numbersIn(ctx.sourceText);
  const srcHasOffWord = /\b(off|discount|save|saving|savings|sale)\b/i.test(ctx.sourceText);
  const seen = new Set<string>();
  const push = (f: QualityFinding, key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(f);
  };
  const MESSAGES: Record<string, [string, string]> = {
    urgency: ["urgency or scarcity wording that the source does not support", "Remove the urgency. Give the viewer a real reason to act that the source states, or none."],
    free: ["an offer of something free or at no cost that the source does not offer", "Remove the free offer unless the source names it, and then use the source's own wording."],
    discount: ["a discount or saving that the source does not state", "Remove the discount; only say a price benefit the source states."],
    guarantee: ["a guarantee that the source does not give", "Remove the guarantee; do not promise an outcome or a refund the source does not."],
    superlative: ["a best, number one or leading claim that the source does not make", "Remove the superlative and say the specific, checkable thing instead."],
    deadline: ["a deadline that the source does not state", "Remove the deadline; do not invent a date by which the viewer must act."],
  };

  for (const l of lines) {
    const flaggedDiscountNumbers = new Set<string>();
    for (const { kind, re } of OFFER_PATTERNS) {
      for (const m of l.line.matchAll(re)) {
        const hit = m[0].trim();
        let supported: boolean;
        if (kind === "free" && /^free\b/i.test(hit)) {
          const next = (m[1] ?? "").toLowerCase();
          const skip = !next || ["and", "to", "for", "of", "with", "in", "on", "a", "the", "or", "when", "if", "you", "your", "now", "today"].includes(next);
          supported = skip ? inSource(src, "free") : freeSupported(src, next);
        } else if (kind === "discount") {
          const num = hit.match(/\d[\d,.]*/)?.[0].replace(/,/g, "").replace(/\.$/, "");
          if (num) flaggedDiscountNumbers.add(num);
          supported = inSource(src, hit) || (num ? srcNumbers.has(num) && srcHasOffWord : false);
        } else {
          supported = inSource(src, hit);
        }
        if (!supported) {
          const [what, fix] = MESSAGES[kind];
          push(finding("unsupported_offer", "hard", l.scene, `"${hit}" is ${what}.`, fix, clip(l.line)), `${l.scene}|${kind}|${normalise(hit)}`);
        }
      }
    }
    // Specific numbers and prices.
    for (const m of l.line.matchAll(/(?:[$€£]\s?)?\d[\d,]*(?:\.\d+)?(?:\s?(?:%|k\b|m\b|b\b|x\b|million|billion|thousand))?/gi)) {
      const raw = m[0];
      const digits = raw.replace(/[^\d.]/g, "").replace(/\.$/, "");
      if (!digits || flaggedDiscountNumbers.has(digits)) continue;
      const after = l.line.slice((m.index ?? 0) + raw.length, (m.index ?? 0) + raw.length + 3).toLowerCase();
      if (/^(st|nd|rd|th)/.test(after)) continue;
      if (/^(19|20)\d\d$/.test(digits) && !/[$€£%]/.test(raw)) continue;
      if (!srcNumbers.has(digits)) {
        push(finding("unsupported_offer", "hard", l.scene, `The figure "${raw.trim()}" is not in the source material.`, "Remove the figure, or replace it with one the source states and keep its original scope.", clip(l.line)), `${l.scene}|num|${digits}`);
      }
    }
    for (const m of l.line.matchAll(new RegExp(`\\b(${Object.keys(WORD_NUMBERS).join("|")})[ -](minutes?|hours?|days?|weeks?|months?|years?|percent|dollars?|times)\\b`, "gi"))) {
      const n = String(WORD_NUMBERS[m[1].toLowerCase()]);
      if (!srcNumbers.has(n)) {
        push(finding("unsupported_offer", "hard", l.scene, `The figure "${m[0]}" is not in the source material.`, "Remove the figure, or replace it with one the source states.", clip(l.line)), `${l.scene}|numw|${n}|${m[2].toLowerCase()}`);
      }
    }
    for (const m of l.line.matchAll(/\b(hundreds|thousands|millions|billions) of\b/gi)) {
      if (!inSource(src, m[0])) {
        push(finding("unsupported_offer", "hard", l.scene, `"${m[0]}" is a size claim that the source does not make.`, "Remove the size claim or use the number the source gives.", clip(l.line)), `${l.scene}|many|${m[1].toLowerCase()}`);
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ the call to action

type CtaKind = "contact" | "book" | "buy" | "signup" | "download" | "quote" | "visit" | "learn" | "try";
const CTA_PATTERNS: Array<[CtaKind, RegExp]> = [
  ["contact", /(?:(?<!\b(?:a|the|this|your|that|one)\s)\bcall (?:us|now|today|me|\d)|\bgive (?:us|me) a (?:call|ring)|phone (?:us|now)|text (?:us|me)|contact (?:us|me)|email (?:us|me)|message (?:us|me)|dm us|reach out)\b/i],
  ["book", /\b(?:book|schedule|reserve|make an appointment|set up a (?:call|time|visit))\b/i],
  ["buy", /\b(?:buy|shop|order|purchase|add to cart|checkout)\b/i],
  ["signup", /\b(?:sign up|subscribe|register|join|apply|get started|create an account)\b/i],
  ["download", /\bdownload\b/i],
  ["quote", /\b(?:get|request|ask for|claim) (?:a |your |an )?(?:free )?(?:quote|estimate|proposal|pricing|price)\b/i],
  ["visit", /\b(?:visit|click|tap|go to|head to|check out|see the link|link below|swipe up|learn more)\b/i],
  ["learn", /\b(?:learn more|find out more|read more|see how it works|find out)\b/i],
  ["try", /\b(?:try|start (?:a|your) (?:free )?trial|get a demo|see a demo|watch a demo)\b/i],
];

function ctaKinds(text: string): Set<CtaKind> {
  const out = new Set<CtaKind>();
  for (const [kind, re] of CTA_PATTERNS) if (re.test(text)) out.add(kind);
  return out;
}
const DISTINCT = (s: Set<CtaKind>) => [...s].filter((k) => k !== "visit" && k !== "learn");

const BOOK_OBJECT = /\b(?:book|schedule|reserve|request|get|claim)\s+(?:a|an|your|my|the)\s+(?:(?:free|short|quick|10|15|20|30|45|60|minute|min|no obligation|personal|personalised|personalized|one[- ]on[- ]one)\s+){0,4}(call|demo|audit|consultation|quote|estimate|appointment|meeting|session|trial|tour|visit|assessment|review|chat|strategy session|walkthrough)\b/i;

export function ctaFindings(spoken: string, ctx: { conversionAction: string | null; sourceText: string; label: string }): QualityFinding[] {
  const out: QualityFinding[] = [];
  const text = spoken.trim();
  if (!text) {
    out.push(finding("cta_missing", "major", null, "There is no spoken call to action.", "Add one closing line that tells the viewer the single next step the page offers."));
    return out;
  }
  const action = ctx.conversionAction?.trim() || null;
  const kinds = ctaKinds(text);
  const actionKinds = action ? ctaKinds(action) : new Set<CtaKind>();
  const spokenDistinct = DISTINCT(kinds);
  const actionDistinct = DISTINCT(actionKinds);

  if (spokenDistinct.length >= 2) {
    out.push(finding("cta_competing", "major", null, `The call to action asks for more than one thing (${spokenDistinct.join(" and ")}). Viewers do none of them.`, "Keep the one step the page offers and cut the others.", text));
  }
  if (action) {
    const spokenNoun = text.match(BOOK_OBJECT)?.[1]?.toLowerCase();
    const actionWords = new Set(contentWords(action));
    if (spokenNoun && !actionWords.has(stem(spokenNoun)) && !new RegExp(`\\b${spokenNoun}\\b`, "i").test(action)) {
      out.push(finding("cta_mismatch", "major", null, `The spoken step is a ${spokenNoun}, but the page's real next step is "${clip(action, 70)}".`, "Name the step the page really asks for, in the page's own terms.", text));
    } else if (spokenDistinct.length > 0 && actionDistinct.length > 0 && !spokenDistinct.some((k) => actionDistinct.includes(k))) {
      out.push(finding("cta_mismatch", "major", null, `The spoken step (${spokenDistinct.join(", ")}) is not what the page asks for (${actionDistinct.join(", ")}).`, "Change the spoken step to the one the page really offers.", text));
    } else if (spokenDistinct.length === 0 && kinds.has("learn") && actionDistinct.length > 0) {
      out.push(finding("cta_generic", "major", null, "The call to action is a generic \"learn more\", but the page has a specific next step.", "Name the specific step the page offers.", text));
    }
  } else if (spokenDistinct.length === 0 && kinds.has("learn")) {
    out.push(finding("cta_generic", "minor", null, "The call to action is a generic \"learn more\".", "Name the specific next step once it is known.", text));
  }

  // Promises the page does not make.
  const pool = normalise(`${ctx.sourceText} ${action ?? ""}`);
  const promises: Array<[RegExp, Severity, string]> = [
    [/(?<![\w-])free(?![\w-])(?:\s+([a-z]+))?|\bno (?:obligation|commitment|cost|charge)\b/i, "hard", "free or no-obligation"],
    [/\bguarantee[ds]?\b|\bmoney[- ]back\b/i, "hard", "guarantee"],
    [/\b\d{1,3}\s?%\s*off\b|\bdiscount\b/i, "hard", "discount"],
    [/\b(?:instant(?:ly)?|same[- ]day|in minutes|within minutes|in seconds|overnight)\b/i, "major", "speed"],
  ];
  for (const [re, sev, label] of promises) {
    const m = text.match(re);
    if (!m) continue;
    const hit = m[0].trim();
    const next = (m[1] ?? "").toLowerCase();
    const ok = label.startsWith("free") && /^free/i.test(hit) && next && !["and", "to", "for", "of", "with", "in", "on", "a", "the", "or"].includes(next) ? freeSupported(pool, next) : inSource(pool, hit);
    if (!ok) out.push(finding("cta_unsupported_promise", sev, null, `The call to action promises something (${label}: "${hit}") that the page does not offer.`, "Remove the promise, or word it exactly as the page does.", text));
  }

  // A step with no reason to take it, when the source gives one.
  const sourceHasBenefit = /\b(?:you'?ll (?:get|see|find|receive|walk away|leave)|you will (?:get|see|find|receive)|find out|learn (?:how|what|where)|see (?:how|what|where|if)|so you can|to help you|and get|includes?|come away with)\b/i.test(ctx.sourceText);
  const spokenHasBenefit = /\b(?:to (?:see|find|learn|get|know|stop|start|save|cut|fix|keep|check|compare|understand|hear)|so (?:you|we|your|that)|and (?:get|see|find|learn|know|hear)|find out|see (?:how|what|where|if)|learn (?:how|what|where)|you'?ll)\b/i.test(text);
  if (sourceHasBenefit && !spokenHasBenefit && wc(text) <= 8) {
    out.push(finding("cta_no_benefit", "minor", null, "The call to action gives no reason to take the step, though the source describes what the viewer gets.", "Add what the viewer gets from the step, in the source's terms.", text));
  }

  // Button label against the page's real step.
  const label = ctx.label.replace(/_/g, " ").trim();
  if (label && action) {
    const lk = DISTINCT(ctaKinds(label));
    if (lk.length > 0 && actionDistinct.length > 0 && !lk.some((k) => actionDistinct.includes(k))) {
      out.push(finding("cta_label_mismatch", "minor", null, `The button label "${label}" points to a different step than the page's "${clip(action, 60)}".`, "Pick the button label that matches the step the page asks for."));
    }
  }
  return out;
}

// ------------------------------------------------------------------ visuals

type Trope = { id: string; label: string; re: RegExp; cliche: boolean };
const FRUSTRATED = "frustrated|stressed|overwhelmed|exhausted|confused|tired|annoyed|worried|anxious|sighs?|sighing|stressful|head in (?:his|her|their) hands|rubs? (?:his|her|their) (?:eyes|temples|forehead)";
const SCREENISH = "laptop|computer|desk|screen|monitor";
const TROPES: Trope[] = [
  { id: "frustrated_at_screen", label: "a person frustrated at a laptop or desk", re: new RegExp(`\\b(?:${FRUSTRATED})\\b[^.]{0,80}\\b(?:${SCREENISH})\\b|\\b(?:${SCREENISH})\\b[^.]{0,80}\\b(?:${FRUSTRATED})\\b`, "i"), cliche: true },
  { id: "relieved", label: "a person relieved or smiling after the problem", re: /\b(?:relieved|relief|exhales|sigh of relief|smiles? (?:with relief|in relief|confidently)|breaks into a (?:big )?smile|leans back (?:and )?(?:smiling|satisfied|relaxed))\b/i, cliche: false },
  { id: "person_at_laptop", label: "a person working at a laptop", re: new RegExp(`\\b(?:person|man|woman|owner|founder|entrepreneur|worker|someone|manager|professional|she|he|they)\\b[^.]{0,40}\\b(?:at|on|with|in front of|behind)\\b[^.]{0,15}\\b(?:laptop|computer|desk)\\b`, "i"), cliche: false },
  { id: "typing_closeup", label: "a typing close-up", re: /\b(?:typing|types|keyboard|keystrokes|keys)\b/i, cliche: true },
  { id: "floating_interface", label: "a dashboard, hologram or floating interface", re: /\b(?:dashboard|hologram|holographic|floating (?:ui|interface|screens?|graphs?|charts?|icons?|data)|futuristic (?:ui|interface)|glowing (?:graph|chart|ui|interface|data|network)|data visuali[sz]ation|analytics screen|(?:chart|graph) (?:rising|going up|climbing)|rising (?:graph|chart|arrow))\b/i, cliche: true },
  { id: "stock_celebration", label: "handshake, high-five or thumbs-up stock imagery", re: /\b(?:handshake|shaking hands|shake hands|high[- ]five|thumbs[- ]up|fist bump|team (?:cheering|celebrating)|celebrat\w+ in (?:the )?office)\b/i, cliche: true },
  { id: "pointing_at_screen", label: "someone pointing at a screen", re: /\bpoint(?:s|ing)? (?:at|to)\b[^.]{0,20}\b(?:screen|monitor|whiteboard|chart|dashboard|laptop)\b|\bgestur\w+ (?:at|toward|towards) (?:the )?screen\b/i, cliche: true },
  { id: "stock_metaphor", label: "a stock metaphor image", re: /\b(?:light ?bulb|rocket (?:launch|taking off|blasting)|gears? turning|puzzle pieces?|sun(?:rise|set) over (?:the )?(?:city|skyline)|city skyline|arrow (?:going|pointing|shooting) up|glass[- ]walled (?:office|conference)|modern (?:open[- ]plan )?office|boardroom)\b/i, cliche: true },
];

const SETTINGS = "office|desk|kitchen|restaurant|cafe|café|shop floor|storefront|store|warehouse|street|car|truck|van|home|living room|bedroom|studio|garage|clinic|salon|gym|workshop|garden|park|beach|classroom|hospital|factory|bar|bakery|farm|site|rooftop|bathroom|laptop|phone|boardroom|conference room|counter";
const SETTING_RE = new RegExp(`\\b(${SETTINGS})\\b`, "gi");

const TEXT_DEPENDENT =
  /\b(?:readable|legible|clearly (?:visible|readable)|zoom(?:s|ed)? (?:in )?on (?:the )?(?:screen|text|numbers|dashboard|figures)|close[- ]up of (?:the |a )?(?:screen|dashboard|spreadsheet|text|invoice|document|receipt|numbers|report|website|app)|(?:screen|monitor|phone|laptop|dashboard|spreadsheet|invoice|report|document|website|app|chart)\b[^.]{0,30}\b(?:showing|displaying|reading|reads|says)\b|(?:exact |real |brand |company |actual )?logo\b|brand(?:ed)? (?:packaging|sign|label)|(?:sign|banner|poster|label|whiteboard|screen|billboard) (?:that )?(?:reads?|says?|saying|with the words))\b/i;
const ANATOMY =
  /\b(?:counts? (?:on|with) (?:his|her|their|the)? ?fingers|counting (?:on )?(?:his |her |their )?fingers|holds? up (?:\d|two|three|four|five) fingers|fingers? (?:spread|splayed)|hands? (?:typing|knitting)|playing (?:the )?(?:piano|guitar|violin)|close[- ]up of (?:hands|fingers|a hand|teeth|feet|an eye)|handwriting|writes? by hand|signing a (?:contract|document|check|cheque)|crowd (?:of|cheering)|large group of people|dozens of people)\b/i;

export function visualFindings(visuals: Array<{ scene: number; visual: string }>): QualityFinding[] {
  const out: QualityFinding[] = [];
  const items = visuals.filter((v) => v.visual.trim());

  const sceneHits = new Map<string, number[]>();
  for (const v of items) {
    for (const t of TROPES) if (t.re.test(v.visual)) sceneHits.set(t.id, [...(sceneHits.get(t.id) ?? []), v.scene]);
  }
  for (const t of TROPES) {
    const scenes = sceneHits.get(t.id) ?? [];
    if (scenes.length >= 2) {
      out.push(finding("repeated_visual_trope", "major", scenes[1], `${t.label[0].toUpperCase()}${t.label.slice(1)} appears in ${scenes.length} scenes (${scenes.join(", ")}). Viewers have seen this stock shot too often.`, "Keep at most one, and change the others to different, specific, filmable moments."));
    } else if (scenes.length === 1 && t.cliche) {
      out.push(finding("cliche_visual", "minor", scenes[0], `Scene ${scenes[0]} uses a stock visual: ${t.label}.`, "Show something specific to this offer that a stock library would not have."));
    }
  }
  const frustrated = sceneHits.get("frustrated_at_screen") ?? [];
  const relieved = sceneHits.get("relieved") ?? [];
  if (frustrated.length && relieved.length && frustrated.some((f) => relieved.some((r) => r > f))) {
    out.push(finding("visual_trope_arc", "major", relieved[0], "The visuals run the stock arc of a person frustrated at a screen, then relieved.", "Show the problem and the outcome through different, concrete images of the actual situation."));
  }

  const settingScenes = new Map<string, Set<number>>();
  for (const v of items) for (const m of v.visual.matchAll(SETTING_RE)) {
    const key = m[1].toLowerCase();
    (settingScenes.get(key) ?? settingScenes.set(key, new Set()).get(key)!).add(v.scene);
  }
  for (const [key, scenes] of settingScenes) {
    if (scenes.size >= 3) {
      const list = [...scenes].sort((a, b) => a - b);
      out.push(finding("same_setting", "major", list[2], `The ${key} is the setting or subject in ${scenes.size} scenes (${list.join(", ")}).`, "Move some scenes to a different place or subject so the video does not feel like one shot repeated."));
    }
  }

  for (const v of items) {
    const text = v.visual.match(TEXT_DEPENDENT);
    if (text) out.push(finding("visual_needs_text", "major", v.scene, `Scene ${v.scene} depends on readable text, a screen or a logo ("${text[0].trim()}"). AI video draws garbled lettering there.`, "Show a person or an object instead. Real figures, screenshots and logos are added on top afterwards."));
    const anatomy = v.visual.match(ANATOMY);
    if (anatomy) out.push(finding("visual_complex_anatomy", "major", v.scene, `Scene ${v.scene} needs hands, fingers or a crowd to be drawn precisely ("${anatomy[0].trim()}"). AI video often gets these wrong.`, "Frame the shot so the hands or the crowd are not the subject."));
  }
  return out;
}

// ------------------------------------------------------------------ overlap between the versions

export type OverlapInput = { id: string; lines: string[]; premise?: string; stats?: string[] };

/**
 * Thresholds on Jaccard similarity of content words (stems, synonyms folded).
 *  - hard: the whole text is at least HARD_TEXT similar, or the premise is at least HARD_PREMISE similar,
 *    or the openings are at least HARD_OPENING similar and the text is at least OPENING_TEXT similar.
 *  - weak: the text is at least WEAK_TEXT, the premise at least WEAK_PREMISE or the opening at least WEAK_OPENING.
 */
export const OVERLAP_THRESHOLDS = { hardText: 0.5, hardPremise: 0.6, hardOpening: 0.7, openingText: 0.3, weakText: 0.3, weakPremise: 0.4, weakOpening: 0.55 } as const;

const firstWords = (lines: string[], n: number) =>
  (lines.find((l) => l.trim()) ?? "")
    .toLowerCase()
    .match(/[a-z0-9']+/g)
    ?.slice(0, n)
    .join(" ") ?? "";

const statKey = (s: string) => s.replace(/[^\d.]/g, "").replace(/^\.+|\.+$/g, "");

export function overlapFindings(scripts: OverlapInput[]): {
  pairs: Array<{ a: string; b: string; similarity: number; openingSimilarity: number; premiseSimilarity: number }>;
  findings: Array<QualityFinding & { scripts: string[] }>;
} {
  const T = OVERLAP_THRESHOLDS;
  const pairs: Array<{ a: string; b: string; similarity: number; openingSimilarity: number; premiseSimilarity: number }> = [];
  const findings: Array<QualityFinding & { scripts: string[] }> = [];
  const r = (n: number) => Math.round(n * 100) / 100;

  for (let i = 0; i < scripts.length; i++) {
    for (let j = i + 1; j < scripts.length; j++) {
      const A = scripts[i];
      const B = scripts[j];
      const similarity = jaccard(contentWords(A.lines.join(" ")), contentWords(B.lines.join(" ")));
      const openingSimilarity = jaccard(contentWords(A.lines.find((l) => l.trim()) ?? ""), contentWords(B.lines.find((l) => l.trim()) ?? ""));
      const premiseSimilarity = A.premise && B.premise ? jaccard(contentWords(A.premise), contentWords(B.premise)) : 0;
      pairs.push({ a: A.id, b: B.id, similarity: r(similarity), openingSimilarity: r(openingSimilarity), premiseSimilarity: r(premiseSimilarity) });

      const hard = similarity >= T.hardText || premiseSimilarity >= T.hardPremise || (openingSimilarity >= T.hardOpening && similarity >= T.openingText);
      const weak = similarity >= T.weakText || premiseSimilarity >= T.weakPremise || openingSimilarity >= T.weakOpening;
      if (hard) {
        findings.push({ ...finding("duplicate_angle", "hard", null, `Versions ${A.id} and ${B.id} are the same idea reworded (text ${Math.round(similarity * 100)}% alike, premise ${Math.round(premiseSimilarity * 100)}%, opening ${Math.round(openingSimilarity * 100)}%).`, "Rebuild one of them around a different situation, tension and opening. Swapping words does not make a different idea."), scripts: [A.id, B.id] });
      } else if (weak) {
        findings.push({ ...finding("weak_difference", "major", null, `Versions ${A.id} and ${B.id} overlap more than three distinct angles should (text ${Math.round(similarity * 100)}% alike, premise ${Math.round(premiseSimilarity * 100)}%, opening ${Math.round(openingSimilarity * 100)}%).`, "Change the situation or the opening of one version so the viewer would not think they were made from the same idea."), scripts: [A.id, B.id] });
      }
    }
  }

  // The same first three words in two versions.
  const byStart = new Map<string, string[]>();
  for (const s of scripts) {
    const key = firstWords(s.lines, 3);
    if (key.split(" ").length >= 3) byStart.set(key, [...(byStart.get(key) ?? []), s.id]);
  }
  for (const [key, ids] of byStart) {
    if (ids.length > 1) findings.push({ ...finding("same_opening_pattern", "major", null, `Versions ${ids.join(", ")} all start with the same three words ("${key}").`, "Open each version on its own situation, with a different first sentence structure."), scripts: ids });
  }

  // One statistic carried through every version.
  if (scripts.length >= 2) {
    const sets = scripts.map((s) => {
      const fromLines = (s.lines.join(" ").match(/[$€£]?\d[\d,]*(?:\.\d+)?\s?(?:%|k|m|b|x|million|billion)?/gi) ?? []).filter((x) => /%|[$€£]|million|billion|\d{2,}/i.test(x));
      return new Set([...(s.stats ?? []), ...fromLines].map(statKey).filter((k) => k.length >= 2));
    });
    const shared = [...sets[0]].filter((k) => sets.every((st) => st.has(k)));
    if (shared.length) {
      findings.push({ ...finding("reused_stat", "minor", null, `The figure ${shared.join(", ")} is used in every version.`, "Lead with a different proof point in at least one version, if the source has more than one."), scripts: scripts.map((s) => s.id) });
    }
  }
  return { pairs, findings };
}

// ------------------------------------------------------------------ the whole report

const RANK: Record<Severity, number> = { hard: 0, major: 1, minor: 2 };

/** All detectors that apply to a single script, hard findings first. */
/**
 * Web addresses and phone numbers that are spoken must be exactly the ones in the sources: a
 * changed domain or a mistyped number sends the viewer somewhere else. Compared ignoring spaces,
 * dashes, dots and case; a bare domain without the page's own scheme or "www" is fine.
 */
export function contactFindings(lines: SpokenLine[], ctx: { sourceText: string }): QualityFinding[] {
  const squash = (s: string) => s.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[^a-z0-9]/g, "");
  const source = squash(ctx.sourceText);
  const out: QualityFinding[] = [];
  for (const l of lines) {
    const found = l.line.match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[\w\-./]*)?|\+?\d[\d\s-]{7,}\d/gi) ?? [];
    for (const raw of found) {
      const token = raw.replace(/[.,;:!?]+$/, "");
      const key = squash(token);
      if (key.length < 7 || source.includes(key)) continue;
      out.push(finding("cta_unsupported_contact", "hard", l.scene, `The ${/\d{7,}/.test(key) ? "phone number" : "web address"} "${token}" is not the one in the sources.`, "Use the contact detail exactly as the page gives it, or leave it out.", l.line));
    }
  }
  return out;
}

export function qualityReport(input: {
  lines: SpokenLine[];
  visuals: Array<{ scene: number; visual: string }>;
  cta: { spoken: string; label: string };
  dramatisation: boolean;
  sourceText: string;
  conversionAction: string | null;
}): QualityFinding[] {
  const spokenLines = input.lines.filter((l) => l.line.trim());
  const first = spokenLines[0];
  const all: QualityFinding[] = [];
  if (first) all.push(...openingFindings(first.line).map((f) => ({ ...f, scene: first.scene })));
  all.push(...voiceFindings(spokenLines));
  all.push(...experienceFindings(spokenLines, { dramatisation: input.dramatisation, sourceText: input.sourceText }));
  all.push(...offerFindings(spokenLines, { sourceText: input.sourceText }));
  all.push(...ctaFindings(input.cta.spoken, { conversionAction: input.conversionAction, sourceText: input.sourceText, label: input.cta.label }));
  all.push(...visualFindings(input.visuals));
  all.push(...contactFindings(spokenLines, { sourceText: input.sourceText }));
  if (input.cta.spoken.trim() && !spokenLines.some((l) => l.line.includes(input.cta.spoken.trim()))) {
    all.push(...contactFindings([{ scene: spokenLines[spokenLines.length - 1]?.scene ?? 1, line: input.cta.spoken }], { sourceText: input.sourceText }));
  }

  // The closing line may also be one of the spoken lines: do not report the same promise twice.
  const offerQuotes = new Set(all.filter((f) => f.code === "unsupported_offer").map((f) => (f.quote ?? "").toLowerCase()));
  const deduped = all.filter((f) => !(f.code === "cta_unsupported_promise" && f.quote && [...offerQuotes].some((q) => q && f.quote!.toLowerCase().includes(q.slice(0, 40)))));

  return deduped
    .map((f, i) => ({ f, i }))
    .sort((a, b) => RANK[a.f.severity] - RANK[b.f.severity] || a.i - b.i)
    .map((x) => x.f);
}
