import { setting } from "../config/settings.js";
import { sleep } from "../lib/async.js";
import { one } from "../db/pool.js";
import { recordDecision } from "../lib/decisions.js";
import { errorMessage, PermanentError, TransientError } from "../lib/errors.js";
import { recordEvent } from "../lib/events.js";
import { notify } from "../notify/telegram.js";
import { many } from "../db/pool.js";
import { TIKTOK_DISCONNECTED } from "../content/reconnect.js";
import type { TikTokSettings } from "./adapt.js";
import { primaryTikTok, saveCreatorInfo, tiktokBlocker, tiktokClientFor } from "./accounts.js";
import { TikTokTokenError, type TikTokClient, type TikTokPrivacy } from "./client.js";
import { mediaBase, tiktokMediaPath } from "./media.js";

/**
 * Publish a TikTok photo post. Duplicate protection mirrors Instagram's:
 * the publish_id is stored before waiting, so a retry asks TikTok for the
 * status of that publish instead of posting again. Until the app passes
 * TikTok's audit every post is SELF_ONLY (private); the AI label is always on.
 */

interface Row {
  id: string;
  caption: string;
  status: string;
  tiktok: TikTokSettings;
}

let pollDelays = [3_000, 5_000, 8_000, 10_000, 15_000, 20_000, 30_000];
/** Test hook. */
export function setTikTokPollDelays(d: number[]): void {
  pollDelays = d;
}

export async function publishTikTok(postId: string): Promise<"published" | "deferred" | "skipped"> {
  const post = await one<Row>("SELECT id, caption, status, tiktok FROM posts WHERE id = $1 AND platform = 'tiktok'", [postId]);
  if (!post) return "skipped";
  const t = post.tiktok ?? ({} as TikTokSettings);

  const blocked = await tiktokBlocker();
  if (blocked) {
    const held = blocked.startsWith(TIKTOK_DISCONNECTED) ? blocked : `${TIKTOK_DISCONNECTED}: ${blocked}`;
    await one("UPDATE posts SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1", [postId, held]);
    await recordEvent("warn", "tiktok", "Held: TikTok isn't connected", { postId });
    return "deferred";
  }
  const base = await mediaBase();
  if (!base) throw new PermanentError("Set the TikTok media base URL (Config & keys → TikTok) to a verified https domain that points at this service");

  const acct = (await primaryTikTok())!;
  await one("UPDATE posts SET status = 'publishing', publish_attempts = publish_attempts + 1, updated_at = now() WHERE id = $1", [postId]);
  try {
    const tk = await tiktokClientFor(acct);
    let publishId = t.publish_id ?? null;
    if (!publishId) {
      // TikTok requires the creator's current options before every post.
      const info = await tk.creatorInfo();
      await saveCreatorInfo(acct.id, info);
      const audited = (await setting("TIKTOK_APP_AUDITED")) === "yes";
      const wanted: TikTokPrivacy = t.privacy ?? "PUBLIC_TO_EVERYONE";
      const privacy: TikTokPrivacy = !audited ? "SELF_ONLY" : info.privacy_level_options?.includes(wanted) ? wanted : "SELF_ONLY";
      const note = !audited ? "posted privately: the TikTok app isn't audited yet" : privacy !== wanted ? `"${wanted}" isn't available for this account; posted privately` : undefined;
      const assets = await many<{ position: number; sha256: string | null }>("SELECT position, sha256 FROM post_assets WHERE post_id = $1 ORDER BY position", [postId]);
      if (!assets.length) throw new PermanentError("the post has no photos");
      const init = await tk.initPhotoPost({
        title: (t.title ?? "").slice(0, 90),
        description: post.caption.slice(0, 4000),
        privacy_level: privacy,
        disable_comment: Boolean(info.comment_disabled) || t.allow_comments === false,
        auto_add_music: true,
        brand_content_toggle: false,
        brand_organic_toggle: Boolean(t.promotes_own_business),
        is_aigc: true,
        photo_images: assets.map((a) => `${base}${tiktokMediaPath(postId, a.position, a.sha256)}`),
        photo_cover_index: 0,
      });
      publishId = init.publish_id;
      // Persist BEFORE waiting: this is what makes a retry safe.
      await one("UPDATE posts SET tiktok = tiktok || $2::jsonb WHERE id = $1", [postId, JSON.stringify({ publish_id: publishId, privacy_used: privacy, note: note ?? null })]);
    }
    return await waitForPublish(tk, postId, publishId, acct.username);
  } catch (e) {
    const msg = errorMessage(e).slice(0, 1000);
    if (e instanceof TikTokTokenError) {
      await one("UPDATE posts SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1", [postId, `${TIKTOK_DISCONNECTED}: ${msg}`]);
      return "deferred";
    }
    await one("UPDATE posts SET last_error = $2, updated_at = now() WHERE id = $1", [postId, msg]);
    if (e instanceof PermanentError) {
      await one("UPDATE posts SET status = 'failed' WHERE id = $1", [postId]);
      await recordEvent("error", "tiktok", "TikTok publishing failed", { postId, error: msg });
      await notify(`❌ TikTok post failed: ${msg.slice(0, 200)}`, `/admin/posts/${postId}`).catch(() => undefined);
    }
    throw e;
  }
}

async function waitForPublish(tk: TikTokClient, postId: string, publishId: string, username: string | null): Promise<"published"> {
  for (let i = 0; ; i++) {
    const s = await tk.fetchStatus(publishId);
    if (s.status === "PUBLISH_COMPLETE") {
      const id = s.publicaly_available_post_id?.[0];
      const link = id && username ? `https://www.tiktok.com/@${username}/photo/${id}` : username ? `https://www.tiktok.com/@${username}` : null;
      await one(
        `UPDATE posts SET status = 'published', published_at = now(), permalink = $2, last_error = NULL, tiktok = tiktok || $3::jsonb, updated_at = now() WHERE id = $1`,
        [postId, link, JSON.stringify({ post_id: id ? String(id) : null })],
      );
      const note = (await one<{ note: string | null }>("SELECT tiktok->>'note' AS note FROM posts WHERE id = $1", [postId]))?.note;
      await recordDecision({ agent: "publisher", subjectType: "post", subjectId: postId, action: "published_tiktok", reason: `publish ${publishId}${note ? `; ${note}` : ""}` });
      await recordEvent("info", "tiktok", note ? `TikTok post published (${note})` : "TikTok post published", { postId, permalink: link });
      await notify(`✅ TikTok: ${link ?? postId}${note ? ` (${note})` : ""}`).catch(() => undefined);
      return "published";
    }
    if (s.status === "FAILED") {
      // Clear the publish id so a retry starts a fresh publish.
      await one("UPDATE posts SET tiktok = tiktok - 'publish_id' WHERE id = $1", [postId]);
      throw new PermanentError(`TikTok couldn't publish: ${s.fail_reason ?? "unknown reason"}`);
    }
    if (i >= pollDelays.length) throw new TransientError(`TikTok is still processing (${s.status}); will check again`);
    await sleep(pollDelays[i]);
  }
}
