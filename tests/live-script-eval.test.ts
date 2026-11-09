import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";

/**
 * Live comparison of the OLD script generator and the NEW one on the same inputs.
 *
 * It calls real models, so it is skipped unless LIVE_SCRIPT_EVAL=1 (and costs money: about 25 model
 * calls per page). It writes, under .data/script-eval/:
 *  - results.json: every script from both generators plus automated checks
 *  - report.md: the automated metrics side by side
 *  - blind-review.md: the old and new versions for each page shuffled and labelled A/B/C..., without
 *    saying which generator wrote them, to be rated by a person; blind-key.json holds the key.
 * The automated checks are a safety net, not a verdict: a person reading blind-review.md is the test.
 */
const live = process.env.LIVE_SCRIPT_EVAL === "1";

type Fixture = { key: string; brandName: string; url: string; seconds: number; quality: string; page: string; stats?: string[] };

const FIXTURES: Fixture[] = [
  {
    key: "roofing-rich",
    brandName: "Kestrel Roofing",
    url: "https://kestrelroofing.example",
    seconds: 30,
    quality: "specific page with a clear mechanism",
    page: `# Kestrel Roofing
## Hail damage is often invisible from the ground
After a hailstorm most roofs look fine from the driveway. The damage is in the shingle mat: bruises that crack months later and void your warranty. Insurers will only pay on a documented claim, and claims have a filing window.
## What a Kestrel storm inspection is
A two-person crew climbs your roof, chalks and photographs every damaged area, counts hits per test square and writes the report in the format your insurer asks for. You get the photos and the report the same day.
## Book your inspection
Book online and we inspect within 7 days of your call. Inspections are free for homeowners with a storm claim; if there is no damage we tell you so and leave. Call 1300 555 014 or use the form.
Serving the Hunter Valley since 2009. Licensed and insured, licence 118842C.`,
  },
  {
    key: "saas-rich",
    brandName: "Ledgerly",
    url: "https://ledgerly.example",
    seconds: 45,
    quality: "specific page, product demo available",
    page: `# Ledgerly: bank feeds that match themselves
Bookkeepers spend the first week of every month matching bank lines to invoices by hand. Ledgerly reads each bank line, proposes the matching invoice, and asks you only about the ones it is unsure of.
## How it works
1. Connect the client's bank feed (read-only).
2. Ledgerly matches by amount, reference and past behaviour. Anything under 90% confidence is queued for you with the reason.
3. You approve in bulk. Every match keeps an audit trail you can export.
## Pricing
$49 per client file per month. No setup fee. 14 day trial, no card needed.
"We cut month-end from 6 days to 2." Priya N., bookkeeper, 40 client files (testimonial, 2024)
Start your 14 day trial at ledgerly.example/trial.`,
  },
  {
    key: "dental-weak",
    brandName: "Bright Harbour Dental",
    url: "https://brightharbourdental.example",
    seconds: 30,
    quality: "weak copy full of marketing claims, no proof, no mechanism",
    page: `# Bright Harbour Dental
Welcome to Bright Harbour Dental, your trusted partner for a healthier smile! We are passionate about delivering world-class dental solutions tailored to you. Our state-of-the-art clinic offers a comprehensive range of services including check-ups, whitening, and more. We are the best dentist in town and guarantee you will love your results. Book your appointment today and take your smile to the next level!
Contact us on 02 5550 0188.`,
  },
  {
    key: "multi-brand",
    brandName: "Northline Plumbing",
    url: "https://northlineplumbing.example",
    seconds: 20,
    quality: "page that mentions several other brands",
    page: `# Northline Plumbing: hot water repairs
We repair and replace hot water systems. We install Rheem, Rinnai and Bosch units and repair most other brands. Rheem units come with a 12 year tank warranty from Rheem; Northline adds a 12 month warranty on our labour.
## Same-day hot water
If you call before noon on a weekday we aim to have a plumber at your door that afternoon. Emergency callouts after hours cost extra and we quote before we start.
Partners: Rheem Authorised Installer. As seen on a local radio station.
Request a quote at northlineplumbing.example/quote or call 07 5550 0133.`,
  },
  {
    key: "unsupported-claims",
    brandName: "Peakform Coaching",
    url: "https://peakform.example",
    seconds: 30,
    quality: "no proof and marketing claims that cannot be backed",
    page: `# Peakform Coaching
The #1 rated online fitness coaching program! Transform your body in just 30 days, guaranteed. Thousands of happy clients. Limited spots available, only 5 left this month! Get 50% off when you sign up today.
Our coaches build a plan around your week. Weekly check-ins by video.
Join now at peakform.example/join.`,
  },
];

describe.skipIf(!live)("live comparison of the old and new script generators", () => {
  it("runs both generators on every page and writes the report and the blind-review sheet", async () => {
    process.loadEnvFile(".env.local");
    // Use whichever provider has credit: the fallback tries the next, but a dead one only slows the run.
    if (process.env.EVAL_PROVIDER === "openai") delete process.env.ANTHROPIC_API_KEY;
    const { resetConfigCache } = await import("@/lib/config");
    resetConfigCache();

    const { buildCreativeBrief } = await import("@/lib/video/creative-brief");
    const { buildClaimRegistry } = await import("@/lib/video/claims");
    const { writeContextFor, editScripts } = await import("@/lib/video/brief");
    const { planAngles } = await import("@/lib/video/angles");
    const { writeScriptSet } = await import("@/lib/video/script-writer");
    const { overlapFindings, openingFindings, voiceFindings } = await import("@/lib/video/script-quality");
    const { resolveWordsPerSecond } = await import("@/lib/video/duration");
    const { writeVideoScripts, briefFacts, factsCorpus } = await import("@/lib/video/script");
    const { verifyAndFixAll } = await import("@/lib/video/verify");
    const { unsourcedFigures } = await import("@/lib/video/script");

    const out: Array<Record<string, unknown>> = [];
    const blind: string[] = ["# Blind review sheet", "", "Rate each version 1 to 5 for: would this make you keep watching (hook), does it sound like a person (voice), is it specific to this business, would you trust it, is it different from the others. Do not look at blind-key.json until you are done.", ""];
    const key: Record<string, Record<string, "old" | "new">> = {};
    const report: string[] = ["# Old vs new script generation: automated checks", "", "| page | generator | versions | distinct openings | opening flags | voice flags | unsourced figures | est. seconds (asked) | hard failures |", "|---|---|---|---|---|---|---|---|---|"];

    for (const f of FIXTURES) {
      const wps = resolveWordsPerSecond(null);
      // The same claims the app would have recorded for this page: stats and figures stated in its text.
      const claims = buildClaimRegistry({ stats: f.stats ?? [], assets: [], pageExcerpt: f.page, pageUrl: f.url });
      const input = {
        brandName: f.brandName,
        manifest: { offer: null, cta: null, audience: null, claims },
        pageUrl: f.url,
        pageText: f.page,
        operator: { offerDetails: null, instructions: null, stats: f.stats ?? [] },
        images: [],
        client: {},
        targetSeconds: f.seconds,
        locale: "en-AU",
      };
      const brief = {
        brandName: f.brandName,
        offerName: f.brandName,
        landingPageUrl: f.url,
        pageExcerpt: f.page.slice(0, 2500),
        pageText: f.page,
        stats: f.stats ?? [],
        images: [],
        targetSeconds: f.seconds,
        style: "auto",
        locale: "en-AU",
        claims: [],
      };

      // ---- NEW
      const creative = await buildCreativeBrief(input);
      if (creative.sourceQuality === "insufficient") {
        // The app stops here and asks for what is missing instead of writing.
        out.push({ page: f.key, newNeedsContext: creative.limitation, gaps: creative.gaps.map((g) => g.ask) });
        report.push(`| ${f.key} | new | stopped: needs more information (${creative.limitation}) | | | | | | |`);
        continue;
      }
      const planned = await planAngles(creative, { count: 3 });
      const project = { inputs: { speechRate: null, goal: null, platform: null }, brand: { manifest: null }, assets: [] } as never;
      const ctx = writeContextFor(project, creative, { ...brief, claims } as never);
      const written = await writeScriptSet(ctx, planned.angles);
      // The same editing step the app runs (editorial pass with whole-script rewrites, then the length cut).
      const newScripts = await editScripts(written.scripts, ctx, planned.angles);

      // ---- OLD
      let oldScripts: Awaited<ReturnType<typeof writeVideoScripts>>["scripts"] = [];
      try {
        const old = await writeVideoScripts(brief as never);
        oldScripts = await verifyAndFixAll(old.scripts, { brief: brief as never, facts: briefFacts(brief as never), corpus: factsCorpus(brief as never), assetIds: [], target: f.seconds });
      } catch (error) {
        out.push({ page: f.key, oldError: error instanceof Error ? error.message : String(error) });
      }

      const metrics = (scripts: typeof newScripts, label: string) => {
        const openings = scripts.map((s) => s.scenes.find((x) => x.line.trim())?.line ?? "");
        const lines = scripts.flatMap((s) => s.scenes.filter((x) => x.line.trim()).map((x) => ({ scene: x.number, line: x.line })));
        const overlap = overlapFindings(scripts.map((s) => ({ id: s.id, lines: s.scenes.map((x) => x.line).filter(Boolean), premise: s.angleDetail?.hookPremise ?? s.pain })));
        const est = scripts.map((s) => Math.round(s.speech?.estimatedSeconds ?? s.durationSeconds));
        const unsourced = scripts.reduce((t, s) => t + unsourcedFigures(s, []).length, 0);
        const hard = scripts.reduce((t, s) => t + (s.editorial?.hardFailures.length ?? 0), 0);
        report.push(`| ${f.key} | ${label} | ${scripts.length} | ${new Set(openings.map((o) => o.toLowerCase().split(/\s+/).slice(0, 3).join(" "))).size}/${scripts.length} | ${openings.reduce((t, o) => t + openingFindings(o).length, 0)} | ${voiceFindings(lines).length} | ${unsourced} | ${est.join("/")} (${f.seconds}) | ${label === "new" ? hard : "n/a"} |`);
        return { openings, overlap: overlap.pairs, est, unsourced, hard };
      };
      const newM = metrics(newScripts, "new");
      const oldM = oldScripts.length ? metrics(oldScripts as never, "old") : null;
      out.push({
        page: f.key,
        quality: f.quality,
        brief: { sourceQuality: creative.sourceQuality, limitation: creative.limitation, facts: creative.facts.length, rejected: creative.rejectedFacts.length, gaps: creative.gaps.map((g) => g.why), defaults: creative.defaults.map((d) => d.field) },
        angles: planned.angles.map((a) => ({ name: a.name, situation: a.situation, hookPremise: a.hookPremise })),
        angleLimitation: planned.limitation,
        newMetrics: newM,
        oldMetrics: oldM,
        newScripts: newScripts.map((s) => ({ angle: s.angle.name, lines: s.scenes.map((x) => x.line), cta: s.cta, speech: s.speech, editorial: s.editorial ? { fixes: s.editorial.fixes.length, hard: s.editorial.hardFailures.map((h) => h.problem), limitation: s.editorial.limitation } : null, visualDirection: s.visualDirection })),
        oldScripts: oldScripts.map((s) => ({ angle: s.angle.name, lines: s.scenes.map((x) => x.line), style: s.style })),
      });

      // ---- the blind sheet: shuffled, unlabelled
      const entries = [...newScripts.map((s) => ({ gen: "new" as const, lines: s.scenes.map((x) => x.line).filter(Boolean), cta: s.cta?.spoken })), ...oldScripts.map((s) => ({ gen: "old" as const, lines: s.scenes.map((x) => x.line).filter(Boolean), cta: undefined }))].sort(() => Math.random() - 0.5);
      blind.push(`## ${f.brandName} (${f.seconds}s, ${f.quality})`, "");
      key[f.key] = {};
      entries.forEach((e, i) => {
        const label = String.fromCharCode(65 + i);
        key[f.key]![label] = e.gen;
        blind.push(`### Version ${label}`, "", e.lines.join("\n\n"), "");
      });
    }

    const dir = path.join(process.cwd(), ".data", "script-eval");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "results.json"), JSON.stringify(out, null, 2));
    writeFileSync(path.join(dir, "report.md"), report.join("\n"));
    writeFileSync(path.join(dir, "blind-review.md"), blind.join("\n"));
    writeFileSync(path.join(dir, "blind-key.json"), JSON.stringify(key, null, 2));
  }, 1_800_000);
});
