import type { FastifyInstance } from "fastify";
import { influencerId } from "../../context.js";
import { many, one } from "../../db/pool.js";
import { benchmarkResults, planBenchmark, SUITE } from "../../generation/benchmark.js";
import { adapters } from "../../generation/adapters/index.js";
import { healthStats, listModels, policyFor, providerStates, savePolicy, validateProvider } from "../../generation/registry.js";
import { route, type Policy } from "../../generation/router.js";
import { MODALITIES, ROUTING_MODES, type GenerationRequest, type ModelRow } from "../../generation/types.js";
import { JOBS, jobId, queue } from "../../queue/queues.js";
import { activeSoul, soulContext } from "../../souls/souls.js";
import { attempt, consoleRouter, done, isUuid, render, type Req } from "../console.js";
import { action, ago, button, card, empty, esc, field, header, icon, input, link, pill, select, status, table, tabs, usd } from "../ui/kit.js";

const MODE_HELP: Record<string, string> = {
  fixed: "Always the preferred model; fail if it can't run.",
  preferred_fallback: "Preferred model first, then your fallback chain (then best eligible).",
  best_quality: "Highest quality + identity, cost ignored.",
  best_value: "Best quality per dollar.",
  fastest: "Quickest model above a quality floor.",
  capability_first: "Any model that can do the job, catalog order.",
  auto: "Weighted score: identity, quality, speed, health and cost.",
};

const label = (m: ModelRow) => `${m.display_name}`;
const caps = (m: ModelRow) => m.capabilities.map((c) => `<span class="pill">${esc(c.replace(/_/g, " "))}</span>`).join(" ");
const score = (v: number) => `<span title="${v}">${Math.round(Number(v) * 100)}</span>`;

function genTabs(active: string): string {
  return tabs([
    { href: "/admin/generation", label: "Providers & models", active: active === "engine" },
    { href: "/admin/generation/policy", label: "Routing policy", active: active === "policy" },
    { href: "/admin/generation/requests", label: "Jobs & failures", active: active === "requests" },
    { href: "/admin/generation/assets", label: "Assets", active: active === "assets" },
    { href: "/admin/generation/benchmarks", label: "Benchmarks", active: active === "bench" },
  ]);
}

export function registerGeneration(app: FastifyInstance): void {
  const r = consoleRouter(app);

  // ------------------------------------------------------------ providers & models
  r.get("/admin/generation", async (req: Req, reply) => {
    const [states, models, rows] = await Promise.all([
      providerStates(),
      listModels(),
      many<{ id: string; display_name: string; enabled: boolean; verified: boolean; last_verified_at: Date | null; last_success_at: Date | null; last_error: string | null; last_error_at: Date | null; quarantined_until: Date | null; health_status: string }>(
        "SELECT * FROM generation_providers ORDER BY id",
      ),
    ]);
    const stats = new Map(await Promise.all(rows.map(async (p) => [p.id, await healthStats("provider", p.id)] as const)));
    const reg = adapters();
    const provTable = table(
      ["Provider", "Credentials", "Health", "Success (24h)", "Last success", "Last error", ""],
      rows.map((p) => {
        const st = states.get(p.id);
        const s = stats.get(p.id)!;
        const quarantined = p.quarantined_until && new Date(p.quarantined_until) > new Date();
        const keys = reg.get(p.id)?.credentialKeys ?? [];
        return [
          `<b>${esc(p.display_name)}</b><div class="meta"><code>${esc(p.id)}</code>${p.verified ? ` · ${icon("check", 12)} verified` : " · unverified"}</div>`,
          st?.configured ? pill("active") : keys.length ? `<a href="/admin/config#generation" class="small">add ${esc(keys.join(" + "))}</a>` : `<span class="meta">none needed</span>`,
          `${status(quarantined ? "unavailable" : p.health_status)}${quarantined ? `<div class="meta">quarantined until ${new Date(p.quarantined_until!).toLocaleTimeString("en-GB")}</div>` : ""}`,
          s.samples ? `${Math.round(s.successRate * 100)}% <span class="meta">of ${s.samples}${s.p50LatencyMs ? ` · p50 ${Math.round(s.p50LatencyMs / 1000)}s` : ""}</span>` : '<span class="meta">no data</span>',
          ago(p.last_success_at),
          p.last_error ? `<span class="small" title="${esc(p.last_error)}">${esc(p.last_error.slice(0, 80))}</span><div class="meta">${ago(p.last_error_at)}</div>` : "—",
          `<div class="row">${
            st?.configured ? `<form method="post" action="/admin/generation/providers/${p.id}/test" data-async>${button("Test", { small: true, icon: "zap" })}</form>` : ""
          }${action(`/admin/generation/providers/${p.id}/toggle`, p.enabled ? "Disable" : "Enable", { small: true, variant: p.enabled ? "ghost" : "primary" })}${
            quarantined ? action(`/admin/generation/providers/${p.id}/unquarantine`, "Release", { small: true }) : ""
          }</div>`,
        ];
      }),
    );
    const byGroup: Array<[string, (m: ModelRow) => boolean]> = [
      ["Identity & reference images", (m) => m.capabilities.includes("reference_image") || m.capabilities.includes("soul")],
      ["Text to image", (m) => m.capabilities.includes("text_to_image") && !m.capabilities.includes("reference_image") && !m.capabilities.includes("soul")],
      ["Edit & upscale", (m) => (m.capabilities.includes("upscale") || m.capabilities.includes("image_edit")) && !m.capabilities.includes("reference_image")],
      ["Video", (m) => m.capabilities.some((c) => c.includes("video"))],
    ];
    const seen = new Set<number>();
    const modelCards = byGroup
      .map(([title, pred]) => {
        const ms = models.filter((m) => !m.deprecated && pred(m) && !seen.has(m.id));
        ms.forEach((m) => seen.add(m.id));
        if (!ms.length) return "";
        return card(
          table(
            ["Model", "Provider", "Can do", "Identity", "Quality", "Speed", "Est. cost", "Health", ""],
            ms.map((m) => [
              `<b>${esc(label(m))}</b><div class="meta"><code>${esc(m.model_id)}</code>${(m as unknown as { scores_source: string }).scores_source !== "catalog" ? ` · ${esc((m as unknown as { scores_source: string }).scores_source)} scores` : ""}</div>`,
              `${esc(m.provider_id)}${states.get(m.provider_id)?.configured ? "" : ` <span class="meta">(no key)</span>`}`,
              caps(m),
              score(m.identity_score),
              score(m.quality_score),
              score(m.speed_score),
              `${usd(m.cost_estimate_usd)}${m.cost_unit === "second" ? "/s" : ""}`,
              status(m.health_status),
              action(`/admin/generation/models/${m.id}/toggle`, m.enabled ? "Disable" : "Enable", { small: true, variant: m.enabled ? "ghost" : "primary" }),
            ]),
          ),
          { title },
        );
      })
      .join("");
    const body = `${header("Generation engine", { sub: "Every image and video goes through one engine: it picks a model by capability, cost, speed and health, falls back automatically, and stores results in your storage." })}
${genTabs("engine")}
${card(provTable, { title: "Providers", actions: link("Keys", "/admin/config#generation", { small: true, icon: "key" }) })}
${modelCards}`;
    return render(req, reply, { title: "Generation engine", active: "gen", body });
  });

  r.post("/admin/generation/providers/:id/test", async (req: Req, reply) => {
    try {
      const v = await validateProvider(req.params.id);
      return done(req, reply, "/admin/generation", `${req.params.id}: ${v.detail}`, v.ok);
    } catch (e) {
      return done(req, reply, "/admin/generation", `${req.params.id}: ${(e as Error).message}`, false);
    }
  });
  r.post("/admin/generation/providers/:id/toggle", async (req: Req, reply) => {
    const row = await one<{ enabled: boolean }>("UPDATE generation_providers SET enabled = NOT enabled, updated_at = now() WHERE id = $1 RETURNING enabled", [req.params.id]);
    return done(req, reply, "/admin/generation", row ? `${req.params.id} ${row.enabled ? "enabled" : "disabled"}` : "Unknown provider", Boolean(row));
  });
  r.post("/admin/generation/providers/:id/unquarantine", async (req: Req, reply) => {
    await one("UPDATE generation_providers SET quarantined_until = NULL, health_status = 'unknown', updated_at = now() WHERE id = $1", [req.params.id]);
    await one("UPDATE generation_models SET quarantined_until = NULL, health_status = 'unknown', updated_at = now() WHERE provider_id = $1", [req.params.id]);
    return done(req, reply, "/admin/generation", `${req.params.id} released from quarantine`);
  });
  r.post("/admin/generation/models/:id/toggle", async (req: Req, reply) => {
    const row = await one<{ enabled: boolean; model_id: string }>("UPDATE generation_models SET enabled = NOT enabled, updated_at = now() WHERE id = $1 RETURNING enabled, model_id", [Number(req.params.id)]);
    return done(req, reply, "/admin/generation", row ? `${row.model_id} ${row.enabled ? "enabled" : "disabled"}` : "Unknown model", Boolean(row));
  });

  // ------------------------------------------------------------ policy
  r.get("/admin/generation/policy", async (req: Req, reply) => {
    const id = influencerId();
    const [own, platform, models, states, soul] = await Promise.all([
      one("SELECT 1 FROM generation_policies WHERE influencer_id = $1", [id]),
      policyFor(0),
      listModels(),
      providerStates(),
      activeSoul(),
    ]);
    const policy = await policyFor(id);
    const usable = models.filter((m) => !m.deprecated);
    const opts: Array<[string, string]> = [["", "— none —"], ...usable.map((m): [string, string] => [String(m.id), `${label(m)}${states.get(m.provider_id)?.configured ? "" : " (no key)"}`])];
    const sample: GenerationRequest = {
      influencerId: id,
      idempotencyKey: "preview",
      purpose: "manual",
      modality: soul ? "reference_image" : "text_to_image",
      prompt: "preview",
      references: soul?.identityRefs ?? [],
      soul: soulContext(soul),
      aspectRatio: "4:5",
      quality: "high",
      identityConsistency: "high",
    };
    const preview = route(sample, policy, models, states);
    const form = (p: Policy, scope: "influencer" | "platform") => `<form method="post" action="/admin/generation/policy">
      <input type="hidden" name="scope" value="${scope}">
      <div class="cols">
      ${field("Routing mode", select("mode", ROUTING_MODES.map((m) => [m, m.replace(/_/g, " ")] as [string, string]), p.mode), { help: MODE_HELP[p.mode] })}
      ${field("Quality tier", select("qualityTier", ["draft", "standard", "high", "max"], p.qualityTier))}
      ${field("Max cost per job (USD)", input("maxCostPerJobUsd", p.maxCostPerJobUsd, { type: "number", attrs: 'step="0.01" min="0"' }), { help: "Models estimated above this are never tried." })}
      </div>
      <div class="cols">
      ${field("Preferred model", select("preferredModelId", opts, p.preferredModelId ?? ""))}
      ${[0, 1, 2].map((i) => field(`Fallback ${i + 1}`, select(`fallback${i}`, opts, p.fallbackModelIds[i] ?? ""))).join("")}
      </div>
      <fieldset style="border:0;padding:0;margin:0 0 12px"><legend class="small" style="font-weight:600;margin-bottom:6px">Allowed modalities</legend><div class="row">${MODALITIES.map(
        (m) => `<label class="row small"><input type="checkbox" name="modalities" value="${m}"${p.allowedModalities.includes(m) ? " checked" : ""}> ${m.replace(/_/g, " ")}</label>`,
      ).join("")}</div></fieldset>
      <div class="row">${button("Save policy", { variant: "primary", icon: "check" })}</div></form>
      ${scope === "influencer" && own ? `<div class="row" style="margin-top:8px">${action("/admin/generation/policy/reset", "Use platform default", { variant: "ghost", small: true })}</div>` : ""}`;
    const body = `${header("Routing policy", { sub: "How the engine chooses a model. The influencer policy overrides the platform default." })}
${genTabs("policy")}
<div class="grid-2">
<div>
${card(form(policy, "influencer"), { title: own ? "This influencer's policy" : "This influencer (inherits the platform default)" })}
${card(form(platform, "platform"), { title: "Platform default" })}
</div>
<div>
${card(
  `<p class="meta" style="margin-top:0">A ${sample.modality.replace(/_/g, " ")} job ${soul ? `with ${esc(soul.soul.soul_id)}` : ""} would try, in order:</p>
  ${preview.candidates.length ? `<ol class="stack" style="padding-left:18px;margin:0">${preview.candidates.map((c) => `<li><b>${esc(label(c.model))}</b> <span class="meta">score ${c.score} · ~${usd(c.estimatedCostUsd)} · ${esc(c.reason)}</span></li>`).join("")}</ol>` : `<div class="callout bad">${icon("alert")}<p>No model can take this job. Add a provider key in Config.</p></div>`}
  <details style="margin-top:12px"><summary>Why other models are skipped (${preview.excluded.length})</summary>${table(["Model", "Reason"], preview.excluded.map((x) => [`<code>${esc(x.model)}</code>`, esc(x.reason)]))}</details>`,
  { title: "Route preview (no spend)" },
)}
</div></div>`;
    return render(req, reply, { title: "Routing policy", active: "gen-policy", body });
  });
  r.post("/admin/generation/policy", async (req: Req, reply) =>
    attempt(req, reply, "/admin/generation/policy", async () => {
      const b = req.body ?? {};
      const scope = b.scope === "platform" ? 0 : influencerId();
      const mods = ([] as string[]).concat((b as unknown as Record<string, string | string[]>).modalities ?? []);
      const num = (v: string | undefined) => (v ? Number(v) : null);
      const mode = String(b.mode);
      if (!(ROUTING_MODES as readonly string[]).includes(mode)) throw new Error("unknown mode");
      await savePolicy(scope, {
        mode: mode as Policy["mode"],
        qualityTier: (["draft", "standard", "high", "max"].includes(b.qualityTier) ? b.qualityTier : "high") as Policy["qualityTier"],
        maxCostPerJobUsd: b.maxCostPerJobUsd?.trim() ? Math.max(0, Number(b.maxCostPerJobUsd)) : (await policyFor(scope)).maxCostPerJobUsd,
        preferredModelId: num(b.preferredModelId),
        fallbackModelIds: [b.fallback0, b.fallback1, b.fallback2].map(num).filter((x): x is number => x !== null),
        allowedModalities: mods.filter((m) => (MODALITIES as readonly string[]).includes(m)),
      });
      return scope === 0 ? "Platform policy saved" : "Policy saved";
    }),
  );
  r.post("/admin/generation/policy/reset", async (req: Req, reply) => {
    await one("DELETE FROM generation_policies WHERE influencer_id = $1", [influencerId()]);
    return done(req, reply, "/admin/generation/policy", "Now using the platform default");
  });

  // ------------------------------------------------------------ requests & failures
  r.get("/admin/generation/requests", async (req: Req, reply) => {
    const only = req.query.status === "failed" ? "failed" : "all";
    const rows = await many<{ id: string; purpose: string; modality: string; status: string; provider_id: string | null; model_id: string | null; attempts: number; cost_usd: number; error: string | null; created_at: Date }>(
      `SELECT id, purpose, modality, status, provider_id, model_id, attempts, cost_usd::float, error, created_at FROM generation_requests
       WHERE influencer_id = $1 AND ($2 = 'all' OR status = $2) ORDER BY created_at DESC LIMIT 150`,
      [influencerId(), only],
    );
    const fails = await many<{ provider: string; error_class: string; n: number }>(
      `SELECT provider, coalesce(error_class, 'unknown') AS error_class, count(*)::int AS n FROM generation_attempts
       WHERE influencer_id = $1 AND status = 'failed' AND created_at > now() - interval '7 days' GROUP BY 1, 2 ORDER BY n DESC`,
      [influencerId()],
    );
    const body = `${header("Jobs & failures", { sub: "Every generation request with its route, attempts and cost." })}
${genTabs("requests")}
${fails.length ? card(table(["Provider", "Failure class", "Count (7d)"], fails.map((f) => [esc(f.provider), pill(f.error_class), String(f.n)])), { title: "Failure breakdown" }) : ""}
${tabs([
  { href: "/admin/generation/requests", label: "All", active: only === "all" },
  { href: "/admin/generation/requests?status=failed", label: "Failed", active: only === "failed" },
])}
${card(
  table(
    ["When", "Purpose", "Modality", "Status", "Ran on", "Attempts", "Cost", ""],
    rows.map((x) => [
      ago(x.created_at),
      esc(x.purpose),
      esc(x.modality.replace(/_/g, " ")),
      pill(x.status === "succeeded" ? "done" : x.status),
      x.model_id ? `${esc(x.provider_id)} / <code>${esc(x.model_id)}</code>` : "—",
      String(x.attempts),
      usd(x.cost_usd),
      `<a href="/admin/generation/requests/${x.id}">Details</a>${x.error ? `<div class="meta">${esc(x.error.slice(0, 90))}</div>` : ""}`,
    ]),
    "No generation jobs yet.",
  ),
)}`;
    return render(req, reply, { title: "Generation jobs", active: "gen-requests", body });
  });
  r.get("/admin/generation/requests/:id", async (req: Req, reply) => {
    if (!isUuid(req.params.id)) return reply.code(404).send("not found");
    const x = await one<Record<string, any>>("SELECT * FROM generation_requests WHERE id = $1 AND influencer_id = $2", [req.params.id, influencerId()]);
    if (!x) return reply.code(404).send("not found");
    const [atts, assets] = await Promise.all([
      many<Record<string, any>>("SELECT * FROM generation_attempts WHERE request_id = $1 ORDER BY id", [x.id]),
      many<{ url: string; kind: string }>("SELECT url, kind FROM assets WHERE generation_request_id = $1", [x.id]),
    ]);
    const route = x.route as { mode?: string; candidates?: Array<{ model: string; score: number; estimatedCostUsd: number; reason: string }>; excluded?: Array<{ model: string; reason: string }> };
    const body = `${header(`${String(x.modality).replace(/_/g, " ")} request`, { eyebrow: String(x.purpose), sub: `${pill(x.status)} <code>${esc(x.idempotency_key)}</code> · ${ago(x.created_at)}` })}
${x.error ? `<div class="callout bad">${icon("alert")}<p>${esc(x.error)}</p></div>` : ""}
${assets.length ? card(`<div class="slides">${assets.map((a) => (a.kind === "video" ? `<figure><video src="${esc(a.url)}" controls style="height:320px;border-radius:12px"></video></figure>` : `<figure><img src="${esc(a.url)}" alt="result"></figure>`)).join("")}</div>`, { title: "Result" }) : ""}
<div class="grid">
${card(`<p class="meta" style="margin-top:0">Mode: <b>${esc(route.mode ?? "")}</b></p>${table(["#", "Model", "Score", "Est.", "Why"], (route.candidates ?? []).map((c, i) => [String(i + 1), `<code>${esc(c.model)}</code>`, String(c.score), usd(c.estimatedCostUsd), esc(c.reason)]))}<details><summary>Excluded (${(route.excluded ?? []).length})</summary>${table(["Model", "Reason"], (route.excluded ?? []).map((e) => [`<code>${esc(e.model)}</code>`, esc(e.reason)]))}</details>`, { title: "Route" })}
${card(table(["#", "Provider / model", "Status", "Provider id", "Latency", "Cost", "Error"], atts.map((a) => [String(a.attempt), `${esc(a.provider)} / <code>${esc(a.model)}</code>`, pill(a.status), `<code class="small">${esc(a.provider_request_id ?? "—")}</code>`, a.latency_ms ? `${Math.round(a.latency_ms / 1000)}s` : "—", a.cost_usd !== null ? usd(Number(a.cost_usd)) : "—", a.error ? `${a.error_class ? pill(a.error_class) : ""} <span class="small">${esc(a.error)}</span>` : ""])), { title: "Attempts" })}
</div>
${card(`<pre>${esc(JSON.stringify(x.request, null, 2))}</pre>`, { title: "Request" })}`;
    return render(req, reply, { title: "Generation request", active: "gen-requests:detail", body });
  });

  // ------------------------------------------------------------ assets
  r.get("/admin/generation/assets", async (req: Req, reply) => {
    const rows = await many<{ id: string; url: string; kind: string; provider: string | null; model: string | null; created_at: Date; generation_request_id: string | null; width: number | null; height: number | null }>(
      "SELECT id, url, kind, provider, model, created_at, generation_request_id, width, height FROM assets WHERE influencer_id = $1 ORDER BY created_at DESC LIMIT 120",
      [influencerId()],
    );
    const body = `${header("Assets", { sub: "Everything generated for this influencer, stored durably in your own storage (never the provider's expiring links)." })}
${genTabs("assets")}
${card(
  rows.length
    ? `<div class="thumbs">${rows
        .map(
          (a) =>
            `<figure>${a.kind === "video" ? `<video src="${esc(a.url)}" muted playsinline preload="metadata" style="width:100%;aspect-ratio:4/5;object-fit:cover;border-radius:12px"></video>` : `<a href="${esc(a.url)}" target="_blank" rel="noopener"><img src="${esc(a.url)}" alt="" loading="lazy"></a>`}
            <div class="cap"><span>${esc(a.provider ?? "")} ${a.width ? `${a.width}×${a.height}` : ""}</span>${a.generation_request_id ? `<a href="/admin/generation/requests/${a.generation_request_id}" class="small">job</a>` : ""}</div><div class="meta">${esc(a.model ?? "")} · ${ago(a.created_at)}</div></figure>`,
        )
        .join("")}</div>`
    : empty("No assets yet"),
)}`;
    return render(req, reply, { title: "Assets", active: "gen-assets", body });
  });

  // ------------------------------------------------------------ benchmarks
  r.get("/admin/generation/benchmarks", async (req: Req, reply) => {
    const [models, results] = await Promise.all([listModels(), benchmarkResults()]);
    const candidates = models.filter((m) => !m.deprecated && m.enabled && (m.capabilities.includes("reference_image") || m.capabilities.includes("soul") || m.capabilities.includes("text_to_image")) && m.provider_id !== "mock");
    const plan = await planBenchmark(candidates.map((m) => m.id));
    const runnable = new Map(plan.models.map((x) => [x.model.id, x.estimate]));
    const agg = new Map<string, { n: number; overall: number; identity: number; cost: number }>();
    for (const x of results.filter((y) => y.status === "succeeded")) {
      const a = agg.get(x.model) ?? { n: 0, overall: 0, identity: 0, cost: 0 };
      a.n++;
      a.overall += Number(x.scores.overall ?? 0);
      a.identity += Number(x.scores.identity ?? 0);
      a.cost += Number(x.cost_usd);
      agg.set(x.model, a);
    }
    const body = `${header("Benchmarks", { sub: `The same ${SUITE.length}-shot suite (portrait, outfit, detail) through each model, judged by the vision model against this influencer's soul. Results update the router's scores.` })}
${genTabs("bench")}
<div class="grid-2">
${card(
  candidates.length
    ? `<form method="post" action="/admin/generation/benchmarks/run">
      <div class="stack" style="margin-bottom:12px">${candidates
        .map((m) => {
          const est = runnable.get(m.id);
          const skip = plan.skipped.find((s) => s.model === `${m.provider_id}/${m.model_id}`);
          return `<label class="row"><input type="checkbox" name="models" value="${m.id}"${est === undefined ? " disabled" : ""}> <b>${esc(label(m))}</b> <span class="meta">${est !== undefined ? `~${usd(est)} for the suite` : esc(skip?.reason ?? "")}</span></label>`;
        })
        .join("")}</div>
      ${field("Budget cap for this run (USD)", input("maxUsd", "2", { type: "number", attrs: 'step="0.1" min="0.1"' }), { help: "The run refuses to start if the estimate is above this. Spend also counts toward the influencer's image budget." })}
      ${button("Run benchmark", { variant: "primary", icon: "gauge" })}</form>`
    : empty("No models to benchmark", "Add a provider key in Config first."),
  { title: "Run" },
)}
${card(
  agg.size
    ? table(
        ["Model", "Shots", "Overall", "Identity", "Cost"],
        [...agg.entries()].map(([m, a]) => [`<code>${esc(m)}</code>`, String(a.n), (a.overall / a.n).toFixed(1), (a.identity / a.n).toFixed(1), usd(a.cost)]),
      )
    : empty("No results yet"),
  { title: "Leaderboard" },
)}
</div>
${card(
  results.length
    ? `<div class="thumbs">${results
        .map(
          (x) =>
            `<figure>${x.asset_url ? `<img src="${esc(x.asset_url)}" alt="${esc(x.case_id)}" loading="lazy">` : `<div class="empty" style="aspect-ratio:4/5;border:1px dashed var(--line-2);border-radius:12px">${icon("x")}</div>`}
            <div class="cap"><span>${esc(x.case_id)}</span>${x.status === "succeeded" ? `<b>${x.scores.overall ?? "?"}</b>` : pill("failed")}</div><div class="meta"><code>${esc(x.model)}</code> · ${x.latency_ms ? `${Math.round(x.latency_ms / 1000)}s` : ""} ${x.error ? esc(x.error.slice(0, 60)) : ""}</div></figure>`,
        )
        .join("")}</div>`
    : empty("Nothing run yet"),
  { title: "Recent shots" },
)}`;
    return render(req, reply, { title: "Benchmarks", active: "gen-bench", body });
  });
  r.post("/admin/generation/benchmarks/run", async (req: Req, reply) =>
    attempt(req, reply, "/admin/generation/benchmarks", async () => {
      const ids = ([] as string[]).concat((req.body as unknown as Record<string, string | string[]>)?.models ?? []).map(Number).filter(Number.isFinite);
      if (!ids.length) throw new Error("pick at least one model");
      const maxUsd = Math.max(0.1, Number(req.body?.maxUsd ?? 2));
      const plan = await planBenchmark(ids);
      if (plan.estimate > maxUsd) throw new Error(`estimated $${plan.estimate.toFixed(2)} is over your $${maxUsd.toFixed(2)} cap`);
      const tag = String(Date.now());
      await queue("content").add(JOBS.benchmarkRun, { influencerId: influencerId(), modelIds: ids, maxUsd, tag }, { jobId: jobId("bench", influencerId(), tag), attempts: 1 });
      return `Benchmark queued: ${plan.models.length} model(s), ~$${plan.estimate.toFixed(2)}. Results appear here as shots finish.`;
    }),
  );
}
