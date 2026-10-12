import { closeDb, db } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";
import { invalidateControls, setControls, type Controls } from "../../src/config/controls.js";
import { closeQueues, redis } from "../../src/queue/queues.js";
import { setInstagramClient, upsertAccount } from "../../src/instagram/accounts.js";
import { bootstrap } from "../../src/bootstrap.js";
import { invalidateInfluencer, loadInfluencer, setFallbackInfluencer } from "../../src/context.js";
import { invalidateSettings, setSetting } from "../../src/config/settings.js";
import { setStorageFetch } from "../../src/storage/host.js";
import { setGenerationFetch } from "../../src/generation/adapters/http.js";
import { MockAdapter } from "../../src/generation/adapters/mock.js";
import { setPollDelays } from "../../src/generation/service.js";
import { setLLM } from "../../src/llm/llm.js";
import { createDevLLM } from "../../src/llm/devMock.js";

let migrated = false;

export const TEST_IG_ID = "17841400000000001";

/** Fresh schema state for each test: every table truncated, Redis test db flushed. */
export async function resetState(controls: Partial<Controls> = {}): Promise<void> {
  if (!migrated) {
    await migrate();
    migrated = true;
  }
  const tables = (
    await db().query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'")
  ).rows.map((r) => `"${r.tablename}"`);
  await db().query(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
  await redis().flushdb();
  // Influencer #1 exactly as a fresh v1 install creates it: persona from config/persona.yaml, soul, catalog, policy.
  await db().query("INSERT INTO influencers (id, slug, name, status, hatched_at) VALUES (1, 'default', 'Default', 'active', now())");
  await db().query("SELECT setval('influencers_id_seq', 1)");
  invalidateInfluencer();
  invalidateSettings();
  invalidateControls();
  setFallbackInfluencer(undefined);
  await bootstrap();
  setFallbackInfluencer(await loadInfluencer(1, true));
  setInstagramClient(undefined);
  setGenerationFetch(undefined);
  setPollDelays([1]);
  MockAdapter.reset();
  setLLM(createDevLLM());
  await setControls({ mode: "autonomous", optional_reply_rate: 1, posting_window_start_hour: 0, posting_window_end_hour: 24, ...controls }, "test");
  await upsertAccount({ influencerId: 1, igUserId: TEST_IG_ID, username: "zuri.test", accessToken: "test-token", expiresAt: new Date(Date.now() + 50 * 86400_000), makePrimary: true });
}

/** Route generation through an in-memory kie.ai: key set in-app (Config page), all provider HTTP faked. */
export async function useFakeKie(fk: { fetch: (input: string | URL, init?: RequestInit) => Promise<Response> }): Promise<void> {
  await setSetting("KIE_API_KEY", "k1", "test");
  setGenerationFetch(fk.fetch);
  setStorageFetch(fk.fetch);
}

export async function teardown(): Promise<void> {
  await closeQueues();
  await closeDb();
}

export async function waitFor<T>(fn: () => T | undefined | null | false | Promise<T | undefined | null | false>, { timeoutMs = 20_000, intervalMs = 100, label = "condition" } = {}): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
