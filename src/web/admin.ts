import type { FastifyInstance } from "fastify";
import { endSession } from "../auth/users.js";
import { registerCalendar } from "./pages/calendar.js";
import { registerGeneration } from "./pages/generation.js";
import { registerHatch } from "./pages/hatch.js";
import { registerIdentity } from "./pages/identity.js";
import { registerOperate } from "./pages/operate.js";
import { registerPlatform } from "./pages/platform.js";
import { registerProfile } from "./pages/profile.js";
import { registerCreate } from "./pages/create.js";
import { registerLibrary } from "./pages/library.js";
import { registerUsers } from "./pages/users.js";
import { registerInterview } from "./pages/interview.js";
import { registerTimeline } from "./pages/timeline.js";
import { registerEngagement } from "./pages/engagement.js";
import { registerTrends } from "./pages/trends.js";
import { registerStandard } from "./pages/standard.js";
import { registerTikTok } from "./pages/tiktok.js";
import { registerX } from "./pages/x.js";

export { selectedInfluencer } from "./console.js";
export { rerunInteraction } from "./pages/operate.js";
export { removeSlide } from "../content/edit.js";

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
  registerProfile(app);
  registerCreate(app);
  registerLibrary(app);
  registerUsers(app);
  registerInterview(app);
  registerTimeline(app);
  registerEngagement(app);
  registerTrends(app);
  registerStandard(app);
  registerTikTok(app);
  registerX(app);
  registerHatch(app);
  app.get("/admin/logout", async (req, reply) => {
    const t = /(?:^|;\s*)aia_user=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    if (t) await endSession(decodeURIComponent(t));
    reply.header("set-cookie", ["aia_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax", "aia_user=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax", "aia_inf=; Path=/; Max-Age=0; SameSite=Lax"]);
    return reply.redirect("/admin/login", 303);
  });
}
