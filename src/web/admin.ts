import type { FastifyInstance } from "fastify";
import { registerCalendar } from "./pages/calendar.js";
import { registerGeneration } from "./pages/generation.js";
import { registerHatch } from "./pages/hatch.js";
import { registerIdentity } from "./pages/identity.js";
import { registerOperate } from "./pages/operate.js";
import { registerPlatform } from "./pages/platform.js";

export { selectedInfluencer } from "./console.js";
export { removeSlide, rerunInteraction } from "./pages/operate.js";

/**
 * The operator console (docs/design/HANDOFF.md). Server-rendered pages with a
 * little progressive-enhancement JS; every influencer-scoped page runs inside
 * the selected influencer's context (see console.ts).
 */
export function registerAdmin(app: FastifyInstance): void {
  registerOperate(app);
  registerIdentity(app);
  registerCalendar(app);
  registerGeneration(app);
  registerPlatform(app);
  registerHatch(app);
  app.get("/admin/logout", async (_req, reply) => {
    reply.header("set-cookie", "aia_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax");
    return reply.redirect("/admin/login", 303);
  });
}
