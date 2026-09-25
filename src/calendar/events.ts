import { z } from "zod";
import { influencerId } from "../context.js";
import { many, one } from "../db/pool.js";
import { PermanentError } from "../lib/errors.js";

/**
 * Operator calendar: current affairs, holidays, launches and personal events
 * that give each influencer a sense of "now". Events with influencer_id NULL
 * are world events every influencer knows about; the rest are private to one.
 *
 * Upcoming events feed the content director (something to post about) and the
 * conversation agent (something to talk about); happened events with an
 * outcome are recapped into world memory so they are remembered afterwards.
 */

export const EVENT_KINDS = ["world", "personal", "business", "holiday", "launch", "sport", "culture"] as const;
export const USE_FOR = ["content", "conversation", "both", "context"] as const;

export interface CalendarEvent {
  id: number;
  influencer_id: number | null;
  title: string;
  description: string | null;
  kind: (typeof EVENT_KINDS)[number];
  starts_at: Date;
  ends_at: Date | null;
  all_day: boolean;
  location: string | null;
  importance: 1 | 2 | 3;
  use_for: (typeof USE_FOR)[number];
  outcome: string | null;
  recapped_at: Date | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

const date = z.union([z.string(), z.date()]).transform((v, ctx) => {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) {
    ctx.addIssue({ code: "custom", message: "invalid date" });
    return z.NEVER;
  }
  return d;
});

export const EventInput = z
  .object({
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().max(2000).nullish(),
    kind: z.enum(EVENT_KINDS).default("world"),
    starts_at: date,
    ends_at: date.nullish(),
    all_day: z.boolean().default(true),
    location: z.string().trim().max(160).nullish(),
    importance: z.coerce.number().int().min(1).max(3).default(2),
    use_for: z.enum(USE_FOR).default("both"),
    outcome: z.string().trim().max(2000).nullish(),
    /** true = every influencer (world event); false = only the current influencer. */
    shared: z.boolean().default(false),
  })
  .refine((e) => !e.ends_at || e.ends_at >= e.starts_at, { message: "ends_at must be after starts_at", path: ["ends_at"] });
export type EventInput = z.input<typeof EventInput>;

const COLS = "title, description, kind, starts_at, ends_at, all_day, location, importance, use_for, outcome";

export async function createEvent(input: EventInput, by = "operator"): Promise<CalendarEvent> {
  const e = EventInput.parse(input);
  const r = await one<CalendarEvent>(
    `INSERT INTO calendar_events (influencer_id, ${COLS}, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [e.shared ? null : influencerId(), e.title, e.description ?? null, e.kind, e.starts_at, e.ends_at ?? null, e.all_day, e.location ?? null, e.importance, e.use_for, e.outcome ?? null, by],
  );
  return r!;
}

/** An influencer may edit its own events and shared world events, never another influencer's. */
async function owned(id: number): Promise<CalendarEvent> {
  const r = await one<CalendarEvent>("SELECT * FROM calendar_events WHERE id = $1 AND (influencer_id IS NULL OR influencer_id = $2)", [id, influencerId()]);
  if (!r) throw new PermanentError(`calendar event ${id} not found`);
  return r;
}

export async function updateEvent(id: number, patch: Partial<EventInput>): Promise<CalendarEvent> {
  const cur = await owned(id);
  const merged = EventInput.parse({
    title: cur.title,
    description: cur.description,
    kind: cur.kind,
    starts_at: cur.starts_at,
    ends_at: cur.ends_at,
    all_day: cur.all_day,
    location: cur.location,
    importance: cur.importance,
    use_for: cur.use_for,
    outcome: cur.outcome,
    shared: cur.influencer_id === null,
    ...patch,
  });
  // A changed outcome must be recapped again.
  const outcomeChanged = (merged.outcome ?? null) !== cur.outcome;
  const r = await one<CalendarEvent>(
    `UPDATE calendar_events SET influencer_id = $2, title = $3, description = $4, kind = $5, starts_at = $6, ends_at = $7, all_day = $8,
       location = $9, importance = $10, use_for = $11, outcome = $12,
       recapped_at = CASE WHEN $13 THEN NULL ELSE recapped_at END, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, merged.shared ? null : influencerId(), merged.title, merged.description ?? null, merged.kind, merged.starts_at, merged.ends_at ?? null, merged.all_day, merged.location ?? null, merged.importance, merged.use_for, merged.outcome ?? null, outcomeChanged],
  );
  return r!;
}

export async function deleteEvent(id: number): Promise<void> {
  await owned(id);
  await one("DELETE FROM calendar_events WHERE id = $1", [id]);
}

/** Events visible to the current influencer overlapping [from, to). */
export async function listEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
  return many<CalendarEvent>(
    `SELECT * FROM calendar_events
     WHERE (influencer_id IS NULL OR influencer_id = $3)
       AND starts_at < $2 AND coalesce(ends_at, starts_at) >= $1
     ORDER BY starts_at, id`,
    [from, to, influencerId()],
  );
}

const DAY = 86_400_000;

function when(e: CalendarEvent, now: Date): string {
  const start = new Date(e.starts_at).getTime();
  const end = e.ends_at ? new Date(e.ends_at).getTime() : start + (e.all_day ? DAY : 0);
  if (start <= now.getTime() && now.getTime() < end) return "happening now";
  const days = Math.round((start - now.getTime()) / DAY);
  if (days === 0) return start > now.getTime() ? "later today" : "earlier today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

function line(e: CalendarEvent, now: Date): string {
  const bits = [`${e.title} (${when(e, now)}${e.location ? `, ${e.location}` : ""})`];
  if (e.description) bits.push(e.description.slice(0, 240));
  if (e.outcome) bits.push(`What happened: ${e.outcome.slice(0, 240)}`);
  return `- [${e.kind}${e.importance === 3 ? ", major" : ""}] ${bits.join(" — ")}`;
}

/**
 * Compact "what's going on" block. Upcoming within `aheadDays`, and recent
 * past within `backDays`; most important first, bounded so it never floods a
 * prompt. Empty string when there is nothing.
 */
export async function calendarBrief(purpose: "content" | "conversation", now = new Date(), aheadDays = 10, backDays = 4, limit = 8): Promise<string> {
  const rows = await listEvents(new Date(now.getTime() - backDays * DAY), new Date(now.getTime() + aheadDays * DAY));
  const relevant = rows
    .filter((e) => e.use_for === "both" || e.use_for === purpose || e.use_for === "context")
    .sort((a, b) => b.importance - a.importance || Math.abs(new Date(a.starts_at).getTime() - now.getTime()) - Math.abs(new Date(b.starts_at).getTime() - now.getTime()))
    .slice(0, limit)
    .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
  if (!relevant.length) return "";
  return relevant.map((e) => line(e, now)).join("\n");
}
