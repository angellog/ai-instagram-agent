import { many } from "../db/pool.js";

export interface VisualState {
  location_id?: string | null;
  time_of_day?: string;
  outfit?: string;
  sneakers?: string;
  hairstyle?: string;
  compositions?: string[];
  local_day?: string;
  activity?: string | null;
  continuity_adjustments?: string[];
}

export interface RecentItem {
  postId: string | null;
  ideaId: number;
  status: string;
  format: string;
  structure: string;
  topic: string;
  hook: string;
  caption: string;
  visual: VisualState;
  createdAt: Date;
  publishedAt: Date | null;
}

/**
 * Content history used by the repetition check, continuity check and the
 * director prompt: everything accepted recently, published or still in the
 * pipeline (a queued post counts; otherwise two near-identical drafts could
 * both pass while neither is published yet).
 */
export async function recentContent(limit = 15): Promise<RecentItem[]> {
  const rows = await many<{
    post_id: string | null;
    idea_id: number;
    status: string;
    format: string;
    structure: string;
    topic: string;
    hook: string;
    caption: string | null;
    post_caption: string | null;
    visual_state: VisualState;
    created_at: Date;
    published_at: Date | null;
  }>(
    `SELECT p.id AS post_id, ci.id AS idea_id, coalesce(p.status, ci.status) AS status, ci.format, ci.structure, ci.topic, ci.hook,
            ci.caption, p.caption AS post_caption, coalesce(p.visual_state, ci.visual_state) AS visual_state,
            ci.created_at, p.published_at
     FROM content_ideas ci
     LEFT JOIN posts p ON p.content_idea_id = ci.id
     WHERE ci.status IN ('accepted', 'produced')
       AND (p.id IS NULL OR p.status NOT IN ('rejected', 'failed', 'qc_failed'))
     ORDER BY coalesce(p.published_at, ci.created_at) DESC
     LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    postId: r.post_id,
    ideaId: r.idea_id,
    status: r.status,
    format: r.format,
    structure: r.structure,
    topic: r.topic,
    hook: r.hook,
    caption: r.post_caption ?? r.caption ?? "",
    visual: r.visual_state ?? {},
    createdAt: r.created_at,
    publishedAt: r.published_at,
  }));
}
