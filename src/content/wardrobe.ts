import { similarity } from "../lib/text.js";
import type { Persona } from "../persona/schema.js";
import { rng } from "./activities.js";
import type { RecentItem } from "./history.js";

/**
 * Wardrobe rotation. Real people don't wear the same fit every day, and the
 * image model drifts toward whatever the identity reference is wearing. So
 * the outfit is planned, not improvised: one outfit per local day (kept all
 * day for continuity, except workouts), never one worn in the last few days,
 * chosen deterministically so a re-run of the planner picks the same thing.
 */

export const SPORT_OUTFIT = /\b(gym|run|running|workout|training|jersey|sports? bra|track ?(suit|pants|shorts)|leggings|athletic|activewear|mesh shorts)\b/i;
const SPORT_ACTIVITY = /\b(gym|run|running|jog|workout|training|hike|hiking|football|basketball|yoga|pilates|swim|cycling|match)\b/i;
const SAME = 0.6;

export function wardrobe(p: Persona): string[] {
  const ch = p.visual.character;
  const all = [...ch.recurring_clothing_preferences, ...(ch.wardrobe ?? [])].map((s) => s.trim()).filter(Boolean);
  return all.filter((o, i) => all.findIndex((x) => similarity(x, o) >= 0.9) === i);
}

export function isSportActivity(activity: string | null | undefined): boolean {
  return Boolean(activity && SPORT_ACTIVITY.test(activity));
}

/** How many previous days an outfit stays "recently worn". Small wardrobes rotate faster. */
export function cooldownDays(size: number): number {
  return Math.max(1, Math.min(6, size - 2));
}

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

export interface OutfitPlan {
  /** Today's everyday outfit (already fixed if something was posted today). */
  everyday: string;
  /** Outfit for a workout/sport post today. */
  sport: string;
  /** Outfits that must not be repeated today. */
  avoid: Worn[];
  reason: string;
}

export function planOutfits(p: Persona, day: string, recent: RecentItem[]): OutfitPlan {
  const all = wardrobe(p);
  const window = cooldownDays(all.length);
  const avoid = wornRecently(recent, day, window);
  const blocked = (o: string) => avoid.some((w) => similarity(w.outfit, o) >= SAME);
  const rand = rng(`${p.identity.name}:${day}:outfit`);
  const pick = (pool: string[]): string | undefined => (pool.length ? pool[Math.floor(rand() * pool.length)] : undefined);
  const leastRecent = (pool: string[]) =>
    [...pool].sort((a, b) => {
      const la = avoid.filter((w) => similarity(w.outfit, a) >= SAME).map((w) => w.day).sort().at(-1) ?? "0000";
      const lb = avoid.filter((w) => similarity(w.outfit, b) >= SAME).map((w) => w.day).sort().at(-1) ?? "0000";
      return la.localeCompare(lb);
    })[0];

  const everydayPool = all.filter((o) => !SPORT_OUTFIT.test(o));
  const sportPool = all.filter((o) => SPORT_OUTFIT.test(o));

  const today = recent.find((r) => r.visual.local_day === day && r.visual.outfit && !SPORT_OUTFIT.test(r.visual.outfit));
  const everyday = today?.visual.outfit ?? pick(everydayPool.filter((o) => !blocked(o))) ?? leastRecent(everydayPool.length ? everydayPool : all) ?? all[0];
  const sport = pick(sportPool.filter((o) => !blocked(o))) ?? leastRecent(sportPool) ?? everyday;
  return {
    everyday,
    sport,
    avoid,
    reason: today ? "kept from today's earlier post" : `rotation over ${all.length} outfits, ${window}-day cooldown`,
  };
}

/**
 * Apply the plan to the director's choice. The director may pick any
 * wardrobe-appropriate outfit, but never one worn in the cooldown window and
 * never street clothes for a workout (or gym kit for brunch).
 */
export function enforceOutfit(proposed: string | undefined, activity: string | null | undefined, plan: OutfitPlan): { outfit: string; adjustment?: string } {
  const sport = isSportActivity(activity);
  const target = sport ? plan.sport : plan.everyday;
  if (!proposed) return { outfit: target, adjustment: "outfit set from the wardrobe plan" };
  const repeat = plan.avoid.find((w) => similarity(w.outfit, proposed) >= SAME);
  if (repeat) return { outfit: target, adjustment: `outfit rotated: "${proposed}" was worn on ${repeat.day}` };
  if (sport !== SPORT_OUTFIT.test(proposed)) return { outfit: target, adjustment: sport ? "workout needs activewear" : "activewear swapped for an everyday outfit" };
  return { outfit: proposed };
}
