import type { Slot } from "../persona/schema.js";

/** Wall-clock parts in a given IANA timezone. */
export function localParts(date: Date, timeZone: string): { day: string; hour: number; weekday: number } {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const parts = Object.fromEntries(f.formatToParts(date).map((p) => [p.type, p.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), weekday };
}

export const SLOT_HOURS: Record<Slot, [number, number]> = {
  morning: [5, 10],
  late_morning: [10, 12],
  lunch: [12, 14],
  afternoon: [14, 17],
  evening: [17, 21],
  night: [21, 24],
};

export function slotForHour(hour: number): Slot {
  for (const [slot, [a, b]] of Object.entries(SLOT_HOURS) as Array<[Slot, [number, number]]>) {
    if (hour >= a && hour < b) return slot;
  }
  return "night";
}

export const TIMES_OF_DAY = ["sunrise", "morning", "midday", "afternoon", "golden_hour", "dusk", "night"] as const;
export type TimeOfDay = (typeof TIMES_OF_DAY)[number];

export const SLOT_TIME_OF_DAY: Record<Slot, TimeOfDay[]> = {
  morning: ["sunrise", "morning"],
  late_morning: ["morning", "midday"],
  lunch: ["midday"],
  afternoon: ["afternoon", "golden_hour"],
  evening: ["golden_hour", "dusk", "night"],
  night: ["night"],
};
