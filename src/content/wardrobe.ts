import { similarity } from "../lib/text.js";
import type { Persona } from "../persona/schema.js";
import { rng } from "./activities.js";
import type { RecentItem } from "./history.js";

/**
 * Wardrobe rotation, the way real people dress: a closet of separates that
 * get remixed. Any top with any bottom (sometimes a layer) is a new outfit
 * made from pieces they already own, so a modest closet yields dozens of
 * looks and the same pieces reappear in new combinations, never the same
 * full outfit twice in a row. Occasion wear (church, Jumu'ah, Eid, weddings)
 * comes out on its day or when the activity or calendar calls for it.
 * One outfit per local day for continuity (workouts and occasions excepted),
 * chosen deterministically so re-running the planner picks the same thing.
 */

export const SPORT_OUTFIT = /\b(gym|run|running|workout|training|jersey|sports? bra|track ?(suit|pants|shorts|jacket)|leggings|athletic|activewear|mesh shorts|bike shorts)\b/i;
const SPORT_ACTIVITY = /\b(gym|run|running|jog|workout|training|hike|hiking|football|basketball|yoga|pilates|swim|cycling|match)\b/i;
const SAME = 0.6;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

export interface Outfit {
  text: string;
  kind: "outfit" | "remix" | "one_piece" | "activewear";
  pieces: string[];
  layered?: boolean;
}

/** How often each kind of everyday look comes up (layered combos would otherwise swamp the pick). */
const MIX: Array<[(o: Outfit) => boolean, number]> = [
  [(o) => o.kind === "remix" && !o.layered, 3],
  [(o) => o.kind === "remix" && Boolean(o.layered), 1.2],
  [(o) => o.kind === "one_piece", 1],
  [(o) => o.kind === "outfit", 1],
];

/** Every outfit this influencer can wear: fixed outfits plus every top×bottom(×layer) remix and one-piece. */
export function outfits(p: Persona): Outfit[] {
  const ch = p.visual.character;
  const c = ch.closet;
  const out: Outfit[] = [];
  for (const o of [...ch.recurring_clothing_preferences, ...(ch.wardrobe ?? [])]) {
    out.push({ text: o.trim(), kind: SPORT_OUTFIT.test(o) ? "activewear" : "outfit", pieces: [o.trim()] });
  }
  for (const t of c.tops) {
    for (const b of c.bottoms) {
      out.push({ text: `${t} with ${b}`, kind: "remix", pieces: [t, b] });
      for (const l of c.layers) out.push({ text: `${l} over ${t}, with ${b}`, kind: "remix", pieces: [l, t, b], layered: true });
    }
  }
  for (const d of c.one_pieces) {
    out.push({ text: d, kind: "one_piece", pieces: [d] });
    for (const l of c.layers) out.push({ text: `${d} with ${l}`, kind: "one_piece", pieces: [d, l] });
  }
  for (const a of c.activewear) out.push({ text: a, kind: "activewear", pieces: [a] });
  const seen = new Set<string>();
  return out.filter((o) => (seen.has(o.text.toLowerCase()) ? false : (seen.add(o.text.toLowerCase()), true)));
}

/** Backwards-compatible list of outfit strings. */
export function wardrobe(p: Persona): string[] {
  return outfits(p).map((o) => o.text);
}

export function isSportActivity(activity: string | null | undefined): boolean {
  return Boolean(activity && SPORT_ACTIVITY.test(activity));
}

/** Days an exact outfit stays "recently worn". Bigger closets rotate slower, up to three weeks. */
export function cooldownDays(size: number): number {
  return Math.max(1, Math.min(21, size - 2));
}
/** Days a single piece rests before it can come back in a new combination. */
export const PIECE_REST_DAYS = 2;

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

export interface Worn {
  outfit: string;
  day: string;
}

export function wornRecently(recent: RecentItem[], day: string, window: number): Worn[] {
  return recent
    .filter((r) => r.visual.outfit && r.visual.local_day && r.visual.local_day < day && daysBetween(day, r.visual.local_day) <= window)
    .map((r) => ({ outfit: r.visual.outfit!, day: r.visual.local_day! }));
}

export interface OccasionPlan {
  occasion: string;
  outfit: string;
  keywords: string[];
}

export interface OutfitPlan {
  /** Today's everyday outfit (already fixed if something was posted today). */
  everyday: string;
  /** Outfit for a workout/sport post today. */
  sport: string;
  /** Occasion wear available today (church on Sunday, Jumu'ah on Friday…), matched by activity/topic. */
  occasions: OccasionPlan[];
  /** Outfits that must not be repeated today. */
  avoid: Worn[];
  /** When today's everyday outfit reuses pieces worn before in another combination. */
  remix?: { piece: string; lastWith: string; day: string };
  reason: string;
}

const occasionWords = (o: { occasion: string; keywords: string[] }) =>
  [o.occasion, ...o.keywords].map((k) => k.toLowerCase().trim()).filter((k) => k.length > 2);

export function planOutfits(p: Persona, day: string, recent: RecentItem[], o: { events?: string[] } = {}): OutfitPlan {
  const all = outfits(p);
  const window = cooldownDays(all.length);
  const avoid = wornRecently(recent, day, window);
  const restingPieces = new Set(
    wornRecently(recent, day, PIECE_REST_DAYS).flatMap((w) => all.find((x) => x.text === w.outfit)?.pieces ?? [w.outfit]),
  );
  const blocked = (x: Outfit) => avoid.some((w) => similarity(w.outfit, x.text) >= SAME) || x.pieces.some((pc) => restingPieces.has(pc));
  const rand = rng(`${p.identity.name}:${day}:outfit`);
  const pick = (pool: Outfit[]): Outfit | undefined => (pool.length ? pool[Math.floor(rand() * pool.length)] : undefined);
  /** Weighted by kind first (see MIX), then uniform within the kind. */
  const pickMixed = (pool: Outfit[]): Outfit | undefined => {
    const groups = MIX.map(([is, w]) => [pool.filter(is), w] as const).filter(([g]) => g.length);
    if (!groups.length) return pick(pool);
    const total = groups.reduce((s, [, w]) => s + w, 0);
    let r = rand() * total;
    for (const [g, w] of groups) {
      r -= w;
      if (r <= 0) return pick(g);
    }
    return pick(groups[groups.length - 1][0]);
  };
  const lastWorn = (x: Outfit) => avoid.filter((w) => similarity(w.outfit, x.text) >= SAME).map((w) => w.day).sort().at(-1) ?? "0000";
  const leastRecent = (pool: Outfit[]) => [...pool].sort((a, b) => lastWorn(a).localeCompare(lastWorn(b)))[0];

  const everydayPool = all.filter((x) => x.kind !== "activewear");
  const sportPool = all.filter((x) => x.kind === "activewear");

  const today = recent.find((r) => r.visual.local_day === day && r.visual.outfit && !SPORT_OUTFIT.test(r.visual.outfit));
  const chosen = today ? undefined : (pickMixed(everydayPool.filter((x) => !blocked(x))) ?? leastRecent(everydayPool.length ? everydayPool : all));
  const everyday = today?.visual.outfit ?? chosen?.text ?? all[0]?.text ?? p.visual.character.recurring_clothing_preferences[0];
  const sport = (pick(sportPool.filter((x) => !blocked(x))) ?? leastRecent(sportPool))?.text ?? everyday;

  // Remix storytelling: a piece of today's outfit last seen in a different combination.
  let remix: OutfitPlan["remix"];
  if (chosen?.kind === "remix") {
    for (const r of recent) {
      if (!r.visual.outfit || !r.visual.local_day || r.visual.local_day >= day) continue;
      const piece = chosen.pieces.find((pc) => r.visual.outfit!.includes(pc) && r.visual.outfit !== chosen.text);
      if (piece) {
        remix = { piece, lastWith: r.visual.outfit, day: r.visual.local_day };
        break;
      }
    }
  }

  const weekday = WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()];
  const eventText = (o.events ?? []).join(" ").toLowerCase();
  const occasions = p.visual.character.closet.occasions
    .filter((oc) => oc.days.includes(weekday) || occasionWords(oc).some((k) => eventText.includes(k)))
    .map((oc) => ({ occasion: oc.occasion, outfit: oc.outfit, keywords: occasionWords(oc) }));

  return {
    everyday,
    sport,
    occasions,
    avoid,
    remix,
    reason: today ? "kept from today's earlier post" : `rotation over ${all.length} outfits from the closet, ${window}-day cooldown`,
  };
}

/**
 * Apply the plan to the director's choice. Occasion posts wear the occasion
 * outfit; otherwise the director may pick any wardrobe-appropriate outfit, but
 * never one worn in the cooldown window, and never street clothes for a
 * workout (or gym kit for brunch).
 */
export function enforceOutfit(
  proposed: string | undefined,
  activity: string | null | undefined,
  plan: OutfitPlan,
  context = "",
): { outfit: string; adjustment?: string } {
  const about = `${activity ?? ""} ${context}`.toLowerCase();
  const occasion = plan.occasions.find((oc) => oc.keywords.some((k) => about.includes(k)));
  if (occasion) {
    return similarity(proposed ?? "", occasion.outfit) >= SAME ? { outfit: proposed! } : { outfit: occasion.outfit, adjustment: `${occasion.occasion} outfit` };
  }
  const sport = isSportActivity(activity);
  const target = sport ? plan.sport : plan.everyday;
  if (!proposed) return { outfit: target, adjustment: "outfit set from the wardrobe plan" };
  const repeat = plan.avoid.find((w) => similarity(w.outfit, proposed) >= SAME);
  if (repeat) return { outfit: target, adjustment: `outfit rotated: "${proposed}" was worn on ${repeat.day}` };
  if (sport !== SPORT_OUTFIT.test(proposed)) return { outfit: target, adjustment: sport ? "workout needs activewear" : "activewear swapped for an everyday outfit" };
  return { outfit: proposed };
}
