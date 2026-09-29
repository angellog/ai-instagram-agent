import { withInfluencerLoose } from "../context.js";
import { many, one } from "../db/pool.js";
import { recordDecision } from "../lib/decisions.js";
import { recordEvent } from "../lib/events.js";
import { openReview } from "../safety/safety.js";

/** Prefix on a post's last_error when it was held back because Instagram was disconnected. */
export const DISCONNECTED = "Instagram disconnected";

/**
 * After a reconnect: posts and stories that stopped only because the token was
 * dead go back to Reviews, so the operator decides whether they still fit
 * (a "morning coffee" story from yesterday may not). Nothing is published
 * automatically. Only the last 7 days, never anything already on Instagram.
 */
export async function resumeAfterReconnect(influencerId: number): Promise<number> {
  return withInfluencerLoose(influencerId, async () => {
    const held = await many<{ id: string; caption: string; safety_level: "green" | "yellow" | "red" | null; media_type: string }>(
      `UPDATE posts SET status = 'awaiting_review', last_error = NULL, publish_override = NULL, scheduled_for = NULL, updated_at = now()
       WHERE influencer_id = $1 AND status = 'failed' AND ig_media_id IS NULL
         AND (last_error LIKE $2 OR last_error LIKE '%code=190 %') -- also posts that failed on a dead token before this was tracked
         AND created_at > now() - interval '7 days' AND coalesce(safety_level, 'green') <> 'red'
       RETURNING id, caption, safety_level, media_type`,
      [influencerId, `${DISCONNECTED}%`],
    );
    for (const p of held) {
      const slides = (await many<{ public_url: string }>("SELECT public_url FROM post_assets WHERE post_id = $1 ORDER BY position", [p.id])).map((a) => a.public_url);
      const pending = await one("SELECT 1 FROM safety_reviews WHERE subject_type = 'post' AND subject_id = $1 AND status = 'pending'", [p.id]);
      if (!pending) {
        await openReview({
          subjectType: "post",
          subjectId: p.id,
          assessment: { level: p.safety_level ?? "green", categories: ["held_while_disconnected"], reason: "Held while Instagram was disconnected; check it still fits before publishing." },
          proposed: { caption: p.caption, slides },
        });
      }
      await recordDecision({ agent: "system", subjectType: "post", subjectId: p.id, action: "back_to_review", reason: "Instagram reconnected" });
    }
    if (held.length) await recordEvent("info", "instagram", `Instagram reconnected: ${held.length} held post(s) back in Reviews`, { posts: held.map((p) => p.id) });
    return held.length;
  });
}
