import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse, stringify } from "yaml";
import { parseKnowledge, withInfluencerLoose, type KnowledgeEntry } from "../context.js";
import { many, one } from "../db/pool.js";
import { primaryAccount } from "../instagram/accounts.js";
import { errorMessage, PermanentError } from "../lib/errors.js";
import { recordEvent } from "../lib/events.js";
import { llm } from "../llm/llm.js";
import { parsePersona } from "../persona/parse.js";
import type { Persona } from "../persona/schema.js";
import { SLOTS } from "../persona/schema.js";
import { outfits } from "../content/wardrobe.js";
import { activeSoul } from "../souls/souls.js";
import { latestBrief, refreshTrends } from "../trends/trends.js";
import { COMPOSE_TIMEOUT_MS } from "./compose.js";
import { getInfluencer, updatePersona } from "./manage.js";
import { composeProfileText, getKit, profilePictureFromSoul } from "./profile.js";

/**
 * The Influencer Standard: one master checklist every influencer is measured
 * against, whatever it was hatched with. Each check says how it gets fixed:
 *   auto    the platform does it (business AI-disclosure entry, profile kit, news brief)
 *   ai      the model extends the persona, touching only the failing sections
 *   manual  needs a person (a face, an Instagram login, true business facts)
 * "Bring up to standard" runs every auto and ai fix and reports what's left.
 */

export const STANDARD = {
  tops: 10,
  bottoms: 7,
  layers: 3,
  activewear: 3,
  looks: 300,
  signature_outfits: 6,
  occasions: 2,
  activities: 8,
  activity_slots: 4,
  weekend_activities: 4,
  weekend_ideas: 5,
  locations: 4,
  trend_queries: 5,
  trends_max_age_h: 36,
} as const;

export type FixKind = "auto" | "ai" | "manual";
export interface Check {
  key: string;
  group: "Persona" | "Wardrobe" | "Daily life" | "News" | "Assets";
  label: string;
  ok: boolean;
  detail: string;
  fix: FixKind;
  /** For manual fixes: where the operator does it. */
  href?: string;
}
export interface StandardReport {
  id: number;
  name: string;
  status: string;
  checks: Check[];
  passed: number;
  total: number;
  looks: number;
}

/** Persona sections the model may (re)write to meet the standard, keyed by check. */
const SECTION: Record<string, string> = {
  closet: "visual.character.closet",
  signature: "visual.character.wardrobe",
  occasions: "visual.character.closet.occasions",
  activities: "daily_life.activities",
  weekend: "daily_life.activities",
  weekend_ideas: "weekend_ideas",
  locations: "visual.locations",
  trends: "trends",
};

const isWeekend = (a: Persona["daily_life"]["activities"][number]) => a.weekends_only || a.days.some((d) => d === "saturday" || d === "sunday");
const short = (have: number, need: number, what: string) => (have >= need ? `${have} ${what}` : `${have} ${what} (standard ${need})`);

/** Persona checks: pure, testable, no I/O. */
export function personaChecks(p: Persona): Check[] {
  const c = p.visual.character.closet;
  const looks = outfits(p).length;
  // Dresses/jumpsuits count toward looks but aren't required: not every influencer wears them.
  const closetOk = c.tops.length >= STANDARD.tops && c.bottoms.length >= STANDARD.bottoms && c.layers.length >= STANDARD.layers && c.activewear.length >= STANDARD.activewear && looks >= STANDARD.looks;
  const acts = p.daily_life.activities;
  const slots = new Set(acts.map((a) => a.slot));
  const weekend = acts.filter(isWeekend).length;
  const q = p.trends.queries;
  const labelled = q.filter((x) => typeof x !== "string").length;
  return [
    { key: "disclosure", group: "Persona", label: "Openly AI", ok: /\bai\b|artificial/i.test(p.identity.ai_disclosure), detail: p.identity.ai_disclosure.slice(0, 120), fix: "manual", href: "/admin/persona#edit" },
    {
      key: "closet",
      group: "Wardrobe",
      label: `Closet of separates (${STANDARD.looks}+ looks)`,
      ok: closetOk,
      detail: `${looks} looks · ${short(c.tops.length, STANDARD.tops, "tops")}, ${short(c.bottoms.length, STANDARD.bottoms, "bottoms")}, ${short(c.layers.length, STANDARD.layers, "layers")}, ${c.one_pieces.length} dresses, ${short(c.activewear.length, STANDARD.activewear, "activewear")}`,
      fix: "ai",
    },
    { key: "signature", group: "Wardrobe", label: "Signature outfits", ok: p.visual.character.wardrobe.length >= STANDARD.signature_outfits, detail: short(p.visual.character.wardrobe.length, STANDARD.signature_outfits, "outfits"), fix: "ai" },
    { key: "occasions", group: "Wardrobe", label: "Occasion wear", ok: c.occasions.length >= STANDARD.occasions, detail: c.occasions.map((o) => o.occasion).join(", ") || "none", fix: "ai" },
    {
      key: "activities",
      group: "Daily life",
      label: "A full day",
      ok: acts.length >= STANDARD.activities && slots.size >= STANDARD.activity_slots,
      detail: `${short(acts.length, STANDARD.activities, "activities")} across ${short(slots.size, STANDARD.activity_slots, "time slots")}`,
      fix: "ai",
    },
    { key: "weekend", group: "Daily life", label: "Weekend life", ok: weekend >= STANDARD.weekend_activities, detail: short(weekend, STANDARD.weekend_activities, "weekend activities"), fix: "ai" },
    { key: "weekend_ideas", group: "Daily life", label: "Weekend post ideas", ok: p.weekend_ideas.length >= STANDARD.weekend_ideas, detail: short(p.weekend_ideas.length, STANDARD.weekend_ideas, "ideas"), fix: "ai" },
    { key: "locations", group: "Daily life", label: "Places she goes", ok: p.visual.locations.length >= STANDARD.locations, detail: short(p.visual.locations.length, STANDARD.locations, "locations"), fix: "ai" },
    {
      key: "trends",
      group: "News",
      label: "News & trends sources",
      ok: q.length >= STANDARD.trend_queries && labelled >= STANDARD.trend_queries && Boolean(p.trends.region),
      detail: `${short(q.length, STANDARD.trend_queries, "searches")}, ${labelled} labelled, region ${p.trends.region || "not set"}`,
      fix: "ai",
    },
  ];
}

/** Entries that make replies true: the AI disclosure, and real business facts when the persona is affiliated. */
export function knowledgeChecks(p: Persona, kb: KnowledgeEntry[]): Check[] {
  const ai = kb.some((k) => k.keywords.some((w) => /^(ai|bot|real|human)$/i.test(w)));
  const affiliated = Boolean(p.identity.affiliation?.trim()) && !/independent|none/i.test(p.identity.affiliation ?? "");
  const facts = kb.some((k) => (k.must_include?.length ?? 0) > 0);
  return [
    { key: "kb_ai", group: "Assets", label: "Replies know she's AI", ok: ai, detail: ai ? "AI-disclosure entry present" : "no AI-disclosure entry in business knowledge", fix: "auto" },
    {
      key: "kb_facts",
      group: "Assets",
      label: "True business facts",
      ok: !affiliated || facts,
      detail: !affiliated ? "independent creator: none needed" : facts ? "address/contact facts with required details" : `affiliated with ${p.identity.affiliation}: add its real address and contacts (must_include) so replies can state them`,
      fix: "manual",
      href: "/admin/persona#edit",
    },
  ];
}

export async function evaluate(id: number): Promise<StandardReport> {
  const inf = await getInfluencer(id);
  if (!inf) throw new PermanentError(`influencer ${id} not found`);
  const base = { id, name: inf.name, status: inf.status };
  let p: Persona | undefined;
  try {
    p = inf.persona_yaml.trim() ? parsePersona(inf.persona_yaml) : undefined;
  } catch {
    p = undefined;
  }
  const checks: Check[] = [];
  if (!p) {
    checks.push({ key: "persona", group: "Persona", label: "A valid persona", ok: false, detail: inf.persona_yaml.trim() ? "the persona doesn't validate" : "no persona yet: finish the hatch", fix: "manual", href: `/admin/hatch/${id}` });
  } else {
    checks.push({ key: "persona", group: "Persona", label: "A valid persona", ok: true, detail: p.identity.occupation.slice(0, 80), fix: "manual" });
    checks.push(...personaChecks(p));
    checks.push(...knowledgeChecks(p, parseKnowledge(inf.knowledge_yaml ?? "")));
  }
  const [soul, acct, kit, brief] = await Promise.all([activeSoul(id), primaryAccount(id), getKit(id), latestBrief(id).catch(() => undefined)]);
  checks.push({ key: "soul", group: "Assets", label: "Soul face", ok: Boolean(soul?.identityRefs.length), detail: soul ? `${soul.soul.soul_id}, ${soul.identityRefs.length} reference(s)` : "no soul yet", fix: "manual", href: inf.status === "hatching" ? `/admin/hatch/${id}?step=soul` : "/admin/persona#soul" });
  const bio = Boolean(kit.text?.bios?.length);
  const pic = Boolean(kit.pictures?.length);
  checks.push({ key: "profile", group: "Assets", label: "Profile kit (bio + picture)", ok: bio && pic, detail: `${bio ? "bio written" : "no bio"}, ${pic ? "picture ready" : "no picture"}`, fix: soul ? "auto" : "manual", href: "/admin/profile" });
  checks.push({ key: "instagram", group: "Assets", label: "Instagram connected", ok: Boolean(acct), detail: acct ? `@${acct.username ?? acct.ig_user_id}` : "no account attached", fix: "manual", href: inf.status === "hatching" ? `/admin/hatch/${id}?step=instagram` : "/admin/persona#instagram" });
  const fresh = brief && Date.now() - new Date(brief.created_at).getTime() < STANDARD.trends_max_age_h * 3600_000;
  if (p) checks.push({ key: "brief", group: "News", label: "Fresh news brief", ok: Boolean(fresh), detail: brief ? `${brief.items.length} items, ${Math.round((Date.now() - new Date(brief.created_at).getTime()) / 3600_000)}h old` : "never collected", fix: "auto" });
  return { ...base, checks, passed: checks.filter((c) => c.ok).length, total: checks.length, looks: p ? outfits(p).length : 0 };
}

export async function evaluateAll(): Promise<StandardReport[]> {
  const rows = await many<{ id: number }>("SELECT id FROM influencers WHERE status <> 'archived' ORDER BY id");
  return Promise.all(rows.map((r) => evaluate(Number(r.id))));
}

// ------------------------------------------------------------------ fixing

const UPGRADE_SYSTEM = `You extend an existing AI Instagram creator persona so it meets the platform standard.
Return ONLY a YAML mapping whose keys are the dotted section paths you were asked for, each with its COMPLETE new value (no code fences, no commentary).
Rules:
- Keep everything that already exists in a section (same items, same ids, same wording) and ADD to it until the minimums are met. Never rename existing location ids.
- Stay true to this person: their city, culture, faith, style, budget and voice as the persona describes them. Specific colours, fabrics and cuts; no brand logos.
- visual.character.closet: tops, bottoms, layers, one_pieces, activewear (lists of strings) and occasions (list of {occasion, outfit, keywords, days}); days are lowercase weekday names.
- daily_life.activities: items {slot, activity, locations, postable, weight, weekdays_only, weekends_only, days}; slot is EXACTLY one of: ${SLOTS.join(", ")}; locations are ids from visual.locations (existing or ones you add in the same answer).
- visual.locations: items {id, description, slots}; ids are lowercase-with-dashes.
- trends: {region, language, max_items, queries: [{query, label}], feeds: [{url, label}], avoid}; keep existing feeds; label queries like "TikTok <Country>", "Instagram <City>", "X <Country>".`;

/** Sections that are plain lists of strings: models sometimes send objects instead. */
const STRING_LISTS = new Set(["visual.character.wardrobe", "weekend_ideas"]);
const CLOSET_LISTS = ["tops", "bottoms", "layers", "one_pieces", "activewear"];

/** The value at a dotted path. */
const at = (o: unknown, path: string) => path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), o);

/** "Match this structure": each requested section from the reference persona, lists cut to two items. */
export function structureExamples(paths: string[]): string {
  let ref: unknown;
  try {
    ref = parse(readFileSync(resolve(process.env.PERSONA_PATH ?? "config/persona.yaml"), "utf8"));
  } catch {
    return "";
  }
  const trim = (v: unknown): unknown => (Array.isArray(v) ? v.slice(0, 2).map(trim) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trim(x)])) : v);
  const out = Object.fromEntries(paths.map((p) => [p, trim(at(ref, p))]).filter(([, v]) => v !== undefined));
  return Object.keys(out).length ? stringify(out, { lineWidth: 0 }) : "";
}

/** Ask the model for the failing sections only, merge them in, validate, save. */
export async function upgradePersona(id: number, failing: Check[]): Promise<string[]> {
  const inf = (await getInfluencer(id))!;
  const sections = [...new Set(failing.map((c) => SECTION[c.key]).filter(Boolean))];
  // occasions live inside the closet: send the whole closet when both are asked for.
  const paths = sections.includes("visual.character.closet") ? sections.filter((s) => s !== "visual.character.closet.occasions") : sections;
  if (!paths.length) return [];
  // New locations must travel with new activities that use them.
  if (paths.includes("daily_life.activities") && !paths.includes("visual.locations")) paths.push("visual.locations");
  const need = failing.filter((c) => SECTION[c.key]).map((c) => `- ${c.label}: ${c.detail}`).join("\n");
  const minimums = `Minimums: closet ${STANDARD.tops} tops, ${STANDARD.bottoms} bottoms, ${STANDARD.layers} layers, ${STANDARD.activewear} activewear sets (one_pieces only if they fit this person's style), ${STANDARD.occasions}+ occasions; ${STANDARD.signature_outfits}+ signature outfits; ${STANDARD.activities}+ activities over ${STANDARD.activity_slots}+ slots incl. ${STANDARD.weekend_activities}+ weekend ones (weekends_only or saturday/sunday days); ${STANDARD.weekend_ideas}+ weekend_ideas; ${STANDARD.locations}+ locations; ${STANDARD.trend_queries}+ labelled trend queries and a region.`;
  const shapes = structureExamples(paths);
  const prompt = `CURRENT PERSONA:\n${inf.persona_yaml}\n\nWHAT FALLS SHORT:\n${need}\n\n${minimums}\n\n${
    shapes ? `STRUCTURE TO MATCH (from a different creator: copy the exact shape of each key, lists of plain strings stay plain strings; never copy the content):\n${shapes}\n\n` : ""
  }Return the complete new value for exactly these keys: ${paths.join(", ")}.`;
  let text = await llm().generate({ operation: "persona.upgrade", tier: "smart", maxTokens: 8000, timeoutMs: COMPOSE_TIMEOUT_MS, system: UPGRADE_SYSTEM, prompt });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const merged = mergeSections(inf.persona_yaml, text, paths);
      parsePersona(merged); // validates before anything is saved
      await updatePersona(id, merged, undefined, "standard");
      return paths;
    } catch (e) {
      if (attempt === 1) throw new PermanentError(`the persona upgrade was invalid twice: ${errorMessage(e)}`);
      text = await llm().generate({
        operation: "persona.upgrade.repair",
        tier: "smart",
        maxTokens: 8000,
        timeoutMs: COMPOSE_TIMEOUT_MS,
        system: UPGRADE_SYSTEM,
        prompt: [
          { role: "user", content: prompt },
          { role: "assistant", content: text },
          { role: "user", content: `That failed: ${errorMessage(e)}\nReturn the corrected YAML mapping only.` },
        ],
      });
    }
  }
  return [];
}

/** Replace only the given dotted paths in the persona with the model's values; everything else stays byte-for-byte meaningful. */
export function mergeSections(personaYaml: string, sectionsYaml: string, paths: string[]): string {
  const base = parse(personaYaml) as Record<string, unknown>;
  const clean = sectionsYaml.replace(/^```(?:ya?ml)?\s*/i, "").replace(/```\s*$/, "").trim();
  const got = parse(clean) as Record<string, unknown> | null;
  if (!got || typeof got !== "object") throw new Error("the model didn't return a YAML mapping");
  for (const path of paths) {
    let value = got[path] ?? at(got, path);
    if (value === undefined) throw new Error(`missing section ${path}`);
    coerceShapes(path, value, (v) => (value = v));
    const keys = path.split(".");
    let node = base;
    for (const k of keys.slice(0, -1)) {
      if (!node[k] || typeof node[k] !== "object") node[k] = {};
      node = node[k] as Record<string, unknown>;
    }
    node[keys.at(-1)!] = value;
  }
  return stringify(base, { lineWidth: 0 });
}

/** One plain string from whatever the model sent for a list item. */
function asText(x: unknown): string | undefined {
  if (typeof x === "string") return x.trim() || undefined;
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    for (const k of ["text", "idea", "outfit", "description", "title", "name", "value"]) if (typeof o[k] === "string") return (o[k] as string).trim();
    const strings = Object.values(o).filter((v): v is string => typeof v === "string");
    return strings.length ? strings.join(": ") : undefined;
  }
  return undefined;
}

/** Forgive common shape slips (objects where plain strings belong) before strict validation. */
export function coerceShapes(path: string, value: unknown, set: (v: unknown) => void): void {
  const list = (v: unknown): string[] => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : []).map(asText).filter((s): s is string => Boolean(s));
  if (STRING_LISTS.has(path)) set(list(value));
  if (path === "visual.character.closet" && value && typeof value === "object") {
    const c = value as Record<string, unknown>;
    for (const k of CLOSET_LISTS) if (c[k] !== undefined) c[k] = list(c[k]);
  }
}

const AI_ENTRY = (p: Persona): KnowledgeEntry => ({
  id: "ai-creator",
  keywords: ["ai", "real", "human", "bot", "fake", "robot", "generated", "person"],
  content: `${p.identity.ai_disclosure.trim()} Say so plainly when sincerely asked.`,
});

export interface StandardRun {
  status: "running" | "done" | "failed";
  started_at: string;
  finished_at?: string;
  fixed: string[];
  remaining: string[];
  error?: string | null;
}

async function saveRun(id: number, run: StandardRun): Promise<void> {
  await one("UPDATE influencers SET standard_run = $2 WHERE id = $1", [id, JSON.stringify(run)]);
}

/**
 * `influencer.standardize` job: run every auto and ai fix for one influencer,
 * then re-check. Manual items are listed for the operator, never guessed.
 */
export async function standardize(id: number): Promise<StandardRun> {
  const run: StandardRun = { status: "running", started_at: new Date().toISOString(), fixed: [], remaining: [] };
  await saveRun(id, run);
  try {
    await withInfluencerLoose(id, async () => {
      let report = await evaluate(id);
      const failing = report.checks.filter((c) => !c.ok);
      const ai = failing.filter((c) => c.fix === "ai");
      if (ai.length) {
        const done = await upgradePersona(id, ai);
        if (done.length) run.fixed.push(...ai.map((c) => c.label));
      }
      // Re-read: the persona may have changed.
      const inf = (await getInfluencer(id))!;
      const p = inf.persona_yaml.trim() ? parsePersona(inf.persona_yaml) : undefined;
      if (p && failing.some((c) => c.key === "kb_ai")) {
        const kb = inf.knowledge_yaml?.trim() ? (parse(inf.knowledge_yaml) as { entries?: unknown[] }) : { entries: [] };
        const entries = [...(kb.entries ?? []), AI_ENTRY(p)];
        await updatePersona(id, inf.persona_yaml, stringify({ entries }, { lineWidth: 0 }), "standard");
        run.fixed.push(failing.find((c) => c.key === "kb_ai")!.label);
      }
      if (failing.some((c) => c.key === "profile" && c.fix === "auto")) {
        const kit = await getKit(id);
        if (!kit.pictures?.length) await profilePictureFromSoul().catch((e) => recordEvent("warn", "standard", `Profile picture not made: ${errorMessage(e)}`));
        if (!kit.text?.bios?.length) await composeProfileText().catch((e) => recordEvent("warn", "standard", `Profile text not written: ${errorMessage(e)}`));
        run.fixed.push(failing.find((c) => c.key === "profile")!.label);
      }
      if (p && failing.some((c) => c.key === "brief")) {
        await refreshTrends().catch((e) => recordEvent("warn", "standard", `News brief not refreshed: ${errorMessage(e)}`));
        run.fixed.push(failing.find((c) => c.key === "brief")!.label);
      }
      report = await evaluate(id);
      run.remaining = report.checks.filter((c) => !c.ok).map((c) => `${c.label}: ${c.detail}`);
      run.fixed = [...new Set(run.fixed)].filter((f) => report.checks.some((c) => c.label === f && c.ok));
    });
    run.status = "done";
  } catch (e) {
    run.status = "failed";
    run.error = errorMessage(e).slice(0, 400);
  }
  run.finished_at = new Date().toISOString();
  await saveRun(id, run);
  await recordEvent(run.status === "done" ? "info" : "warn", "standard", `Standard run for #${id}: ${run.status}`, { fixed: run.fixed, remaining: run.remaining, error: run.error });
  return run;
}
