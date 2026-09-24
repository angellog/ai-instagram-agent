import { getControls, setControls, type Controls } from "./config/controls.js";
import { env, kieKeys } from "./config/env.js";
import { spendSummary } from "./cost/ledger.js";
import { closeDb, one } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { instagramClient, primaryAccount, seedAccountFromEnv } from "./instagram/accounts.js";
import { KieClient } from "./kie/client.js";
import { createDevLLM } from "./llm/devMock.js";
import { setLLM } from "./llm/llm.js";
import { loadPersonaFromFile } from "./persona/loader.js";
import { planContent } from "./content/director.js";
import { producePost } from "./content/produce.js";
import { publishPost } from "./content/publish.js";
import { closeQueues, queueCounts } from "./queue/queues.js";
import { sweep } from "./queue/sweeper.js";
import { storeWebhookEvent } from "./ingest/webhook.js";
import { processWebhookEvent } from "./ingest/process.js";
import { processInteraction } from "./conversation/agent.js";
import { many } from "./db/pool.js";

const HELP = `ai-instagram-agent CLI

  npm run cli -- status                      mode, account, spend, queues
  npm run cli -- persona:check [path]        validate a persona YAML
  npm run cli -- ig:check                    token, profile, publishing quota
  npm run cli -- kie:credits                 kie.ai balance per key
  npm run cli -- controls                    print controls
  npm run cli -- controls:set key=value ...  change controls (e.g. mode=dry_run paused=false)
  npm run cli -- simulate "<text>" [--dm] [--user name]   run one interaction inline (never sent)
  npm run cli -- plan                        run the content director once, inline
  npm run cli -- produce <postId>            produce a post inline
  npm run cli -- publish <postId>            publish an approved post inline
  npm run cli -- sweep                       re-queue stalled work
`;

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(HELP);
    return;
  }
  if (cmd === "persona:check") {
    const p = loadPersonaFromFile(args[0]);
    console.log(`OK: ${p.persona.identity.name} (${p.hash}), ${p.persona.daily_life.activities.length} activities, ${p.persona.visual.locations.length} locations`);
    return;
  }

  if (env().LLM_PROVIDER === "mock") setLLM(createDevLLM());
  await migrate();
  await seedAccountFromEnv();

  switch (cmd) {
    case "status": {
      const [c, s, q, a] = await Promise.all([getControls(), spendSummary(), queueCounts().catch(() => "redis unavailable"), primaryAccount()]);
      console.log(JSON.stringify({ mode: c.mode, paused: c.paused, account: a ? { id: a.ig_user_id, username: a.username, expires: a.token_expires_at } : null, spend: s, queues: q }, null, 2));
      break;
    }
    case "ig:check": {
      const ig = await instagramClient();
      const [profile, quota] = await Promise.all([ig.getProfile(), ig.getPublishingLimit()]);
      console.log(JSON.stringify({ profile, quota }, null, 2));
      break;
    }
    case "kie:credits": {
      const k = new KieClient({ keys: kieKeys(), baseUrl: env().KIE_BASE_URL });
      console.log((await k.credits()).map((c, i) => `key ${i + 1}: ${Number.isNaN(c) ? "error" : c} credits`).join("\n"));
      break;
    }
    case "controls":
      console.log(JSON.stringify(await getControls(true), null, 2));
      break;
    case "controls:set": {
      const patch: Record<string, unknown> = {};
      for (const a of args) {
        const [k, v] = a.split("=");
        patch[k] = v === "true" ? true : v === "false" ? false : Number.isFinite(Number(v)) && v !== "" ? Number(v) : v;
      }
      console.log(JSON.stringify(await setControls(patch as Partial<Controls>, "cli"), null, 2));
      break;
    }
    case "simulate": {
      const text = args.find((a) => !a.startsWith("--")) ?? "Hey! Which pair would you pick for a long walk?";
      const ui = args.indexOf("--user");
      const user = ui >= 0 ? args[ui + 1] : "cli_tester";
      const acct = (await primaryAccount())?.ig_user_id ?? "17840000000000000";
      const now = Date.now();
      const payload = args.includes("--dm")
        ? { object: "instagram", entry: [{ id: acct, time: now / 1000, messaging: [{ sender: { id: `sim_${user}` }, recipient: { id: acct }, timestamp: now, message: { mid: `sim_mid_${now}`, text } }] }] }
        : { object: "instagram", entry: [{ id: acct, time: now / 1000, changes: [{ field: "comments", value: { id: `sim_c_${now}`, text, from: { id: `sim_${user}`, username: user }, media: { id: "sim_media" } } }] }] };
      const raw = JSON.stringify(payload);
      const ev = await storeWebhookEvent("simulated", raw, payload);
      await processWebhookEvent(ev!.id);
      const it = await one<{ id: number }>("SELECT id FROM interactions WHERE webhook_event_id = $1", [ev!.id]);
      const outcome = await processInteraction(it!.id);
      const out = await many("SELECT channel, text, status FROM messages WHERE interaction_id = $1 AND direction = 'out'", [it!.id]);
      const d = await one("SELECT intent, action, reason, safety_level FROM agent_decisions WHERE subject_type = 'interaction' AND subject_id = $1 ORDER BY id DESC LIMIT 1", [String(it!.id)]);
      console.log(JSON.stringify({ outcome, decision: d, reply: out }, null, 2));
      break;
    }
    case "plan":
      console.log(JSON.stringify(await planContent(), null, 2));
      break;
    case "produce":
      console.log(await producePost(args[0]));
      break;
    case "publish":
      console.log(await publishPost(args[0]));
      break;
    case "sweep":
      console.log(await sweep());
      break;
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeQueues().catch(() => {});
    await closeDb().catch(() => {});
  });
