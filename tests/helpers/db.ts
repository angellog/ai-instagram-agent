import { closeDb, db } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";
import { invalidateControls, setControls, type Controls } from "../../src/config/controls.js";
import { closeQueues, redis } from "../../src/queue/queues.js";
import { setInstagramClient, upsertAccount } from "../../src/instagram/accounts.js";
import { setImageGenerator } from "../../src/kie/generator.js";
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
  invalidateControls();
  setInstagramClient(undefined);
  setImageGenerator(undefined);
  setLLM(createDevLLM());
  await setControls({ mode: "autonomous", optional_reply_rate: 1, posting_window_start_hour: 0, posting_window_end_hour: 24, ...controls }, "test");
  await upsertAccount({ igUserId: TEST_IG_ID, username: "zuri.test", accessToken: "test-token", expiresAt: new Date(Date.now() + 50 * 86400_000), makePrimary: true });
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
