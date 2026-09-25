import type { FastifyInstance } from "fastify";
import { currentInfluencer } from "../../context.js";
import { composeProfileText, generateProfilePicture, getKit, LIMITS, profilePictureFromSoul } from "../../influencers/profile.js";
import { primaryAccount } from "../../instagram/accounts.js";
import { activeSoul } from "../../souls/souls.js";
import { attempt, consoleRouter, render, type Req } from "../console.js";
import { action, card, empty, esc, header, icon, link } from "../ui/kit.js";

function copyable(id: string, text: string, limit?: number): string {
  const n = [...text].length;
  return `<div class="copy-row"><pre id="${esc(id)}">${esc(text)}</pre><div class="row"><button type="button" class="btn sm" data-copy="${esc(id)}">${icon("check", 14)}<span>Copy</span></button>${
    limit ? `<span class="meta">${n}/${limit}</span>` : ""
  }</div></div>`;
}

/** Shared body for the Profile page and the Hatch "Profile" step. `base` is where the action forms post. */
export async function profileKitBody(base: string): Promise<string> {
  const inf = currentInfluencer();
  const [kit, soul, acct] = await Promise.all([getKit(), activeSoul(), primaryAccount()]);
  const t = kit.text;
  const pics = kit.pictures ?? [];
  const textCard = t
    ? `<h3 class="small" style="margin:0 0 6px">Name <span class="meta">(Edit profile → Name; searchable, so it carries a keyword)</span></h3>${copyable("kit-name", t.display_name, LIMITS.name)}
       <h3 class="small" style="margin:14px 0 6px">Bio: pick one <span class="meta">(Edit profile → Bio)</span></h3>
       ${t.bios.map((b, i) => `<div style="margin-bottom:10px"><span class="pill">${esc(b.style)}</span>${copyable(`kit-bio-${i}`, b.text, LIMITS.bio)}</div>`).join("")}
       <div class="cols">
         <div><h3 class="small" style="margin:0 0 6px">Username ideas</h3>${t.usernames.map((u, i) => copyable(`kit-user-${i}`, u, LIMITS.username)).join("")}</div>
         <div><h3 class="small" style="margin:0 0 6px">Highlights</h3>${t.highlights.map((h, i) => copyable(`kit-hl-${i}`, h, LIMITS.highlight)).join("")}</div>
       </div>
       <dl class="kv" style="margin-top:12px"><dt>Category</dt><dd>${esc(t.category)} <span class="meta">(Edit profile → Category)</span></dd><dt>Link</dt><dd>${esc(t.link_idea)}</dd><dt>First story</dt><dd>${esc(t.first_story)}</dd></dl>`
    : empty("No profile text yet", "Write it from the persona in a few seconds.");

  const picCard = soul
    ? `${
        pics.length
          ? `<div class="pp-grid">${pics
              .map(
                (p, i) =>
                  `<figure><img class="pp-circle" src="${esc(p.url)}" alt="Profile picture option ${i + 1}" width="120" height="120"><img class="pp-small" src="${esc(p.url)}" alt="" width="40" height="40">
                  <figcaption><span class="pill">${p.kind === "generated" ? "designed" : "face crop"}</span> ${link("Download", p.url, { small: true, variant: "ghost", external: true })}</figcaption></figure>`,
              )
              .join("")}</div><p class="help">Shown at the real sizes Instagram uses: the profile circle and a tiny comment avatar. Save the image, then Edit profile → Edit picture.</p>`
          : empty("No profile picture yet", "Make one from the chosen face.")
      }
      <div class="row" style="margin-top:12px">${action(`${base}/picture/crop`, "Crop from the soul face (free)", { icon: "image", small: true })}${action(`${base}/picture/generate`, "Design a new headshot (1 image)", {
        icon: "sparkles",
        small: true,
        variant: "primary",
      })}</div>`
    : empty("Choose a soul face first", "The profile picture is made from the soul.");

  return `<div class="callout">${icon("info")}<p>Instagram's API can't change a profile's name, bio or photo, so these are ready to paste in the Instagram app: <b>Profile → Edit profile</b>.${
    acct ? ` Account: <b>@${esc(acct.username ?? acct.ig_user_id)}</b>.` : ""
  }</p></div>
<div class="grid-2">
${card(textCard, { title: `${inf.name}'s profile text`, actions: action(`${base}/text`, t ? "Rewrite" : "Write profile text", { icon: "wand", small: true, variant: t ? "ghost" : "primary" }) })}
${card(picCard, { title: "Profile picture" })}
</div>`;
}

export const PROFILE_CSS = `<style>
.copy-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:start;margin-bottom:6px}.copy-row pre{margin:0;padding:8px 10px;font-family:var(--font);font-size:14px;max-height:none}
.pp-grid{display:flex;flex-wrap:wrap;gap:18px}.pp-grid figure{margin:0;display:grid;justify-items:center;gap:8px}
.pp-circle{width:120px;height:120px;border-radius:50%;object-fit:cover;border:1px solid var(--line)}.pp-small{width:40px;height:40px;border-radius:50%;object-fit:cover}
.pp-grid figcaption{display:flex;gap:6px;align-items:center}
</style>`;

export function registerProfile(app: FastifyInstance): void {
  const r = consoleRouter(app);
  r.get("/admin/profile", async (req: Req, reply) => {
    const body = `${header("Profile kit", { eyebrow: currentInfluencer().name, sub: "Everything to paste into the Instagram profile, plus a profile picture made from the soul face." })}${await profileKitBody("/admin/profile")}`;
    return render(req, reply, { title: "Profile kit", active: "profile", body, head: PROFILE_CSS });
  });
  r.post("/admin/profile/text", async (req: Req, reply) =>
    attempt(req, reply, "/admin/profile", async () => {
      await composeProfileText();
      return "Profile text written";
    }),
  );
  r.post("/admin/profile/picture/crop", async (req: Req, reply) =>
    attempt(req, reply, "/admin/profile", async () => {
      await profilePictureFromSoul();
      return "Profile picture cropped from the soul face";
    }),
  );
  r.post("/admin/profile/picture/generate", async (req: Req, reply) =>
    attempt(req, reply, "/admin/profile", async () => {
      await generateProfilePicture();
      return "New profile headshot designed";
    }),
  );
}
