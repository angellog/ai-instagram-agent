import { parse, stringify } from "yaml";
import { z } from "zod";
import { influencerId, invalidateInfluencer, parseKnowledge, type KnowledgeEntry } from "../context.js";
import { many, one } from "../db/pool.js";
import { knowledgeChecks, personaChecks } from "../influencers/standard.js";
import { getInfluencer, updatePersona } from "../influencers/manage.js";
import { PermanentError } from "../lib/errors.js";
import { recordEvent } from "../lib/events.js";
import { llm } from "../llm/llm.js";
import { applyMemoryPolicy } from "../memory/policy.js";
import { upsertMemory } from "../memory/store.js";
import { parsePersona } from "../persona/parse.js";
import { pronouns } from "../persona/pronouns.js";
import type { Persona } from "../persona/schema.js";

/**
 * The Interview: the easy way to keep an influencer's persona, soul and
 * business facts growing. It asks a few specific questions at a time (what's
 * missing first, then what's thin, then life and voice), turns the answers into
 * a small structured change set, shows it, and applies it only on Save.
 */

export interface Question {
  topic: string;
  question: string;
  why: string;
  placeholder?: string;
}

type Ask = (p: Persona) => Question | undefined;

function bank(p: Persona): Record<string, Ask> {
  const n = p.identity.name;
  const pr = pronouns(p);
  const brand = p.brand?.name ?? p.identity.affiliation?.replace(/\s*\(.*\)\s*$/, "");
  const city = p.identity.location.split(",")[0];
  return {
    business_location: () =>
      brand ? { topic: "business_location", question: `Where exactly is ${brand}? Building or mall, floor, shop number, area and city.`, why: `${n} is asked "where's the shop?" and can only answer with the real address.`, placeholder: "e.g. Pioneer Mall, Level 5, Shop PH-100, Kampala" } : undefined,
    business_order: () =>
      brand ? { topic: "business_order", question: `How do customers order or get in touch with ${brand}? WhatsApp number, Instagram handle, delivery or pick-up.`, why: "Replies to \"how do I order?\" quote this exactly.", placeholder: "e.g. WhatsApp 0789 652 909, DM @feetbit.sneakers, delivery within Kampala" } : undefined,
    business_hours: () => (brand ? { topic: "business_hours", question: `What are ${brand}'s opening days and hours?`, why: "People ask before visiting.", placeholder: "e.g. Mon-Sat 9am-8pm, Sun 12-6pm" } : undefined),
    business_products: () =>
      brand ? { topic: "business_products", question: `What does ${brand} sell most right now, and is there anything ${n} should always mention or never promise?`, why: `Keeps ${n}'s product talk true.`, placeholder: "Best sellers, new arrivals, rules (e.g. never promise sizes)" } : undefined,
    social_life: () => ({ topic: "social_life", question: `What does ${n} do for fun? Films or series, music, games, a team ${pr.subj} follow${pr.is === "is" ? "s" : ""}, events ${pr.subj} go${pr.is === "is" ? "es" : ""} to in ${city}.`, why: "Small talk needs a life outside the niche.", placeholder: "Be specific: names of shows, artists, games, places" }),
    life_recent: () => ({ topic: "life_recent", question: `What has ${n} been up to lately? Anything ${pr.subj} did, saw or tried this week.`, why: `Becomes part of ${n}'s remembered story, used in chats.`, placeholder: "e.g. went to a sneaker meetup at Acacia, tried a new rolex spot" }),
    life_upcoming: () => ({ topic: "life_upcoming", question: `Anything coming up for ${n}? Events, trips, launches, a friend's wedding.`, why: "Plans give chats and posts something to look forward to.", placeholder: "Dates if you know them" }),
    storyline: () => ({ topic: "storyline", question: `What is ${n} working towards over the next few weeks? Training for something, learning a skill, a project, saving for a trip. What are the steps, and what could go wrong along the way?`, why: "Becomes a storyline the feed follows one small step at a time, so posts read like a life, not stock photos.", placeholder: "e.g. learning to braid her own hair: buys the extensions, first attempt is a disaster, YouTube nights, auntie's lesson, wears it to church" }),
    circle: () => ({ topic: "circle", question: `Who are the people in ${n}'s life? A best friend, a sibling, a cousin, a coworker: first names and one detail each.`, why: `${n} mentions them the way real people mention friends (never their faces in photos).`, placeholder: "e.g. Nana, best friend, always late; Brian, cousin, sore loser at FIFA" }),
    moments: () => ({ topic: "moments", question: `Name a few small, very specific things that happen in ${n}'s days in ${city}. The kind of detail a real person posts about.`, why: "Posts built on real details don't look generic or AI-made.", placeholder: "e.g. the rolex guy starts folding hers before she orders; the power goes off mid-routine; rain on the iron-sheet roof" }),
    short_form: () => ({ topic: "short_form", question: `What gets ${n}'s followers talking? A few funny questions ${pr.subj}'d ask, silly takes, and the football club ${pr.subj} support${pr.is === "is" ? "s" : ""} (and its rivals), if any.`, why: "Short talk reels and stories built to get replies. Playful only.", placeholder: "e.g. white sneakers in rainy season: brave or reckless?; Arsenal, rivals Spurs and Chelsea" }),
    scout: () => ({ topic: "scout", question: `Which hashtags does ${n}'s crowd post under, and how should ${n} comment on other people's posts?`, why: "The engagement scout reads these hashtags and drafts comments for you to post.", placeholder: "e.g. #kampala #ugandanfashion; short, specific, warm, never selling" }),
    voice_greeting: () => ({ topic: "voice_greeting", question: `How does ${n} greet friends and react to compliments? Any slang or local phrases ${pr.subj} use${pr.is === "is" ? "s" : ""}?`, why: "Makes replies sound like a person from here.", placeholder: "e.g. 'eh nyabo!', 'webale', 'you're too kind'" }),
    voice_never: () => ({ topic: "voice_never", question: `Is there anything ${n} should never say, joke about or get into?`, why: "Becomes a boundary for every reply and post.", placeholder: "Topics, words, competitors" }),
    audience: () => ({ topic: "audience", question: `Who follows ${n}, and what do they ask most?`, why: "Shapes what gets posted and how replies sound.", placeholder: "Age, city, what they care about, common questions" }),
    places: () => {
      const thin = p.visual.locations.find((l) => (l.look ?? "").length < 60);
      return thin ? { topic: `place:${thin.id}`, question: `What does "${thin.description}" really look like? Floor, walls, furniture, light, signage, what's outside.`, why: "Photos of this place will match the real thing.", placeholder: "Describe it like you're standing in it" } : undefined;
    },
  };
}

/** Up to `limit` questions: missing business facts, then whatever the Standard finds short, then life and voice (not asked in 14 days). */
export async function nextQuestions(p: Persona, knowledge: KnowledgeEntry[], limit = 3): Promise<Question[]> {
  const b = bank(p);
  const recent = new Set((await many<{ topic: string }>("SELECT DISTINCT topic FROM interview_answers WHERE influencer_id = $1 AND created_at > now() - interval '14 days'", [influencerId()])).map((r) => r.topic));
  const order: string[] = [];
  const failing = new Set([...personaChecks(p), ...knowledgeChecks(p, knowledge)].filter((c) => !c.ok).map((c) => c.key));
  const hasFacts = knowledge.some((k) => k.must_include?.length);
  if (p.identity.affiliation && !hasFacts) order.push("business_location", "business_order");
  if (failing.has("social_life")) order.push("social_life");
  if (failing.has("local_look")) order.push("places");
  if (failing.has("life_arcs")) order.push("storyline");
  if (failing.has("circle")) order.push("circle");
  if (failing.has("moments")) order.push("moments");
  if (failing.has("short_form")) order.push("short_form");
  if (failing.has("scout")) order.push("scout");
  order.push("life_recent", "storyline", "voice_greeting", "audience", "life_upcoming", "business_hours", "business_products", "voice_never", "moments", "circle", "social_life", "places");
  const out: Question[] = [];
  for (const key of order) {
    if (out.length >= limit) break;
    const q = b[key]?.(p);
    if (!q || recent.has(q.topic) || out.some((o) => o.topic === q.topic)) continue;
    out.push(q);
  }
  return out;
}

export const changeSchema = z.object({
  interests_add: z.array(z.string()).max(8),
  signature_phrases_add: z.array(z.string()).max(5),
  avoid_phrases_add: z.array(z.string()).max(5),
  boundaries_add: z.array(z.string()).max(4),
  weekend_ideas_add: z.array(z.string()).max(4),
  location_looks: z.array(z.object({ id: z.string(), look: z.string() })).max(6),
  arcs_add: z.array(z.object({ title: z.string(), story: z.string(), beats: z.array(z.string()).describe("5-7 small ordered steps, an honest setback included") })).max(2),
  moments_add: z.array(z.string()).max(10),
  circle_add: z.array(z.object({ name: z.string(), who: z.string() })).max(4),
  questions_add: z.array(z.string()).max(10),
  silly_talk_add: z.array(z.string()).max(8),
  football: z.object({ team: z.string(), league: z.string(), rivals: z.array(z.string()) }).nullable().describe("Only when the answer names a club they support; null otherwise"),
  scout_hashtags_add: z.array(z.string()).max(8),
  comment_style: z.string().describe("How they comment on other people's posts, if the answer says; empty otherwise"),
  knowledge: z
    .array(
      z.object({
        id: z.string().describe("lowercase-dashes id, e.g. 'shop-location', 'how-to-order'"),
        keywords: z.array(z.string()).min(1),
        content: z.string(),
        must_include: z.array(z.string()).describe("Exact phrases a reply citing this must contain (full address, phone number); [] if none"),
      }),
    )
    .max(6),
  memories: z.array(z.object({ kind: z.enum(["self_fact", "self_plan"]), content: z.string(), expires_on: z.string().nullable() })).max(8),
  summary: z.array(z.string()).describe("One plain line per change, for the person to review"),
});
export type ChangeSet = z.infer<typeof changeSchema>;

const APPLY_SYSTEM = `You turn interview answers about an AI Instagram creator into a small, precise change set. Use ONLY what the answers say; never invent facts, prices, numbers or addresses.
- Business facts (address, ordering, hours, products) become knowledge entries; put the exact address and phone/handle in must_include, copied character for character.
- Things the creator did, does or will do become memories (third person, using their name): self_fact for ongoing truths and past experiences, self_plan for upcoming things (with a date if given).
- Tastes and hobbies become interests_add; phrases they use become signature_phrases_add; things to never say become avoid_phrases_add or boundaries_add.
- A description of a place becomes location_looks for that location id.
- Something they're working towards over weeks becomes arcs_add (title, 1-2 sentence story, 5-7 small ordered beats from the answer, an honest setback included). Small specific details of their days become moments_add. People in their life become circle_add (first name, one detail). Never romance storylines or partners.
- Funny questions become questions_add, silly takes silly_talk_add, the club they support (with rivals) football, community hashtags (no #) scout_hashtags_add, and how they comment on others' posts comment_style. Playful only: drop anything romantic, sexual or about people's looks.
- Skip anything already in the current persona or knowledge. Return JSON only.`;

/** Answers → a reviewable change set (nothing is saved yet). */
export async function draftChanges(p: Persona, knowledge: KnowledgeEntry[], qa: Array<{ topic: string; question: string; answer: string }>): Promise<ChangeSet> {
  const answered = qa.filter((x) => x.answer.trim());
  if (!answered.length) throw new PermanentError("answer at least one question");
  return llm().structured(changeSchema, {
    operation: "interview.apply",
    tier: "smart",
    maxTokens: 2500,
    system: APPLY_SYSTEM,
    prompt: [
      `CREATOR: ${p.identity.name}, ${p.identity.occupation}, ${p.identity.location}`,
      `CURRENT INTERESTS: ${p.interests.join("; ")}`,
      `CURRENT PHRASES: ${p.communication_style.signature_phrases.join("; ") || "none"}`,
      `LOCATIONS (id: description): ${p.visual.locations.map((l) => `${l.id}: ${l.description}`).join(" | ")}`,
      `CURRENT KNOWLEDGE IDS: ${knowledge.map((k) => k.id).join(", ") || "none"}`,
      `ANSWERS:\n${answered.map((x) => `Q (${x.topic}): ${x.question}\nA: ${x.answer.trim()}`).join("\n\n")}`,
    ].join("\n\n"),
  });
}

/** Save the reviewed change set: persona + knowledge in one versioned update, memories into the creator's canon. */
export async function applyChanges(id: number, set: ChangeSet, qa: Array<{ topic: string; question: string; answer: string }>, by: string): Promise<string[]> {
  const inf = await getInfluencer(id);
  if (!inf) throw new PermanentError("influencer not found");
  const doc = parse(inf.persona_yaml) as Record<string, any>;
  const addUnique = (list: string[] | undefined, items: string[]) => {
    const out = [...(list ?? [])];
    for (const i of items.map((x) => x.trim()).filter(Boolean)) if (!out.some((o) => o.toLowerCase() === i.toLowerCase())) out.push(i);
    return out;
  };
  doc.interests = addUnique(doc.interests, set.interests_add);
  doc.communication_style ??= {};
  doc.communication_style.signature_phrases = addUnique(doc.communication_style.signature_phrases, set.signature_phrases_add);
  doc.communication_style.avoid_phrases = addUnique(doc.communication_style.avoid_phrases, set.avoid_phrases_add);
  doc.boundaries = addUnique(doc.boundaries, set.boundaries_add);
  doc.weekend_ideas = addUnique(doc.weekend_ideas, set.weekend_ideas_add);
  for (const l of set.location_looks) {
    const loc = (doc.visual?.locations ?? []).find((x: { id: string }) => x.id === l.id);
    if (loc && l.look.trim()) loc.look = l.look.trim();
  }
  doc.life ??= {};
  doc.life.moments = addUnique(doc.life.moments, set.moments_add);
  doc.life.arcs ??= [];
  for (const a of set.arcs_add) {
    const id = a.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "storyline";
    const beats = a.beats.map((b) => b.trim()).filter(Boolean);
    if (beats.length >= 2 && !doc.life.arcs.some((x: { id: string }) => x.id === id)) doc.life.arcs.push({ id, title: a.title.trim(), story: a.story.trim() || a.title.trim(), beats, every_days: 4 });
  }
  doc.engagement ??= {};
  const eg = doc.engagement;
  eg.questions = addUnique(eg.questions, set.questions_add);
  eg.silly_talk = addUnique(eg.silly_talk, set.silly_talk_add);
  eg.scout_hashtags = addUnique(eg.scout_hashtags, set.scout_hashtags_add.map((h) => h.replace(/^#+/, "")));
  if (set.comment_style.trim()) eg.comment_style = set.comment_style.trim();
  // Questions or takes with no format yet: start with the everyday formats.
  if ((eg.questions?.length || eg.silly_talk?.length) && !eg.formats?.length) eg.formats = ["silly_talk", "funny_question", "this_or_that"];
  if (set.football?.team.trim()) {
    eg.football = { team: set.football.team.trim(), league: set.football.league.trim(), rivals: set.football.rivals.map((r) => r.trim()).filter(Boolean) };
    eg.formats = [...new Set([...(eg.formats ?? []), "football_banter"])];
  }
  doc.life.circle ??= [];
  for (const c of set.circle_add) {
    if (c.name.trim() && !doc.life.circle.some((x: { name: string }) => x.name.toLowerCase() === c.name.trim().toLowerCase())) doc.life.circle.push({ name: c.name.trim(), who: c.who.trim() || "friend" });
  }
  const personaYaml = stringify(doc, { lineWidth: 0 });
  parsePersona(personaYaml); // never save something the engine can't read

  // Knowledge: replace entries with the same id, add new ones.
  const kb = inf.knowledge_yaml?.trim() ? parseKnowledge(inf.knowledge_yaml) : [];
  for (const k of set.knowledge) {
    const entry: KnowledgeEntry = { id: k.id.toLowerCase().replace(/[^a-z0-9-]+/g, "-"), keywords: k.keywords, content: k.content.trim(), ...(k.must_include.length ? { must_include: k.must_include } : {}) };
    const i = kb.findIndex((x) => x.id === entry.id);
    if (i >= 0) kb[i] = entry;
    else kb.push(entry);
  }
  const knowledgeYaml = kb.length ? stringify({ entries: kb }, { lineWidth: 0 }) : inf.knowledge_yaml ?? "";
  await updatePersona(id, personaYaml, knowledgeYaml, `interview:${by}`);
  invalidateInfluencer();

  let remembered = 0;
  for (const m of set.memories) {
    const v = applyMemoryPolicy({ kind: m.kind, content: m.content, confidence: 0.95, importance: 0.7, expires_on: m.expires_on });
    if (v.store) {
      await upsertMemory("identity", null, v, { type: "operator", id: by });
      remembered++;
    }
  }
  for (const x of qa.filter((q) => q.answer.trim())) {
    await one("INSERT INTO interview_answers (influencer_id, topic, question, answer, applied, answered_by) VALUES ($1,$2,$3,$4,$5,$6)", [id, x.topic, x.question, x.answer.trim(), JSON.stringify(set), by]);
  }
  await recordEvent("info", "interview", `Interview saved: ${set.summary.length} change(s), ${remembered} memory(ies)`, { by });
  return set.summary;
}

const experienceSchema = z.object({
  memories: z.array(z.object({ kind: z.enum(["self_fact", "self_plan"]), content: z.string(), expires_on: z.string().nullable() })).max(6),
  weekend_idea: z.string().nullable(),
});

/** "Add an experience": a sentence or two becomes remembered story right away (no review needed: it only adds memories). */
export async function addExperience(p: Persona, text: string, by: string): Promise<string[]> {
  if (!text.trim()) throw new PermanentError("write what happened");
  const out = await llm().structured(experienceSchema, {
    operation: "interview.experience",
    tier: "fast",
    maxTokens: 800,
    system: `Turn this note about an AI creator's life into short third-person memories using their name (${p.identity.name}). self_fact for something that happened or is true; self_plan for something upcoming (with an ISO date in expires_on if a date is given). Use only what the note says. If it suggests a good weekend post idea, give it in weekend_idea, else null. Return JSON only.`,
    prompt: `NOTE: ${text.trim().slice(0, 1500)}`,
  });
  const saved: string[] = [];
  for (const m of out.memories) {
    const v = applyMemoryPolicy({ kind: m.kind, content: m.content, confidence: 0.95, importance: 0.7, expires_on: m.expires_on });
    if (!v.store) continue;
    await upsertMemory("identity", null, v, { type: "operator", id: by });
    saved.push(m.content);
  }
  await one("INSERT INTO interview_answers (influencer_id, topic, question, answer, applied, answered_by) VALUES ($1, 'experience', 'Add an experience', $2, $3, $4)", [influencerId(), text.trim(), JSON.stringify(out), by]);
  return saved;
}
