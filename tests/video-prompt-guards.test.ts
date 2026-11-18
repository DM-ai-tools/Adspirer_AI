import { describe, expect, it } from "vitest";
import { buildPlannedClipPrompt, type PlannedClipPromptInput } from "@/lib/video/clip-prompt";
import { continuityFor } from "@/lib/video/pipeline";
import { compareSpokenToExpected } from "@/lib/video/subtitles";
import { isStillAction, STATIC_CAMERA } from "@/lib/video/visual-rules";
import { languageFor, languageRule, lintClipPrompt, liveAction, liveFraming, reconcileVoicesWithCast, sceneCharacterIds } from "@/lib/video/prompt-guards";
import type { CreativePlan, PlanCharacter, SceneBrief } from "@/lib/video/pipeline-types";
import type { VideoScript } from "@/lib/video/script";
import type { AsrWord } from "@/lib/video/captions";

// The real clip 2 of "The Translator" (TR Internal Marketing Version 1). What went wrong, from the stored run:
//  - the new arrival speaks on camera in scene 4 but scene 4's characterId is the business owner, so no picture of
//    him was sent and the model invented a new face;
//  - nothing told the model which language to speak, and it spoke Mandarin (the check only said "line missing");
//  - the plan wrote "Still shot" / "Wide static shot" and "the camera holds on the empty chairs" for 9 seconds;
//  - the new arrival is a man on screen but his voice was described as "Female".

const characters: PlanCharacter[] = [
  { id: "business_owner", role: "Business Owner", description: "Female, mid-40s, dressed in a dark blazer with hair pulled back, exuding professionalism mixed with frustration." },
  { id: "translator", role: "Translator", description: "Male, late 30s, pompous demeanor, dressed in a formal shirt, projecting confidence while being ineffective." },
  { id: "new_arrival", role: "New Arrival", description: "Male, early 40s, plain and unhurried, dressed in business casual, straightforward and factual in approach." },
];

const base = {
  purpose: "p", informationAdded: "i", lighting: "Flat fluorescent light, consistent with previous scenes.", style: "Mockumentary", requiredAssets: [], overlays: [], screenTreatment: "none" as const,
  durationBasis: "", entry: { mode: "cut" as const, condition: "" }, exit: { condition: "" }, transition: { kind: "cut" as const, rationale: "" }, risks: [], acceptance: ["No text, numbers, logos or graphics are visible anywhere in the frame."],
  environmentId: "meeting_room",
};

const scene4: SceneBrief = { ...base, number: 4, seconds: 6, narration: "How long have you known that? About forty-eight hours after I looked at the account.", subject: "Business owner and new arrival", setting: "Meeting room, focusing on the interaction between the characters.", action: "Business owner looks steadily at the new arrival.", framing: "Medium two-shot favouring the owner and the new arrival, translator visible but soft in the center.", camera: "Still shot, capturing the moment of realization.", characterId: "business_owner" };
const scene5: SceneBrief = { ...base, number: 5, seconds: 3, narration: "", subject: "Translator", setting: "Meeting room, now focusing on the translator's exit.", action: "Translator closes his notepad, caps his pen, and stands up.", framing: "Wide static shot, full table in frame, translator moving away from camera toward the door.", camera: "Still shot, capturing the exit without distraction.", characterId: "translator" };
const scene6: SceneBrief = { ...base, number: 6, seconds: 9, narration: "Traffic Radius audits every account for wasted spend before touching a single dollar. Book a free google ads strategy call today.", subject: "Empty meeting room", setting: "The now empty meeting room, capturing the aftermath of the meeting.", action: "The camera holds on the empty chairs and table.", framing: "Wide static shot, same framing as the opening, room now empty and still.", camera: "Still shot, allowing the viewer to reflect on the message.", characterId: null };

const plan = {
  scenes: [scene4, scene5, scene6],
  characters,
  environments: [{ id: "meeting_room", description: "A bare formal meeting room with a plain table and three chairs", sceneNumbers: [4, 5, 6] }],
} as unknown as CreativePlan;

const script = {
  style: "Mockumentary",
  voices: [
    { id: "narrator", who: "narrator", description: "Male, early 50s, Australian, dry and unhurried" },
    { id: "translator", who: "translator", description: "Male, late 30s, Australian, pompous and circular" },
    { id: "arrival", who: "new arrival", description: "Female, early 40s, Australian, completely flat and plain" },
  ],
  scenes: [
    { number: 4, speaker: "on_camera", line: scene4.narration, lines: [{ text: "How long have you known that?", voiceId: "narrator", onCamera: false }, { text: "About forty-eight hours after I looked at the account.", voiceId: "arrival", onCamera: true }] },
    { number: 5, speaker: "none", line: "", lines: [] },
    { number: 6, speaker: "voiceover", line: scene6.narration, lines: [{ text: scene6.narration, voiceId: "narrator", onCamera: false }] },
  ],
} as unknown as VideoScript;

const clip2 = { sceneNumbers: [4, 5, 6] };

describe("who is in a clip", () => {
  it("finds a person named in the shot even when the scene's main character is someone else", () => {
    expect(sceneCharacterIds(characters, scene4)).toEqual(expect.arrayContaining(["business_owner", "new_arrival", "translator"]));
  });

  it("finds the on-camera speaker by the name of their voice", () => {
    const quiet: SceneBrief = { ...scene4, subject: "Two people at a table", framing: "Medium shot", action: "She waits", setting: "Meeting room", characterId: "business_owner" };
    expect(sceneCharacterIds(characters, quiet, ["new arrival"])).toEqual(expect.arrayContaining(["business_owner", "new_arrival"]));
  });

  it("sends a reference for everyone who appears in clip 2, not only each scene's main character", () => {
    const cont = continuityFor(plan, script, clip2, undefined);
    expect(cont.characterIds).toEqual(expect.arrayContaining(["business_owner", "translator", "new_arrival"]));
  });

  it("an empty room shows no one", () => {
    expect(sceneCharacterIds(characters, scene6)).toEqual([]);
    expect(continuityFor(plan, script, { sceneNumbers: [6] }, undefined).characterIds).toEqual([]);
  });
});

describe("the language of the speech", () => {
  it("names the language and forbids translating", () => {
    const rule = languageRule("en-AU");
    expect(rule).toMatch(/English/);
    expect(rule).toMatch(/Australian/);
    expect(rule).toMatch(/Chinese/i);
    expect(rule).toMatch(/translat/i);
  });
  it("works out the language from the locale", () => {
    expect(languageFor("en-GB").language).toBe("English");
    expect(languageFor("es-ES").language).toBe("Spanish");
    expect(languageFor("").language).toBe("English");
    expect(languageFor("not a locale").language).toBe("English");
  });
});

describe("a voice that does not match the person", () => {
  it("takes the gender of the person on screen when the voice description contradicts it", () => {
    const voices = reconcileVoicesWithCast(
      [{ id: "arrival", who: "new arrival", description: "Female, early 40s, Australian, completely flat and plain", videoRef: null }, { id: "narrator", who: "narrator", description: "Male, early 50s, Australian", videoRef: null }],
      characters,
    );
    expect(voices[0].description).toMatch(/^Male,/);
    expect(voices[0].description).not.toMatch(/female/i);
    expect(voices[1].description).toBe("Male, early 50s, Australian");
  });
  it("leaves a voice alone when it already matches, or belongs to nobody on screen", () => {
    const same = [{ id: "translator", who: "translator", description: "Male, late 30s, Australian", videoRef: null }];
    expect(reconcileVoicesWithCast(same, characters)).toEqual(same);
  });
});

describe("a shot written as still", () => {
  it("recognises the holds the plan wrote", () => {
    expect(isStillAction("The camera holds on the empty chairs and table.")).toBe(true);
    expect(isStillAction("The translator sits perfectly still in the middle, pen hovering")).toBe(true);
    expect(isStillAction("Business owner looks steadily at the new arrival.")).toBe(false);
  });
  it("turns a camera that holds into one that moves", () => {
    const out = liveAction("The camera holds on the empty chairs and table.");
    expect(out).not.toMatch(/holds/i);
    expect(out).toMatch(/drift|travel|move/i);
    expect(out).toMatch(/empty chairs and table/);
  });
  it("leaves a moving action alone", () => {
    expect(liveAction("Translator closes his notepad, caps his pen, and stands up.")).toBe("Translator closes his notepad, caps his pen, and stands up.");
  });
  it("takes 'static' out of a framing", () => {
    const out = liveFraming("Wide static shot, full table in frame, translator moving away from camera toward the door.");
    expect(out).not.toMatch(STATIC_CAMERA);
    expect(out).toMatch(/full table in frame/);
    expect(liveFraming("Medium shot at eye level")).toBe("Medium shot at eye level");
  });
});

describe("the prompt for clip 2", () => {
  const cont = continuityFor(plan, script, clip2, undefined);
  const spoken: PlannedClipPromptInput["spoken"] = {
    4: { text: scene4.narration, speaker: "on_camera", parts: [{ voiceId: "narrator", who: "narrator", text: "How long have you known that?", onCamera: false }, { voiceId: "arrival", who: "new arrival", text: "About forty-eight hours after I looked at the account.", onCamera: true }] },
    6: { text: scene6.narration, speaker: "voiceover", parts: [{ voiceId: "narrator", who: "narrator", text: scene6.narration, onCamera: false }] },
  };
  const input = (over: Partial<PlannedClipPromptInput> = {}): PlannedClipPromptInput => ({
    scenes: [scene4, scene5, scene6],
    spoken,
    characters,
    environments: plan.environments,
    style: "Mockumentary — comedy of errors, played completely straight",
    clipNumber: 2,
    clipCount: 2,
    locale: "en-AU",
    refs: { characterIds: cont.characterIds, environmentIds: cont.environmentIds, previousFrame: true, previousFrameRole: "look", previousVideo: false },
    voices: script.voices!.map((v) => ({ ...v, videoRef: null })),
    corrections: [],
    nextContinues: false,
    clean: true,
    ...over,
  });
  const prompt = buildPlannedClipPrompt(input());
  const shots = prompt.split("\n").filter((l) => /^\d+s-\d+s: Shot/.test(l));

  it("says the speech is English, near the top and again at the end", () => {
    const lines = prompt.split("\n");
    const hits = lines.map((l, i) => (/Language:/.test(l) ? i : -1)).filter((i) => i >= 0);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(prompt).toMatch(/Language: every spoken word[^\n]*English/);
    expect(lines[lines.length - 2] + lines[lines.length - 1]).toMatch(/English/);
  });

  it("shows and describes all three people, each with a picture", () => {
    for (const id of ["business_owner", "translator", "new_arrival"]) expect(prompt).toMatch(new RegExp(`Person \\(${id}\\)`));
    expect(prompt).toMatch(/Image \d is New Arrival/);
  });

  it("ties each voice to the person it belongs to and keeps a man's voice male", () => {
    const voicesLine = prompt.split("\n").find((l) => l.startsWith("Voices"))!;
    expect(voicesLine).toMatch(/new arrival: Male/);
    expect(voicesLine).not.toMatch(/Female/);
    expect(voicesLine).toMatch(/new arrival: [^;]*Image \d/);
  });

  it("has no static camera, static framing or still hold in any shot, and a movement line in every one", () => {
    expect(shots).toHaveLength(3);
    for (const shot of shots) {
      const filmed = shot.slice(0, shot.indexOf("Light:")).replace(/"[^"]*"/g, "");
      expect(filmed).not.toMatch(STATIC_CAMERA);
      expect(filmed).not.toMatch(/holds on/i);
      expect(shot).toMatch(/Movement:/);
    }
  });

  it("passes its own inspection, and the inspection fails what the real run sent", () => {
    const needed = cont.characterIds;
    expect(lintClipPrompt({ prompt, speaks: true, requiredPeople: needed, attachedPeople: cont.characterIds })).toEqual([]);

    const old = prompt.replace(/Language:[^\n]*\n/g, "").replace(/Movement:[^\n]*?\. (?=This shot|No one|[A-Za-z]+, (on|off) camera|\S*s-\d|$)/g, "");
    const problems = lintClipPrompt({ prompt: old, speaks: true, requiredPeople: needed, attachedPeople: ["business_owner", "translator"] });
    expect(problems.join(" ")).toMatch(/language/i);
    expect(problems.join(" ")).toMatch(/new_arrival|New Arrival/);

    const still = prompt.replace(/Camera: [^\n]*?\. Light:/, "Camera: Still shot, capturing the moment. Light:");
    expect(lintClipPrompt({ prompt: still, speaks: true, requiredPeople: needed, attachedPeople: needed }).join(" ")).toMatch(/camera|static|still/i);
  });
});

describe("a clip spoken in the wrong language", () => {
  const line = (sceneNumber: number, spoken: string) => ({ sceneNumber, display: spoken, spoken, segments: [], uncertain: [] });
  const speech = [line(4, "How long have you known that? About forty-eight hours after I looked at the account."), line(6, "Traffic Radius audits every account for wasted spend before touching a single dollar. Book a free google ads strategy call today.")];
  // What the transcript really returned for clip 2 (Whisper, language: chinese), split into words.
  const heard: AsrWord[] = [
    ...[..."你知道这个有多久了在我查看账户后大约"].map((ch, i) => ({ word: ch, start: i * 0.2, end: i * 0.2 + 0.18 })),
    { word: "48", start: 4.0, end: 4.4 },
    { word: "Traffic", start: 9.0, end: 9.4 }, { word: "Radius", start: 9.4, end: 9.8 },
    ...[..."在动用一分钱之前会对每一个账户进行浪费性支出审计今天就预约一次免费的谷歌广告策略咨询吧"].map((ch, i) => ({ word: ch, start: 10 + i * 0.1, end: 10 + i * 0.1 + 0.09 })),
  ];
  const out = compareSpokenToExpected(speech, heard, [{ number: 4, start: 0, end: 6 }, { number: 6, start: 9, end: 18 }]);

  it("is reported as the wrong language, once, with a correction that names the language", () => {
    const wrong = out.findings.filter((f) => f.code === "speech_wrong_language");
    expect(wrong).toHaveLength(1);
    expect(wrong[0]).toMatchObject({ severity: "critical", category: "speech", source: "asr" });
    expect(wrong[0].message).toMatch(/Chinese/);
    expect(wrong[0].correction).toMatch(/English/);
    expect(wrong[0].correction).toMatch(/translat/i);
  });
  it("does not also say each line was missing", () => {
    expect(out.findings.some((f) => f.code === "speech_line_missing" || f.code === "speech_wrong_sentence")).toBe(false);
    expect(out.checks.filter((c) => /^speech_scene_/.test(c.name)).every((c) => !c.ok)).toBe(true);
  });
  it("leaves a clip that is spoken in English alone", () => {
    const english: AsrWord[] = "How long have you known that About forty eight hours after I looked at the account".split(" ").map((w, i) => ({ word: w, start: i * 0.3, end: i * 0.3 + 0.28 }));
    const ok = compareSpokenToExpected([speech[0]], english, [{ number: 4, start: 0, end: 6 }]);
    expect(ok.findings.some((f) => f.code === "speech_wrong_language")).toBe(false);
  });
});
