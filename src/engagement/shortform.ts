import { rng } from "../content/activities.js";
import type { Persona, ShortFormat } from "../persona/schema.js";

/**
 * Short-form content built to get replies (v1.0.29): silly talk, funny
 * questions, football banter, this-or-that and hot takes, from the persona's
 * own `engagement` material. Playful only, enforced in the prompt and by the
 * usual safety check: never romantic or sexual, never about anyone's looks,
 * no betting, rivalry about clubs and never about people.
 */

export const FORMAT_GUIDE: Record<ShortFormat, string> = {
  silly_talk: "silly talk: one short, self-aware silly take about your own life, said like you're telling a friend",
  funny_question: "funny question: a short question your followers can't resist answering in the comments",
  football_banter: "football banter: friendly club rivalry (your club vs a rival, a result, a matchday mood); tease clubs, never people",
  this_or_that: "this or that: two options from your world, people pick one in the comments",
  hot_take: "hot take: a light, harmless opinion people will argue with (never politics, religion or people's looks)",
};

export const PLAYFUL_ONLY =
  "Playful only: never romantic or sexual, never flirt with anyone, never comment on anyone's body or looks, no betting, no politics or religion; football rivalry is about clubs, never about people.";

/** The same few lines all day (seeded), skipping ones that appear in recent captions. */
export function pickLines(lines: string[], recent: string[], seed: string, n: number): string[] {
  const used = recent.join(" \n ").toLowerCase();
  const fresh = lines.filter((l) => !used.includes(l.toLowerCase().slice(0, 30)));
  const pool = fresh.length >= n ? fresh : lines;
  const rand = rng(seed);
  return pool
    .map((l) => ({ l, r: rand() }))
    .sort((a, b) => a.r - b.r)
    .slice(0, n)
    .map((x) => x.l);
}

/** True when the trends brief has football news for this influencer's club or league (a matchday nudge). */
export function footballNews(p: Persona, trends: string): boolean {
  const f = p.engagement.football;
  if (!f) return false;
  const words = [f.team, f.league, ...f.rivals].filter(Boolean).map((w) => w.toLowerCase());
  const t = trends.toLowerCase();
  return words.some((w) => w.length > 3 && t.includes(w));
}

/** The prompt block for a reel or story: which formats, ready lines, the club. */
export function shortFormBlock(p: Persona, o: { day: string; recent: string[]; trends?: string; kind: "reel" | "story" }): string {
  const e = p.engagement;
  if (!e.formats.length) return "";
  const questions = pickLines(e.questions, o.recent, `${p.identity.name}:${o.day}:q:${o.kind}`, 3);
  const silly = pickLines(e.silly_talk, o.recent, `${p.identity.name}:${o.day}:s:${o.kind}`, 2);
  const club = e.football && e.formats.includes("football_banter") ? `Your club: ${e.football.team}${e.football.league ? ` (${e.football.league})` : ""}; rivals: ${e.football.rivals.join(", ") || "none named"}.` : "";
  const matchday = o.trends && footballNews(p, o.trends) ? " There's football news this week: a good moment for banter (use only what the headline says, never invent scores)." : "";
  return [
    `SHORT-FORM THAT GETS REPLIES (${o.kind === "reel" ? 'kind "talk"' : 'kind "question" or "banter"'}; use your own words, these are starting points):`,
    `Formats you do: ${e.formats.map((f) => FORMAT_GUIDE[f]).join("; ")}.`,
    questions.length ? `Questions you could ask today:\n${questions.map((q) => `- ${q}`).join("\n")}` : "",
    silly.length ? `Silly takes you could use:\n${silly.map((s) => `- ${s}`).join("\n")}` : "",
    club ? `${club}${matchday}` : "",
    PLAYFUL_ONLY,
  ]
    .filter(Boolean)
    .join("\n");
}
