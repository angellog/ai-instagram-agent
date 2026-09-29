import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { env } from "../../config/env.js";
import { setting } from "../../config/settings.js";
import { influencerId, withInfluencerLoose } from "../../context.js";
import { EDITABLE } from "../../content/edit.js";
import { one } from "../../db/pool.js";
import { errorMessage } from "../../lib/errors.js";
import { recordDecision } from "../../lib/decisions.js";
import { adaptToTikTok, type TikTokSettings } from "../../tiktok/adapt.js";
import { primaryTikTok, saveCreatorInfo, tiktokApp, tiktokClientFor, tiktokFetch, tiktokHost, upsertTikTok } from "../../tiktok/accounts.js";
import { TikTokClient } from "../../tiktok/client.js";
import { attempt, consoleRouter, done, reviewer, selectCookie, type Req } from "../console.js";

/** Login state: which influencer is connecting, signed so it can't be forged, valid 15 minutes. */
const secret = () => env().ENCRYPTION_KEY || env().ADMIN_TOKEN || "dev-tiktok-state";
export function signState(influencer: number, now = Date.now()): string {
  const body = `${influencer}.${now}.${randomBytes(6).toString("hex")}`;
  return `${body}.${createHmac("sha256", secret()).update(body).digest("hex").slice(0, 32)}`;
}
export function readState(state: string, now = Date.now()): number | undefined {
  const parts = state.split(".");
  if (parts.length !== 4) return undefined;
  const body = parts.slice(0, 3).join(".");
  const want = createHmac("sha256", secret()).update(body).digest("hex").slice(0, 32);
  if (want.length !== parts[3].length || !timingSafeEqual(Buffer.from(want), Buffer.from(parts[3]))) return undefined;
  if (now - Number(parts[1]) > 15 * 60_000) return undefined;
  return Number(parts[0]);
}
const redirectUri = () => `${env().PUBLIC_BASE_URL.replace(/\/$/, "")}/admin/tiktok/callback`;

export function registerTikTok(app: FastifyInstance): void {
  const r = consoleRouter(app);

  r.get("/admin/tiktok/connect", async (req: Req, reply) => {
    const keys = await tiktokApp();
    if (!keys) return done(req, reply, "/admin/persona#tiktok", "Add the TikTok client key and secret in Config & keys → TikTok first", false);
    return reply.redirect(TikTokClient.authorizeUrl({ clientKey: keys.clientKey, redirectUri: redirectUri(), state: signState(influencerId()) }), 303);
  });

  // TikTok sends the browser back here; the influencer comes from the signed state, not the sidebar.
  app.get("/admin/tiktok/callback", async (req: Req, reply) => {
    const q = (req.query ?? {}) as Record<string, string>;
    const back = (msg: string, ok: boolean) => reply.redirect(`/admin/persona?flash=${encodeURIComponent(msg)}${ok ? "" : "&tone=bad"}#tiktok`, 303);
    const id = readState(String(q.state ?? ""));
    if (!id) return back("TikTok login expired or wasn't started here: try Log in with TikTok again", false);
    reply.header("set-cookie", selectCookie(id));
    if (q.error) return back(`TikTok login cancelled: ${q.error_description || q.error}`, false);
    const keys = await tiktokApp();
    if (!keys || !q.code) return back("TikTok didn't return a login code", false);
    try {
      const username = await withInfluencerLoose(id, async () => {
        const tokens = await TikTokClient.exchangeCode({ ...keys, code: q.code, redirectUri: redirectUri() }, tiktokFetch(), tiktokHost());
        const client = new TikTokClient(tokens.access_token, tiktokFetch() ?? fetch, tiktokHost());
        const { user } = await client.userInfo();
        const acct = await upsertTikTok(id, tokens, user);
        await client
          .creatorInfo()
          .then((info) => saveCreatorInfo(acct.id, info))
          .catch(() => undefined);
        return user.username ?? user.display_name ?? "your account";
      });
      return back(`TikTok connected: @${username}`, true);
    } catch (e) {
      return back(`TikTok login failed: ${errorMessage(e)}`, false);
    }
  });

  r.post("/admin/tiktok/check", async (req: Req, reply) =>
    attempt(req, reply, "/admin/persona#tiktok", async () => {
      const acct = await primaryTikTok();
      if (!acct) throw new Error("No TikTok account connected");
      const tk = await tiktokClientFor(acct);
      const [info, { user }] = await Promise.all([tk.creatorInfo(), tk.userInfo()]);
      await saveCreatorInfo(acct.id, info);
      await one("UPDATE tiktok_accounts SET stats = $2, updated_at = now() WHERE id = $1", [
        acct.id,
        JSON.stringify({ followers: user.follower_count ?? null, following: user.following_count ?? null, likes: user.likes_count ?? null, videos: user.video_count ?? null }),
      ]);
      const audited = (await setting("TIKTOK_APP_AUDITED")) === "yes";
      return `@${info.creator_username ?? acct.username}: connected · privacy options ${info.privacy_level_options.join(", ")}${audited ? "" : " · posts stay private until the app is audited"}`;
    }),
  );

  r.post("/admin/tiktok/disconnect", async (req: Req, reply) =>
    attempt(req, reply, "/admin/persona#tiktok", async () => {
      const acct = await primaryTikTok();
      if (!acct) return "No TikTok account connected";
      await one("DELETE FROM tiktok_accounts WHERE id = $1", [acct.id]);
      await recordDecision({ agent: "human_reviewer", subjectType: "system", subjectId: `tiktok-${acct.open_id}`, action: "disconnect_tiktok", reason: reviewer(req) });
      return `Disconnected @${acct.username ?? acct.display_name ?? "TikTok"}; its tokens were deleted`;
    }),
  );

  // "Also post to TikTok" on an Instagram post.
  r.post("/admin/posts/:id/tiktok", async (req: Req, reply) => {
    const res = await adaptToTikTok(req.params.id, reviewer(req));
    return done(req, reply, res.postId ? `/admin/posts/${res.postId}` : `/admin/posts/${req.params.id}`, res.message, res.ok);
  });

  // The TikTok settings of one post, before it goes out.
  r.post("/admin/posts/:id/tiktok-settings", async (req: Req, reply) => {
    const to = `/admin/posts/${req.params.id}#tiktok`;
    const post = await one<{ status: string; tiktok: TikTokSettings }>("SELECT status, tiktok FROM posts WHERE id = $1 AND influencer_id = $2 AND platform = 'tiktok'", [req.params.id, influencerId()]);
    if (!post) return done(req, reply, to, "TikTok post not found", false);
    if (!EDITABLE.includes(post.status)) return done(req, reply, to, "It can't be changed now (unschedule it first if it's scheduled)", false);
    const b = req.body ?? {};
    const PRIVACY: TikTokSettings["privacy"][] = ["PUBLIC_TO_EVERYONE", "FOLLOWER_OF_CREATOR", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"];
    const privacy = PRIVACY.find((p) => p === b.privacy) ?? post.tiktok.privacy;
    const next: Partial<TikTokSettings> = {
      title: String(b.title ?? post.tiktok.title ?? "").replace(/\s+/g, " ").trim().slice(0, 90),
      privacy,
      allow_comments: b.allow_comments === "1",
      promotes_own_business: b.promotes_own_business === "1",
      ai_label: true,
    };
    await one("UPDATE posts SET tiktok = tiktok || $2::jsonb, updated_at = now() WHERE id = $1", [req.params.id, JSON.stringify(next)]);
    await recordDecision({ agent: "human_reviewer", subjectType: "post", subjectId: req.params.id, action: "tiktok_settings", reason: `${reviewer(req)}: ${privacy}${next.allow_comments ? "" : ", comments off"}` });
    return done(req, reply, to, "TikTok settings saved");
  });
}
