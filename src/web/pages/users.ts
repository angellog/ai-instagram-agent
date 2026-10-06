import type { FastifyInstance } from "fastify";
import { inviteUser, listUsers, reissueInvite, setUserStatus } from "../../auth/users.js";
import { env } from "../../config/env.js";
import { allInfluencers } from "../../influencers/manage.js";
import { errorMessage } from "../../lib/errors.js";
import { attempt, consoleRouter, render, reviewer, type Req } from "../console.js";
import { action, ago, button, card, esc, field, header, icon, input, pill, table } from "../ui/kit.js";

/**
 * Team & access (admin only): who can sign in, and to which influencer. A tenant
 * user sees one influencer's dashboard and nothing else. Invite links are shown
 * once, on this page, never put in a URL or a log.
 */

const link = (token: string) => `${env().PUBLIC_BASE_URL.replace(/\/$/, "")}/admin/invite/${token}`;

function inviteShown(email: string, url: string): string {
  return `<div class="callout ok" role="status">${icon("check")}<div><p><b>Invite ready for ${esc(email)}.</b> Send them this link (it works once, for 7 days). It won't be shown again.</p>
<div class="row" style="margin-top:8px"><input readonly value="${esc(url)}" id="invite-url" style="flex:1;min-width:240px" onfocus="this.select()"><button class="btn sm" type="button" onclick="navigator.clipboard.writeText(document.getElementById('invite-url').value);window.aiaToast&&aiaToast('Link copied')">${icon("check", 14)}<span>Copy</span></button></div></div></div>`;
}

export function registerUsers(app: FastifyInstance): void {
  const r = consoleRouter(app);

  const page = async (req: Req, reply: Parameters<Parameters<typeof r.get>[1]>[1], shown = "") => {
    const [users, infs] = await Promise.all([listUsers(), allInfluencers()]);
    const live = infs.filter((i) => i.status !== "archived");
    const body = `${header("Team & access", { sub: "Who can sign in. A tenant user belongs to one influencer and sees only that influencer's dashboard: no other influencers, no platform settings. Admins see everything and onboard new influencers." })}
${shown}
${card(
  `<form method="post" action="/admin/users" class="cols" autocomplete="off">
  ${field("Email", input("email", "", { type: "email", attrs: "required", placeholder: "owner@business.ug" }), { required: true })}
  ${field("Name", input("name", "", { placeholder: "optional" }))}
  ${field("Access", `<select name="influencer_id" required><option value="">— choose —</option>${live.map((i) => `<option value="${i.id}">${esc(i.name)}'s business (tenant)</option>`).join("")}<option value="admin">Admin (everything)</option></select>`, { required: true, help: "Tenants see one influencer. Admins see all and can hatch." })}
  <div style="align-self:end">${button("Create invite link", { variant: "primary", icon: "plus" })}</div>
</form>`,
  { title: "Invite someone" },
)}
${card(
  table(
    ["Person", "Access", "Status", "Last sign-in", ""],
    users.map((u) => [
      `<b>${esc(u.name || u.email)}</b>${u.name ? `<div class="meta">${esc(u.email)}</div>` : ""}`,
      u.role === "admin" ? `<span class="pill info">admin</span>` : `${esc(u.influencer_name ?? "?")}`,
      pill(u.status === "active" ? "active" : u.status === "invited" ? "awaiting_review" : "disabled").replace(/>[^<]*</, `>${u.status}<`),
      u.last_login_at ? ago(u.last_login_at) : `<span class="muted">never</span>`,
      `<div class="row">${action(`/admin/users/${u.id}/invite`, u.status === "invited" ? "New link" : "Reset password", { small: true, variant: "ghost" })}${
        u.status === "disabled" ? action(`/admin/users/${u.id}/status`, "Enable", { small: true, fields: { status: "active" } }) : action(`/admin/users/${u.id}/status`, "Disable", { small: true, variant: "danger", fields: { status: "disabled" }, confirm: `Sign ${u.email} out everywhere and block their access?` })
      }</div>`,
    ]),
    "No users yet. The admin token still signs you in as admin.",
  ),
  { title: "People with access" },
)}`;
    return render(req, reply, { title: "Team & access", active: "users", body });
  };

  r.get("/admin/users", (req, reply) => page(req, reply), { platform: true });

  r.post(
    "/admin/users",
    async (req: Req, reply) => {
      const b = (req.body ?? {}) as Record<string, string>;
      try {
        const admin = b.influencer_id === "admin";
        const { user, inviteToken } = await inviteUser({ email: b.email ?? "", name: b.name, role: admin ? "admin" : "tenant", influencerId: admin ? null : Number(b.influencer_id), by: reviewer(req) });
        return page(req, reply, inviteShown(user.email, link(inviteToken)));
      } catch (e) {
        return page(req, reply, `<div class="callout bad" role="alert">${icon("alert")}<p>${esc(errorMessage(e))}</p></div>`);
      }
    },
    { platform: true },
  );

  r.post(
    "/admin/users/:id/invite",
    async (req: Req, reply) => {
      const users = await listUsers();
      const u = users.find((x) => x.id === Number(req.params.id));
      if (!u) return reply.code(404).send("not found");
      return page(req, reply, inviteShown(u.email, link(await reissueInvite(u.id))));
    },
    { platform: true },
  );

  r.post(
    "/admin/users/:id/status",
    async (req: Req, reply) =>
      attempt(req, reply, "/admin/users", async () => {
        const status = req.body?.status === "disabled" ? "disabled" : "active";
        await setUserStatus(Number(req.params.id), status);
        return status === "disabled" ? "Access removed; signed out everywhere" : "Access restored";
      }),
    { platform: true },
  );
}
