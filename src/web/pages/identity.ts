import type { FastifyInstance } from "fastify";
import { controlsSchema, getControls, setControls, type Controls } from "../../config/controls.js";
import { setting } from "../../config/settings.js";
import { currentInfluencer, influencerId } from "../../context.js";
import { many, one } from "../../db/pool.js";
import { attachInstagram, updatePersona } from "../../influencers/manage.js";
import { instagramClient, primaryAccount } from "../../instagram/accounts.js";
import { personaInfo } from "../../persona/loader.js";
import { bindHiggsfieldSoul, newSoulVersion, refreshHiggsfieldSoul, trainHiggsfieldSoul } from "../../souls/manage.js";
import { activeSoul, listSouls } from "../../souls/souls.js";
import { syncInfluencerSchedulers } from "../../queue/worker.js";
import { attempt, consoleRouter, done, render, reviewer, type Req } from "../console.js";
import { action, ago, avatar, button, card, empty, esc, field, header, icon, input, link, pill, select, table, textarea } from "../ui/kit.js";

const CONTROL_GROUPS: Array<[string, string, Array<keyof Controls>]> = [
  ["Operating mode", "What is allowed to go out.", ["mode", "paused", "require_review_for_yellow"]],
  ["Features", "Switch whole capabilities on or off.", ["conversation_enabled", "content_enabled", "image_generation_enabled", "carousel_generation_enabled"]],
  ["Posting cadence", "Hours are in the persona's local time.", ["max_posts_per_day", "min_hours_between_posts", "posting_window_start_hour", "posting_window_end_hour"]],
  ["Conversation limits", "", ["max_comment_replies_per_hour", "max_dms_per_hour", "optional_reply_rate"]],
  ["Budgets (this influencer)", "Hard caps checked before every paid call.", ["daily_budget_usd", "monthly_budget_usd", "daily_llm_budget_usd", "daily_image_budget_usd", "max_retries_per_image"]],
  ["Creativity guards", "", ["repetition_threshold", "max_concept_attempts"]],
];

const HELP: Partial<Record<keyof Controls, string>> = {
  mode: "development: no external writes · dry_run: full pipeline, nothing sent · human_approval: everything waits for you · autonomous: green goes out on its own",
  optional_reply_rate: "0–1. Chance of answering comments that don't strictly need a reply.",
  repetition_threshold: "0–1. Higher = stricter about repeating past posts.",
};

export function registerIdentity(app: FastifyInstance): void {
  const r = consoleRouter(app);

  // ------------------------------------------------------------ persona & soul
  r.get("/admin/persona", async (req: Req, reply) => {
    const inf = currentInfluencer();
    const info = personaInfo();
    const p = info.persona;
    const [soul, souls, acct, versions, knowledge, hfConfigured, igAppId] = await Promise.all([
      activeSoul(),
      listSouls(inf.id),
      primaryAccount(),
      many<{ hash: string; loaded_at: Date }>("SELECT hash, loaded_at FROM persona_versions WHERE influencer_id = $1 ORDER BY id DESC LIMIT 10", [inf.id]),
      one<{ knowledge_yaml: string; avatar_url: string | null }>("SELECT knowledge_yaml, avatar_url FROM influencers WHERE id = $1", [inf.id]),
      setting("HIGGSFIELD_API_KEY").then(Boolean),
      setting("INSTAGRAM_APP_ID"),
    ]);
    const hf = soul?.soul.provider_bindings?.higgsfield as { soul_id?: string; pending_id?: string; status?: string; fail_reason?: string } | undefined;

    const soulCard = soul
      ? `<div class="row" style="margin-bottom:12px"><code class="pill info">${esc(soul.soul.soul_id)}</code><span class="meta">version ${soul.soul.version} · ${soul.identityRefs.length} reference${soul.identityRefs.length === 1 ? "" : "s"} · since ${ago(soul.soul.created_at)}</span></div>
         <div class="slides">${soul.identityRefs.map((u, i) => `<figure><img src="${esc(u)}" alt="Identity reference ${i + 1}"><figcaption><span>${i === 0 ? "Primary face" : `Reference ${i + 1}`}</span></figcaption></figure>`).join("")}</div>
         <h3 class="small" style="margin:16px 0 8px">Provider characters</h3>
         <dl class="kv"><dt>Higgsfield Soul ID</dt><dd>${
           hf?.soul_id
             ? `${pill("active")} <code>${esc(hf.soul_id)}</code> <span class="meta">used by Soul 2 / Soul Cinema models</span>`
             : hf?.pending_id
               ? `${pill(hf.status === "failed" ? "failed" : "processing")} training <code>${esc(hf.pending_id)}</code> ${hf.fail_reason ? esc(hf.fail_reason) : ""}`
               : '<span class="muted">not trained</span>'
         }</dd></dl>
         <div class="row" style="margin-top:12px">${
           hfConfigured
             ? `${action("/admin/soul/higgsfield/train", hf?.soul_id ? "Retrain on Higgsfield" : "Train Higgsfield Soul ID", { icon: "wand", confirm: "Train a Higgsfield Soul ID from the current references? This uses Higgsfield credits." })}${
                 hf?.pending_id ? action("/admin/soul/higgsfield/refresh", "Check training", { icon: "refresh" }) : ""
               }`
             : `<span class="meta">${icon("key", 14)} Add a Higgsfield key in <a href="/admin/config#generation">Config</a> to train a Soul ID.</span>`
         }</div>
         <form method="post" action="/admin/soul/higgsfield/bind" class="row" style="margin-top:10px"><input name="id" placeholder="Existing Higgsfield character id" aria-label="Higgsfield character id" style="max-width:340px">${button("Bind", { small: true })}</form>`
      : empty("No soul yet", "Add face photos below to create this influencer's identity.");

    const body = `${header(p.identity.name, {
      eyebrow: "Persona & soul",
      sub: `${esc(p.identity.handle ?? "")} · ${esc(p.identity.location)} · persona <code>${esc(info.hash)}</code>`,
      actions: `${avatar(knowledge?.avatar_url ?? soul?.primaryRef, p.identity.name, 44)}`,
    })}
<div class="grid-2">
<div>
${card(soulCard, { title: "Soul (identity)", id: "soul" })}
${card(
  `<form method="post" action="/admin/soul/new">
    ${field("Reference photos", textarea("sources", (soul?.identityRefs ?? []).join("\n"), { rows: 4, mono: true, attrs: 'id="soul-src"' }), {
      help: "One per line: https:// image URLs, or upload below. The first is the primary face. Use 1–12 clear, well-lit photos of the same person; 5+ varied angles train the best Soul IDs.",
    })}
    <div class="field"><label for="soul-up">Upload photos</label><input id="soul-up" type="file" accept="image/*" multiple data-upload="soul-src"><div class="thumbs" id="soul-src-prev" style="margin-top:8px;grid-template-columns:repeat(auto-fill,minmax(80px,1fr))"></div></div>
    ${field("What changed", input("description", "", { placeholder: "e.g. new haircut, better lighting" }))}
    <label class="row small" style="margin-bottom:12px"><input type="checkbox" name="keep" value="1"> Keep provider characters (only if the face did not change)</label>
    ${button("Create new soul version", { variant: "primary", icon: "sparkles" })}
  </form>`,
  { title: "New soul version" },
)}
${card(
  souls.length
    ? table(
        ["Soul", "Status", "Refs", "Created"],
        souls.map((s) => [`<code>${esc(s.soul_id)}</code>`, pill(s.status === "active" ? "active" : s.status), String(s.refs.length), ago(s.created_at)]),
      )
    : empty("No souls"),
  { title: "Soul history" },
)}
</div>
<div>
${card(
  acct
    ? `<dl class="kv"><dt>Account</dt><dd><b>@${esc(acct.username ?? acct.ig_user_id)}</b></dd><dt>User ID</dt><dd><code>${esc(acct.ig_user_id)}</code></dd><dt>Token</dt><dd>expires ${ago(acct.token_expires_at)}</dd></dl>
       <div class="row" style="margin-top:12px">${action("/admin/instagram/subscribe", "Subscribe to comments & DMs", { icon: "zap", small: true })}${action("/admin/instagram/check", "Check connection", { icon: "refresh", small: true })}</div>`
    : `<p class="muted">No Instagram account attached. The influencer can plan and generate, but cannot publish or reply.</p>`,
  { title: "Instagram", id: "instagram" },
)}
${card(
  `<form method="post" action="/admin/instagram/attach">${field("Access token", `<input name="token" type="password" id="ig-token" autocomplete="off" placeholder="IGAA…">`, {
    help: 'From Meta → your app → Instagram → API setup with Instagram login → "Generate token" for the account. Stored encrypted; only a Creator/Business account works.',
  })}
   <label class="row small" style="margin-bottom:12px"><input type="checkbox" name="subscribe" value="1" checked> Subscribe to comment & DM webhooks</label>
   <div class="row">${button("Attach account", { variant: "primary", icon: "instagram" })}${igAppId ? link("Or log in with Instagram", `/admin/connect?inf=${inf.id}`, { variant: "ghost" }) : ""}</div></form>`,
  { title: acct ? "Replace account" : "Attach an account" },
)}
${card(table(["Version", "Saved"], versions.map((v) => [`<code>${esc(v.hash)}</code>`, ago(v.loaded_at)])), { title: "Persona versions" })}
</div>
</div>
${card(
  `<form method="post" action="/admin/persona">${field("Persona (YAML)", textarea("persona", info.source, { rows: 24, mono: true }), {
    help: "Validated on save (schema, locations, timezone). Takes effect within seconds; every version is kept.",
  })}${field("Business knowledge (YAML)", textarea("knowledge", knowledge?.knowledge_yaml ?? "", { rows: 10, mono: true }), { help: "Facts the influencer may cite: products, prices, store info. Leave empty if none." })}
  ${button("Save persona", { variant: "primary", icon: "check" })}</form>`,
  { title: "Edit persona", id: "edit" },
)}`;
    return render(req, reply, { title: "Persona & soul", active: "persona", body });
  });

  r.post("/admin/persona", async (req: Req, reply) =>
    attempt(req, reply, "/admin/persona#edit", async () => {
      const res = await updatePersona(influencerId(), String(req.body?.persona ?? ""), req.body?.knowledge ?? "", reviewer(req));
      await syncInfluencerSchedulers().catch(() => undefined); // timezone may have changed
      return `Saved ${res.name} (${res.hash})`;
    }),
  );
  r.post("/admin/soul/new", async (req: Req, reply) =>
    attempt(req, reply, "/admin/persona#soul", async () => {
      const s = await newSoulVersion({ influencerId: influencerId(), sources: String(req.body?.sources ?? "").split(/\r?\n/), description: req.body?.description || undefined, keepBindings: req.body?.keep === "1" });
      return `Created ${s.soul_id}`;
    }),
  );
  r.post("/admin/soul/higgsfield/train", async (req: Req, reply) =>
    attempt(req, reply, "/admin/persona#soul", async () => {
      const t = await trainHiggsfieldSoul(influencerId());
      return `Training started (${t.status}); usually 3–5 minutes`;
    }),
  );
  r.post("/admin/soul/higgsfield/refresh", async (req: Req, reply) =>
    attempt(req, reply, "/admin/persona#soul", async () => {
      const s = await refreshHiggsfieldSoul(influencerId());
      return s.status === "completed" ? "Soul ID is ready and in use" : `Still ${s.status}${s.reason ? `: ${s.reason}` : ""}`;
    }),
  );
  r.post("/admin/soul/higgsfield/bind", async (req: Req, reply) => attempt(req, reply, "/admin/persona#soul", () => bindHiggsfieldSoul(influencerId(), String(req.body?.id ?? ""))));

  r.post("/admin/instagram/attach", async (req: Req, reply) =>
    attempt(req, reply, "/admin/persona#instagram", async () => {
      const a = await attachInstagram(influencerId(), String(req.body?.token ?? ""), { subscribe: req.body?.subscribe === "1" });
      return `Attached @${a.username}${a.subscribed ? " and subscribed to webhooks" : ""}`;
    }),
  );
  r.post("/admin/instagram/subscribe", async (req: Req, reply) =>
    attempt(req, reply, "/admin/persona#instagram", async () => {
      const ig = await instagramClient();
      await ig.subscribeWebhooks(["comments", "messages"]);
      return "Subscribed to comments and messages";
    }),
  );
  r.post("/admin/instagram/check", async (req: Req, reply) =>
    attempt(req, reply, "/admin/persona#instagram", async () => {
      const ig = await instagramClient();
      const [p, subs] = await Promise.all([ig.getProfile(), ig.subscribedWebhooks().catch(() => ({ data: [] }))]);
      const fields = subs.data.flatMap((d) => d.subscribed_fields ?? []);
      return `@${p.username}: ${p.followers_count ?? "?"} followers · webhooks: ${fields.length ? fields.join(", ") : "none"}`;
    }),
  );

  // ------------------------------------------------------------ controls
  r.get("/admin/controls", async (req: Req, reply) => {
    const c = (await getControls(true)) as Record<string, unknown>;
    const control = (k: string) => {
      const v = c[k];
      if (k === "mode") return select("mode", ["development", "dry_run", "human_approval", "autonomous"], v);
      if (typeof v === "boolean") return select(k, [["true", "On"], ["false", "Off"]], String(v));
      return input(k, v, { type: "number", attrs: 'step="any" inputmode="decimal"' });
    };
    const body = `${header("Controls", { sub: `Operating rules for ${esc(currentInfluencer().name)}. Changes apply within seconds; no deploy.` })}
<form method="post" action="/admin/controls">
${CONTROL_GROUPS.map(([title, sub, keys]) =>
  card(`${sub ? `<p class="meta" style="margin-top:0">${esc(sub)}</p>` : ""}<div class="cols">${keys.map((k) => field(k.replace(/_/g, " "), control(k), { help: HELP[k] })).join("")}</div>`, { title }),
).join("")}
<div class="row">${button("Save controls", { variant: "primary", icon: "check" })}${link("Platform budgets", "/admin/costs#platform", { variant: "ghost" })}</div>
</form>`;
    return render(req, reply, { title: "Controls", active: "controls", body });
  });
  r.post("/admin/controls", async (req: Req, reply) =>
    attempt(req, reply, "/admin/controls", async () => {
      const patch: Record<string, unknown> = {};
      const shape = controlsSchema.shape as Record<string, unknown>;
      const current = (await getControls(true)) as Record<string, unknown>;
      for (const [k, raw] of Object.entries(req.body ?? {})) {
        if (!(k in shape) || k.startsWith("platform_")) continue;
        const cur = current[k];
        const text = String(raw).trim();
        if (text === "") continue; // an emptied field means "leave as is", never 0
        let v: unknown = raw;
        if (typeof cur === "boolean") v = text === "true";
        else if (typeof cur === "number") {
          v = Number(text);
          if (!Number.isFinite(v as number)) throw new Error(`${k.replace(/_/g, " ")} must be a number`);
        }
        // Only what changed becomes this influencer's own value; the rest keeps inheriting platform defaults.
        if (v !== cur) patch[k] = v;
      }
      if (!Object.keys(patch).length) return "Nothing changed";
      await setControls(patch as Partial<Controls>, reviewer(req), influencerId());
      return `Saved ${Object.keys(patch).length} change${Object.keys(patch).length === 1 ? "" : "s"}`;
    }),
  );
  r.post("/admin/controls/pause", async (req: Req, reply) => {
    const paused = req.body?.paused === "true";
    await setControls({ paused }, reviewer(req), influencerId());
    const back = String(req.headers.referer ?? "/admin").replace(/^https?:\/\/[^/]+/, "").split("?")[0] || "/admin";
    return done(req, reply, back.startsWith("/admin") ? back : "/admin", paused ? `${currentInfluencer().name} paused` : `${currentInfluencer().name} resumed`);
  });
}
