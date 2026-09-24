import { createHash } from "node:crypto";
import { many, one } from "../db/pool.js";
import { localParts } from "../lib/time.js";
import type { Persona, Slot } from "../persona/schema.js";
import { SLOTS } from "../persona/schema.js";

export interface ActivityRow {
  id: number;
  day: string;
  slot: Slot;
  activity: string;
  location: string | null;
  description: string | null;
  interest_score: number | null;
  decision: "planned" | "post" | "skip" | "posted";
  reason: string | null;
}

/** Seeded PRNG (mulberry32) so a day's plan is reproducible and idempotent. */
export function rng(seed: string): () => number {
  let a = createHash("sha256").update(seed).digest().readUInt32BE(0);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The virtual day (brief §6). Picks N activities across the day, weighted,
 * at least one per populated slot where possible, weekday-aware, and avoids
 * repeating yesterday's location for the same activity. Pure: same inputs,
 * same plan.
 */
export function planActivities(
  p: Persona,
  day: string,
  weekday: number,
  yesterday: Array<{ activity: string; location: string | null }> = [],
): Array<{ slot: Slot; activity: string; location: string | null; postable: boolean }> {
  const rand = rng(`${p.identity.name}:${day}`);
  const isWeekend = weekday === 0 || weekday === 6;
  const pool = p.daily_life.activities.filter((a) => !(a.weekdays_only && isWeekend));
  const n = Math.min(p.daily_life.activities_per_day, pool.length);

  const chosen: typeof pool = [];
  const pick = (cands: typeof pool) => {
    const total = cands.reduce((s, a) => s + a.weight, 0);
    let r = rand() * total;
    for (const a of cands) {
      r -= a.weight;
      if (r <= 0) return a;
    }
    return cands[cands.length - 1];
  };

  // One per slot first (keeps the day shaped like a day), then fill by weight.
  for (const slot of SLOTS) {
    if (chosen.length >= n) break;
    const cands = pool.filter((a) => a.slot === slot && !chosen.includes(a));
    if (cands.length) chosen.push(pick(cands));
  }
  while (chosen.length < n) {
    const cands = pool.filter((a) => !chosen.includes(a));
    if (!cands.length) break;
    chosen.push(pick(cands));
  }

  const yLoc = new Map(yesterday.map((y) => [y.activity, y.location]));
  return chosen
    .sort((a, b) => SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot))
    .map((a) => {
      let locs = a.locations;
      if (locs.length > 1 && yLoc.has(a.activity)) locs = locs.filter((l) => l !== yLoc.get(a.activity));
      const location = locs.length ? locs[Math.floor(rand() * locs.length)] : null;
      return { slot: a.slot, activity: a.activity, location, postable: a.postable };
    });
}

/** Ensure today's plan exists in the DB. Idempotent (unique day+slot+activity). */
export async function ensureDayPlan(p: Persona, now = new Date()): Promise<ActivityRow[]> {
  const { day, weekday } = localParts(now, p.identity.timezone);
  const existing = await many<ActivityRow>("SELECT * FROM activities WHERE day = $1 ORDER BY id", [day]);
  if (existing.length) return existing;
  const yDay = localParts(new Date(now.getTime() - 86_400_000), p.identity.timezone).day;
  const yesterday = await many<{ activity: string; location: string | null }>("SELECT activity, location FROM activities WHERE day = $1", [yDay]);
  for (const a of planActivities(p, day, weekday, yesterday)) {
    const loc = a.location ? p.visual.locations.find((l) => l.id === a.location) : undefined;
    await one(
      `INSERT INTO activities (day, slot, activity, location, description, decision, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (day, slot, activity) DO NOTHING`,
      [day, a.slot, a.activity, a.location, loc?.description ?? null, a.postable ? "planned" : "skip", a.postable ? null : "not a postable activity"],
    );
  }
  return many<ActivityRow>("SELECT * FROM activities WHERE day = $1 ORDER BY id", [day]);
}
