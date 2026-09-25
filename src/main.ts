import type { Worker } from "bullmq";
import { env } from "./config/env.js";
import { closeDb } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { bootstrap } from "./bootstrap.js";
import { listInfluencers } from "./context.js";
import { VERSION } from "./version.js";
import { recordEvent } from "./lib/events.js";
import { logger } from "./lib/logger.js";
import { createDevLLM } from "./llm/devMock.js";
import { setLLM } from "./llm/llm.js";
import { closeQueues } from "./queue/queues.js";
import { startWorkers, upsertSchedulers } from "./queue/worker.js";
import { buildServer } from "./web/server.js";

/**
 * One binary, three roles (see docs/ARCHITECTURE.md):
 *   ROLE=web     webhooks + admin dashboard (Railway service "web")
 *   ROLE=worker  BullMQ workers + schedulers (Railway service "worker")
 *   ROLE=all     both, for local development or a single small service
 */
async function main(): Promise<void> {
  const e = env();
  if (e.LLM_PROVIDER === "mock") {
    if (e.NODE_ENV === "production") throw new Error("LLM_PROVIDER=mock is not allowed in production");
    setLLM(createDevLLM());
  }

  await migrate();
  const boot = await bootstrap();

  let workers: Worker[] = [];
  let server: Awaited<ReturnType<typeof buildServer>> | undefined;

  if (e.ROLE === "worker" || e.ROLE === "all") {
    workers = startWorkers();
    await upsertSchedulers();
  }
  if (e.ROLE === "web" || e.ROLE === "all") {
    server = await buildServer();
    await server.listen({ port: e.PORT, host: "0.0.0.0" });
    logger.info({ port: e.PORT, url: e.PUBLIC_BASE_URL }, "web listening");
  }
  await recordEvent("info", "boot", `Started v${VERSION} (${e.ROLE})`, { ...boot, influencers: (await listInfluencers(["active"])).length });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "shutting down");
    // Stop taking new work, let active jobs finish (BullMQ waits for them).
    await Promise.allSettled([server?.close(), ...workers.map((w) => w.close())]);
    await closeQueues();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err }, "fatal boot error");
  process.exit(1);
});
