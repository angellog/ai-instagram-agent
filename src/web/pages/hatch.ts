import type { FastifyInstance } from "fastify";
import { getControls, setControls } from "../../config/controls.js";
import { setting } from "../../config/settings.js";
import { withInfluencer, withInfluencerLoose } from "../../context.js";
import { many } from "../../db/pool.js";
import { adapters } from "../../generation/adapters/index.js";
import { composePersona, type HatchBrief } from "../../influencers/compose.js";
import type { FaceCandidate } from "../../influencers/hatch.js";
import { attachInstagram, createInfluencer, getInfluencer, setHatchState, setStatus, updatePersona, type InfluencerRow } from "../../influencers/manage.js";
import { primaryAccount } from "../../instagram/accounts.js";
import { errorMessage, PermanentError } from "../../lib/errors.js";
import { parsePersona } from "../../persona/loader.js";
import { JOBS, jobId, queue } from "../../queue/queues.js";
import { syncInfluencerSchedulers } from "../../queue/worker.js";
import { newSoulVersion, trainHiggsfieldSoul } from "../../souls/manage.js";
import { activeSoul, nextSoulId } from "../../souls/souls.js";
import { composeProfileText, generateProfilePicture, profilePictureFromSoul } from "../../influencers/profile.js";
import { PROFILE_CSS, profileKitBody } from "./profile.js";
import { startCreate } from "../../content/create.js";
import { attempt, consoleRouter, render, reviewer, selectCookie, type Req } from "../console.js";
import { action, button, card, empty, esc, field, header, icon, input, link, select, steps, textarea } from "../ui/kit.js";

const STEPS = ["Brief", "Persona", "Soul", "Profile", "Instagram", "Launch"];
const TIMEZONES = [
  "Africa/Kampala",
  "Africa/Nairobi",
  "Africa/Lagos",
  "Africa/Johannesburg",
  "Africa/Cairo",
  "Europe/London",
  "Europe/Paris",
  "America/New_York",
  "America/Los_Angeles",
  "Asia/Dubai",
  "Asia/Tokyo",
  "Australia/Sydney",
];

type Step = "brief" | "persona" | "soul" | "profile" | "instagram" | "launch";

function readBrief(b: Record<string, string | undefined>): HatchBrief {
  const t = (k: string) => (b[k] ?? "").trim() || undefined;
  return {
    name: (b.name ?? "").trim(),
    niche: (b.niche ?? "").trim(),
    city: (b.city ?? "").trim(),
    timezone: t("timezone"),
    age: t("age"),
    vibe: t("vibe"),
    audience: t("audience"),
    appearance: t("appearance"),
    brand: t("brand"),
    language: t("language"),
  };
}

function briefForm(b: Partial<HatchBrief> = {}, to = "/admin/hatch"): string {
  return `<form method="post" action="${to}">
  <div class="cols">
    ${field("Name", input("name", b.name ?? "", { attrs: 'required maxlength="60"', placeholder: "e.g. Amara" }), { required: true })}
    ${field("Home city", input("city", b.city ?? "", { attrs: "required", placeholder: "e.g. Nairobi, Kenya" }), { required: true })}
    ${field("Timezone", input("timezone", b.timezone ?? "", { attrs: 'list="tz"', placeholder: "auto from the city" }))}
    ${field("Age", input("age", b.age ?? "", { placeholder: "e.g. 26" }))}
  </div>
  ${field("Niche", input("niche", b.niche ?? "", { attrs: "required", placeholder: "e.g. running, healthy food and weekend hikes around Nairobi" }), { required: true, help: "What they post about. Specific beats broad." })}
  <div class="cols">
    ${field("Personality / vibe", input("vibe", b.vibe ?? "", { placeholder: "warm, witty, early riser" }))}
    ${field("Audience to build", input("audience", b.audience ?? "", { placeholder: "young professionals into fitness" }))}
  </div>
  ${field("Look", input("appearance", b.appearance ?? "", { placeholder: "e.g. dark skin, short natural hair, athletic, big smile" }), { help: "Used to generate face options. Never name a real person." })}
  <div class="cols">
    ${field("Affiliated brand", input("brand", b.brand ?? "", { placeholder: "optional, e.g. FeetBit" }))}
    ${field("Languages", input("language", b.language ?? "", { placeholder: "English, some Swahili" }))}
  </div>
  <datalist id="tz">${TIMEZONES.map((t) => `<option value="${t}">`).join("")}</datalist>
  ${button("Compose persona", { variant: "primary", icon: "wand" })} <span class="meta">Takes about 30 seconds.</span>
</form>`;
}

/** A number from a form field, or the fallback when it's empty or not a number. */
const numOr = (v: string | undefined, fallback: number) => {
  const n = Number(String(v ?? "").trim());
  return String(v ?? "").trim() !== "" && Number.isFinite(n) ? n : fallback;
};

const stepIndex = (s: Step) => ["brief", "persona", "soul", "profile", "instagram", "launch"].indexOf(s);

async function readiness(inf: InfluencerRow) {
  const [soul, acct, llmKey, providers] = await Promise.all([
    activeSoul(Number(inf.id)),
    primaryAccount(Number(inf.id)),
    setting("LLM_API_KEY"),
    Promise.all([...adapters().values()].filter((a) => a.id !== "mock").map(async (a) => ((await a.isConfigured()) ? a.displayName : undefined))),
  ]);
  return { soul, acct, llm: Boolean(llmKey), providers: providers.filter((x): x is string => Boolean(x)) };
}

function check(ok: boolean, text: string): string {
  return `<li>${ok ? `<span style="color:var(--ok)">${icon("check", 18, "ready")}</span>` : `<span style="color:var(--warn)">${icon("alert", 18, "missing")}</span>`}<span>${esc(text)}</span></li>`;
}

export function registerHatch(app: FastifyInstance): void {
  const r = consoleRouter(app);

  const load = async (id: number) => {
    const inf = await getInfluencer(id);
    if (!inf || inf.status === "archived") throw new PermanentError("influencer not found");
    return inf;
  };

  // ------------------------------------------------------------ step 0: brief
  r.get(
    "/admin/hatch",
    async (req: Req, reply) => {
      const inProgress = await many<{ id: number; name: string }>("SELECT id, name FROM influencers WHERE status = 'hatching' ORDER BY id DESC");
      const body = `${header("Hatch an influencer", {
        sub: "Six steps from an idea to a live account building an audience: brief → persona → soul (face + Soul ID) → profile kit → Instagram → launch. Nothing posts until you launch, and it starts in human-approval mode.",
      })}
${steps(STEPS, 0)}
${inProgress.length ? card(`<ul class="list">${inProgress.map((i) => `<li>${icon("egg", 16)}<b>${esc(i.name)}</b><span class="right">${link("Continue", `/admin/hatch/${i.id}`, { small: true })}</span></li>`).join("")}</ul>`, { title: "In progress" }) : ""}
${card(briefForm(), { title: "The brief" })}`;
      return render(req, reply, { title: "Hatch", active: "influencers:hatch", body });
    },
    { platform: true },
  );

  r.post(
    "/admin/hatch",
    async (req: Req, reply) => {
      const brief = readBrief(req.body ?? {});
      let inf: InfluencerRow;
      try {
        inf = await createInfluencer({ name: brief.name, hatchState: { brief } });
      } catch (e) {
        return reply.redirect(`/admin/hatch?flash=${encodeURIComponent(`Not saved: ${errorMessage(e)}`)}`, 303);
      }
      reply.header("set-cookie", selectCookie(Number(inf.id)));
      try {
        const composed = await withInfluencerLoose(Number(inf.id), () => composePersona(brief));
        await withInfluencerLoose(Number(inf.id), () => updatePersona(Number(inf.id), composed.yaml, "", reviewer(req)));
        await setHatchState(Number(inf.id), { step: "persona" });
        return reply.redirect(`/admin/hatch/${inf.id}?step=persona&flash=${encodeURIComponent(`Persona drafted for ${composed.name}`)}`, 303);
      } catch (e) {
        return reply.redirect(`/admin/hatch/${inf.id}?step=brief&flash=${encodeURIComponent(`Not saved: persona draft failed: ${errorMessage(e)}`)}`, 303);
      }
    },
    { platform: true },
  );

  // ------------------------------------------------------------ wizard page
  r.get(
    "/admin/hatch/:id",
    async (req: Req, reply) => {
      const id = Number(req.params.id);
      const inf = Number.isInteger(id) ? await getInfluencer(id) : undefined;
      if (!inf) return reply.redirect("/admin/hatch", 303);
      if (inf.status !== "hatching") return reply.redirect(`/admin?flash=${encodeURIComponent(`${inf.name} is already ${inf.status}`)}`, 303);
      const state = inf.hatch_state as { brief?: HatchBrief; step?: Step; faces?: FaceCandidate[]; faces_status?: string; faces_error?: string | null };
      const hasPersona = Boolean(inf.persona_yaml.trim());
      const ready = await readiness(inf);
      const STEP_KEYS: Step[] = ["brief", "persona", "soul", "profile", "instagram", "launch"];
      const asked = STEP_KEYS.includes(req.query.step as Step) ? (req.query.step as Step) : undefined;
      const saved = STEP_KEYS.includes(state.step as Step) ? (state.step as Step) : undefined;
      const wanted: Step = asked ?? saved ?? (hasPersona ? "persona" : "brief");
      const step: Step = !hasPersona ? "brief" : (wanted === "profile" || wanted === "instagram" || wanted === "launch") && !ready.soul ? "soul" : wanted;
      let content = "";
      let head = "";

      if (step === "brief") {
        content = card(briefForm(state.brief ?? { name: inf.name }, `/admin/hatch/${id}/compose`), { title: "The brief" });
      } else if (step === "persona") {
        let summary: string;
        try {
          const p = parsePersona(inf.persona_yaml);
          summary = `<dl class="kv"><dt>Name</dt><dd><b>${esc(p.identity.name)}</b> ${esc(p.identity.handle ?? "")}</dd><dt>Lives in</dt><dd>${esc(p.identity.location)} · ${esc(p.identity.timezone)}</dd><dt>Does</dt><dd>${esc(p.identity.occupation)}</dd><dt>Bio</dt><dd>${esc(p.identity.bio)}</dd><dt>Voice</dt><dd>${esc(p.communication_style.voice)}</dd><dt>Interests</dt><dd>${esc(p.interests.join(", "))}</dd><dt>A day</dt><dd>${p.daily_life.activities.length} activities across ${p.visual.locations.length} places</dd><dt>Look</dt><dd>${esc(p.visual.character.appearance)}</dd></dl>`;
        } catch (e) {
          summary = `<div class="callout bad">${icon("alert")}<p>${esc(errorMessage(e))}</p></div>`;
        }
        content = `<div class="grid-2">${card(
          `<form method="post" action="/admin/hatch/${id}/persona">${field("Persona YAML", textarea("persona", inf.persona_yaml, { rows: 30, mono: true }), { help: "Edit anything. It is validated when you continue." })}${button("Save & continue", { variant: "primary", icon: "arrowRight" })}</form>`,
          { title: "Persona" },
        )}<div>${card(summary, { title: "At a glance" })}${card(briefForm(state.brief ?? { name: inf.name }, `/admin/hatch/${id}/compose`), { title: "Re-compose from a new brief" })}</div></div>`;
      } else if (step === "soul") {
        const faces = state.faces ?? [];
        const running = state.faces_status === "running" || state.faces_status === "queued";
        if (running) head = `<meta http-equiv="refresh" content="6">`;
        const soulId = ready.soul?.soul.soul_id ?? (await nextSoulId(inf.slug));
        const hfReady = Boolean((await setting("HIGGSFIELD_API_KEY")) && (await setting("HIGGSFIELD_API_SECRET")));
        const facesBody = faces.length
          ? `<div class="choice">${faces
              .map(
                (f, i) =>
                  `<div><input type="checkbox" name="faces" value="${esc(f.url)}" id="face-${i}"${i === 0 && !ready.soul ? " checked" : ""}><label for="face-${i}"><img src="${esc(f.url)}" alt="Face option ${i + 1}"><span class="meta">Option ${i + 1}${f.model ? ` · ${esc(f.model)}` : ""}</span></label></div>`,
              )
              .join("")}</div><p class="help">Pick one or more photos of the <b>same</b> person. The first ticked becomes the primary face.</p>`
          : running
            ? `<div class="empty">${icon("refresh", 28)}<b>Generating face options…</b><p>This page refreshes on its own.</p></div>`
            : empty("No face options yet", "Generate three options from the persona's look, or use your own photos.");
        content = `${ready.soul ? `<div class="callout ok">${icon("check")}<p>Soul <code>${esc(ready.soul.soul.soul_id)}</code> is set with ${ready.soul.identityRefs.length} reference(s). Continue, or replace it below.</p></div>` : ""}
<form method="post" action="/admin/hatch/${id}/soul">
<div class="grid-2">
${card(`${facesBody}${state.faces_error ? `<div class="callout warn">${icon("alert")}<p>${esc(state.faces_error)}</p></div>` : ""}`, {
  title: "1 · Choose a face",
  actions: running ? "" : `<button class="btn sm" formaction="/admin/hatch/${id}/faces" formnovalidate>${icon("sparkles", 14)}<span>${faces.length ? "Generate more" : "Generate 3 options"}</span></button>`,
})}
<div>
${card(
  `${field("Photo URLs", textarea("sources", "", { rows: 3, mono: true, attrs: 'id="hatch-src" placeholder="https://…jpg (one per line)"' }), { help: "Optional: real reference photos you have the rights to use." })}
   <div class="field"><label for="hatch-up">Upload photos</label><input id="hatch-up" type="file" accept="image/*" multiple data-upload="hatch-src"><div class="thumbs" id="hatch-src-prev" style="margin-top:8px;grid-template-columns:repeat(auto-fill,minmax(70px,1fr))"></div></div>`,
  { title: "…or bring your own photos" },
)}
${card(
  `${field("Soul ID", input("soul_id", soulId, { attrs: 'pattern="soul_[a-z0-9_\\-]{2,60}"' }), { help: "The identity handle every generation is tied to: soul_ followed by letters, digits, _ or -." })}
   ${
     hfReady
       ? `<label class="row small" style="margin-bottom:12px"><input type="checkbox" name="train_hf" value="1"> Also train a Higgsfield Soul ID (best consistency; uses Higgsfield credits, ~5 min)</label>`
       : `<p class="help">${icon("info", 14)} Add a Higgsfield key in Config to also train a provider-side Soul ID.</p>`
   }
   <div class="row">${button(ready.soul ? "Replace soul & continue" : "Create soul & continue", { variant: "primary", icon: "arrowRight" })}${ready.soul ? link("Keep current soul", `/admin/hatch/${id}?step=profile`, { variant: "ghost" }) : ""}</div>`,
  { title: "2 · Name the soul" },
)}
</div></div></form>`;
      } else if (step === "profile") {
        head = PROFILE_CSS;
        content = `${await withInfluencer(id, () => profileKitBody(`/admin/hatch/${id}/profile`))}
<div class="row">${link("Continue to Instagram", `/admin/hatch/${id}?step=instagram`, { variant: "primary", icon: "arrowRight" })}<span class="meta">Set the profile up in the Instagram app while you create the account, then attach it here.</span></div>`;
      } else if (step === "instagram") {
        const appId = await setting("INSTAGRAM_APP_ID");
        content = `${ready.acct ? `<div class="callout ok">${icon("check")}<p>Attached <b>@${esc(ready.acct.username ?? ready.acct.ig_user_id)}</b>. ${link("Continue to launch", `/admin/hatch/${id}?step=launch`, { small: true, variant: "primary" })}</p></div>` : ""}
<div class="grid-2">
${card(
  `<form method="post" action="/admin/hatch/${id}/instagram">
    ${field("Instagram access token", `<input name="token" type="password" autocomplete="off" placeholder="IGAA…">`, {
      help: 'Meta for Developers → your app → Instagram → "API setup with Instagram login" → add the account → "Generate token". The account must be a Creator or Business account.',
    })}
    <label class="row small" style="margin-bottom:12px"><input type="checkbox" name="subscribe" value="1" checked> Subscribe to comment & DM webhooks</label>
    <div class="row">${button("Attach & continue", { variant: "primary", icon: "instagram" })}${appId ? link("Log in with Instagram instead", `/admin/connect?inf=${id}`, { variant: "ghost" }) : ""}</div></form>`,
  { title: "Attach the Instagram page" },
)}
${card(
  `<ol class="small" style="padding-left:18px;margin:0;display:grid;gap:6px"><li>Create the Instagram account in the app (name, bio, profile photo from the soul).</li><li>Settings → Account type → switch to <b>Creator</b>.</li><li>In the Meta app, add it under Instagram → API setup, then <b>Generate token</b>.</li><li>Paste the token here. It is stored encrypted and refreshed automatically.</li></ol>
   <form method="post" action="/admin/hatch/${id}/instagram/skip" style="margin-top:14px">${button("Skip for now", { variant: "ghost", small: true })}</form><p class="help">Without an account the influencer can plan and generate, but not publish or reply.</p>`,
  { title: "How to get a token" },
)}
</div>`;
      } else {
        const c = await withInfluencer(id, () => getControls(true));
        content = `<div class="grid-2">
${card(
  `<form method="post" action="/admin/hatch/${id}/launch">
    ${field("Start in mode", select("mode", [["human_approval", "Human approval: everything waits for you (recommended)"], ["dry_run", "Dry run: full pipeline, nothing goes out"], ["autonomous", "Autonomous: green content goes out on its own"]], "human_approval"))}
    <div class="cols">
      ${field("Posts per day (max)", input("max_posts_per_day", c.max_posts_per_day, { type: "number", attrs: 'min="0" max="6"' }))}
      ${field("Daily budget (USD)", input("daily_budget_usd", c.daily_budget_usd, { type: "number", attrs: 'step="0.5" min="0"' }))}
      ${field("Daily image budget (USD)", input("daily_image_budget_usd", c.daily_image_budget_usd, { type: "number", attrs: 'step="0.5" min="0"' }))}
    </div>
    <label class="row small" style="margin-bottom:12px"><input type="checkbox" name="plan_now" value="1" checked> Create the first post right away (you review it before it goes out)</label>
    ${button("Launch", { variant: "primary", icon: "zap" })}</form>`,
  { title: "Launch settings" },
)}
${card(
  `<ul class="list">${[
    check(Boolean(inf.persona_yaml.trim()), "Persona composed and validated"),
    check(Boolean(ready.soul), ready.soul ? `Soul ${ready.soul.soul.soul_id}` : "Soul"),
    check(Boolean(ready.acct), ready.acct ? `Instagram @${ready.acct.username ?? ready.acct.ig_user_id}` : "Instagram (skipped: no posting or replies)"),
    check(ready.llm, "Language model key"),
    check(ready.providers.length > 0, ready.providers.length ? `Image providers: ${ready.providers.join(", ")}` : "An image provider (Config)"),
  ].join("")}</ul>
   ${ready.soul ? `<div class="thumbs" style="margin-top:12px;grid-template-columns:repeat(auto-fill,minmax(90px,1fr))">${ready.soul.identityRefs.slice(0, 4).map((u) => `<img src="${esc(u)}" alt="">`).join("")}</div>` : ""}`,
  { title: "Checklist" },
)}
</div>`;
      }

      const body = `${header(`Hatching ${inf.name}`, {
        eyebrow: "Hatch",
        actions: action(`/admin/influencers/${id}/status`, "Discard", { variant: "danger", small: true, fields: { status: "archived" }, confirm: `Discard ${inf.name}? It is archived, not deleted.` }),
      })}
${steps(STEPS, stepIndex(step))}
<nav class="row small" aria-label="Wizard steps" style="margin:-8px 0 16px">${(["persona", "soul", "profile", "instagram", "launch"] as Step[])
        .filter((s) => hasPersona && (s === "persona" || s === "soul" || Boolean(ready.soul)))
        .map((s) => (s === step ? `<b>${esc(s)}</b>` : `<a href="/admin/hatch/${id}?step=${s}">${esc(s)}</a>`))
        .join(" · ")}</nav>
${content}`;
      return render(req, reply, { title: `Hatching ${inf.name}`, active: "influencers:hatch", body, head });
    },
    { platform: true },
  );

  // ------------------------------------------------------------ step actions
  r.post(
    "/admin/hatch/:id/compose",
    async (req: Req, reply) =>
      attempt(req, reply, `/admin/hatch/${req.params.id}?step=persona`, async () => {
        const id = Number(req.params.id);
        await load(id);
        const brief = readBrief(req.body ?? {});
        const composed = await composePersona(brief);
        await updatePersona(id, composed.yaml, undefined, reviewer(req));
        await setHatchState(id, { brief, step: "persona" });
        return `Persona drafted for ${composed.name}`;
      }),
    { platform: true, influencerParam: "id" },
  );
  r.post(
    "/admin/hatch/:id/persona",
    async (req: Req, reply) =>
      attempt(req, reply, `/admin/hatch/${req.params.id}?step=persona`, async () => {
        const id = Number(req.params.id);
        await load(id);
        const res = await updatePersona(id, String(req.body?.persona ?? ""), undefined, reviewer(req));
        await setHatchState(id, { step: "soul" });
        return { message: `Saved ${res.name}`, to: `/admin/hatch/${id}?step=soul` };
      }),
    { platform: true, influencerParam: "id" },
  );
  r.post(
    "/admin/hatch/:id/faces",
    async (req: Req, reply) =>
      attempt(req, reply, `/admin/hatch/${req.params.id}?step=soul`, async () => {
        const id = Number(req.params.id);
        await load(id);
        const batch = String(Date.now());
        await setHatchState(id, { faces_status: "queued", faces_error: null });
        await queue("content").add(JOBS.hatchFaces, { influencerId: id, batch }, { jobId: jobId("faces", id, batch), attempts: 1 });
        return "Generating three face options…";
      }),
    { platform: true, influencerParam: "id" },
  );
  r.post(
    "/admin/hatch/:id/soul",
    async (req: Req, reply) =>
      attempt(req, reply, `/admin/hatch/${req.params.id}?step=soul`, async () => {
        const id = Number(req.params.id);
        await load(id);
        const b = (req.body ?? {}) as unknown as Record<string, string | string[]>;
        const sources = [...([] as string[]).concat(b.faces ?? []), ...String(b.sources ?? "").split(/\r?\n/)].map((s) => s.trim()).filter(Boolean);
        const soul = await newSoulVersion({ influencerId: id, sources, soulId: String(b.soul_id ?? ""), description: "Hatched" });
        let extra = "";
        if (b.train_hf === "1") {
          try {
            await trainHiggsfieldSoul(id);
            extra = "; Higgsfield training started";
          } catch (e) {
            extra = `; Higgsfield training not started: ${errorMessage(e)}`;
          }
        }
        // Right after the face is chosen: the profile kit (text + a face-crop picture) so it's ready while the account is created.
        await withInfluencer(id, async () => {
          await profilePictureFromSoul().catch((e) => (extra += `; profile picture not made: ${errorMessage(e)}`));
          await composeProfileText().catch((e) => (extra += `; profile text not written: ${errorMessage(e)}`));
        });
        await setHatchState(id, { step: "profile" });
        return { message: `Soul ${soul.soul_id} created${extra}`, to: `/admin/hatch/${id}?step=profile` };
      }),
    { platform: true, influencerParam: "id" },
  );
  for (const [path, fn, msg] of [
    ["text", composeProfileText, "Profile text written"],
    ["picture/crop", profilePictureFromSoul, "Profile picture cropped from the soul face"],
    ["picture/generate", generateProfilePicture, "New profile headshot designed"],
  ] as const) {
    r.post(
      `/admin/hatch/:id/profile/${path}`,
      async (req: Req, reply) =>
        attempt(req, reply, `/admin/hatch/${req.params.id}?step=profile`, async () => {
          const id = Number(req.params.id);
          await load(id);
          await withInfluencer(id, async () => {
            await fn();
          });
          return msg;
        }),
      { platform: true, influencerParam: "id" },
    );
  }
  r.post(
    "/admin/hatch/:id/instagram",
    async (req: Req, reply) =>
      attempt(req, reply, `/admin/hatch/${req.params.id}?step=instagram`, async () => {
        const id = Number(req.params.id);
        await load(id);
        const a = await attachInstagram(id, String(req.body?.token ?? ""), { subscribe: req.body?.subscribe === "1" });
        await setHatchState(id, { step: "launch" });
        return { message: `Attached @${a.username}${a.subscribed ? " (webhooks on)" : ""}`, to: `/admin/hatch/${id}?step=launch` };
      }),
    { platform: true, influencerParam: "id" },
  );
  r.post(
    "/admin/hatch/:id/instagram/skip",
    async (req: Req, reply) =>
      attempt(req, reply, `/admin/hatch/${req.params.id}?step=instagram`, async () => {
        const id = Number(req.params.id);
        await load(id);
        await setHatchState(id, { step: "launch", instagram_skipped: true });
        return { message: "Skipped Instagram for now", to: `/admin/hatch/${id}?step=launch` };
      }),
    { platform: true, influencerParam: "id" },
  );
  r.post(
    "/admin/hatch/:id/launch",
    async (req: Req, reply) =>
      attempt(req, reply, `/admin/hatch/${req.params.id}?step=launch`, async () => {
        const id = Number(req.params.id);
        const inf = await load(id);
        const b = req.body ?? {};
        const mode = (["human_approval", "dry_run", "autonomous"].includes(b.mode) ? b.mode : "human_approval") as "human_approval";
        await setControls(
          {
            mode,
            max_posts_per_day: Math.max(0, Math.min(6, numOr(b.max_posts_per_day, 2))),
            daily_budget_usd: Math.max(0, numOr(b.daily_budget_usd, 3)),
            daily_image_budget_usd: Math.max(0, numOr(b.daily_image_budget_usd, 2)),
          },
          reviewer(req),
          id,
        );
        await setStatus(id, "active");
        await setHatchState(id, { step: "done", launched_at: new Date().toISOString() });
        await syncInfluencerSchedulers().catch(() => undefined);
        reply.header("set-cookie", selectCookie(id));
        if (b.plan_now === "1") {
          const run = await withInfluencer(id, () => startCreate(reviewer(req)));
          return { message: `${inf.name} is live: creating the first post`, to: `/admin/create/${run.id}` };
        }
        return { message: `${inf.name} is live`, to: "/admin" };
      }),
    { platform: true, influencerParam: "id" },
  );
}
