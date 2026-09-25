import { influencerId } from "../context.js";
import { many, one } from "../db/pool.js";
import { recordEvent } from "../lib/events.js";
import { applyMemoryPolicy } from "../memory/policy.js";
import { upsertMemory } from "../memory/store.js";
import type { CalendarEvent } from "./events.js";

/**
 * `calendar.recap` (hourly, per influencer): once an event has ended and the
 * operator has written what happened, it becomes a world memory — so weeks
 * later the influencer still "remembers" the concert, the launch, the match.
 * Idempotent: the memory key is the event id and recapped_at is stamped.
 */
export async function recapCalendar(now = new Date()): Promise<{ recapped: number }> {
  const inf = influencerId();
  const due = await many<CalendarEvent>(
    `SELECT * FROM calendar_events e
     WHERE (e.influencer_id IS NULL OR e.influencer_id = $1)
       AND e.outcome IS NOT NULL AND length(trim(e.outcome)) > 0
       AND coalesce(e.ends_at, e.starts_at) <= $2
       AND (e.recapped_at IS NULL OR e.recapped_at < e.updated_at
            OR NOT EXISTS (SELECT 1 FROM memories m WHERE m.influencer_id = $1 AND m.source_type = 'calendar' AND m.source_id = e.id::text AND m.status = 'active'))
     ORDER BY e.starts_at LIMIT 50`,
    [inf, now],
  );
  let recapped = 0;
  for (const e of due) {
    const day = new Date(e.starts_at).toISOString().slice(0, 10);
    const v = applyMemoryPolicy({
      kind: "calendar_recap",
      content: `${e.title} (${day}${e.location ? `, ${e.location}` : ""}): ${e.outcome}`.slice(0, 480),
      confidence: 0.95, // operator-entered
      importance: e.importance === 3 ? 0.9 : e.importance === 2 ? 0.7 : 0.5,
    });
    if (!v.store) {
      await recordEvent("warn", "calendar", `Recap of "${e.title}" refused by memory policy`, { eventId: e.id, reason: v.reason });
      continue;
    }
    await upsertMemory("world", null, { ...v, key: `calendar:${e.id}` }, { type: "calendar", id: String(e.id) });
    // Only the owner stamps a private event; shared events are stamped once any influencer recaps them
    // (each influencer still gets its own memory thanks to the NOT EXISTS clause above).
    await one("UPDATE calendar_events SET recapped_at = now() WHERE id = $1", [e.id]);
    recapped++;
  }
  return { recapped };
}
