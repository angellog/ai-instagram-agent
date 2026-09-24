import { SLOT_TIME_OF_DAY, TIMES_OF_DAY, type TimeOfDay } from "../lib/time.js";
import type { Slot } from "../persona/schema.js";
import type { RecentItem, VisualState } from "./history.js";

const SPORT = /\b(gym|run|running|workout|training|jersey|sports? bra|track)\b/i;

/**
 * Keep consecutive posts from contradicting each other (brief §8): the same
 * day keeps the same outfit unless a workout is involved, time of day never
 * runs backwards within a day, and the lighting matches when the post goes
 * out. Returns the corrected state plus what was changed, for the audit trail.
 */
export function enforceContinuity(
  next: VisualState,
  o: { localDay: string; slot: Slot; activity?: string | null; hairstyle: string },
  recent: RecentItem[],
): { state: VisualState; adjustments: string[] } {
  const state: VisualState = { ...next, local_day: o.localDay, activity: o.activity ?? next.activity ?? null, hairstyle: o.hairstyle };
  const adjustments: string[] = [];

  // Hairstyle is identity, not a creative choice.
  if (next.hairstyle && next.hairstyle !== o.hairstyle) adjustments.push("hairstyle reset to persona default");

  const allowed = SLOT_TIME_OF_DAY[o.slot];
  if (!state.time_of_day || !allowed.includes(state.time_of_day as TimeOfDay)) {
    adjustments.push(`time_of_day ${state.time_of_day ?? "(none)"} → ${allowed[0]} to match the ${o.slot} slot`);
    state.time_of_day = allowed[0];
  }

  const sameDay = recent.filter((r) => r.visual.local_day === o.localDay);
  const prev = sameDay[0];
  if (prev) {
    const prevT = TIMES_OF_DAY.indexOf(prev.visual.time_of_day as TimeOfDay);
    const nextT = TIMES_OF_DAY.indexOf(state.time_of_day as TimeOfDay);
    if (prevT > nextT) {
      adjustments.push(`time_of_day ${state.time_of_day} is earlier than today's previous post (${prev.visual.time_of_day})`);
      state.time_of_day = prev.visual.time_of_day;
    }
    const sportNow = SPORT.test(`${o.activity ?? ""} ${state.outfit ?? ""}`);
    const sportBefore = SPORT.test(`${prev.visual.activity ?? ""} ${prev.visual.outfit ?? ""}`);
    if (prev.visual.outfit && state.outfit && prev.visual.outfit !== state.outfit && !sportNow && !sportBefore) {
      adjustments.push("outfit kept from earlier today for continuity");
      state.outfit = prev.visual.outfit;
    }
  }
  state.continuity_adjustments = adjustments;
  return { state, adjustments };
}
