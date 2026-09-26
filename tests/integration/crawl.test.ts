import type { Job } from "bullmq";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEvent } from "../../src/calendar/events.js";
import { withInfluencer } from "../../src/context.js";
import { one } from "../../src/db/pool.js";
import { createInfluencer } from "../../src/influencers/manage.js";
import { setInstagramClient } from "../../src/instagram/accounts.js";
import { processWebhookEvent } from "../../src/ingest/process.js";
import { storeWebhookEvent } from "../../src/ingest/webhook.js";
import { processInteraction } from "../../src/conversation/agent.js";
import { JOBS } from "../../src/queue/queues.js";
import { HANDLERS } from "../../src/queue/worker.js";
import { setStorageFetch } from "../../src/storage/host.js";
import { buildServer } from "../../src/web/server.js";
import { commentPayload, FakeInstagram } from "../helpers/fakeInstagram.js";
import { resetState, teardown } from "../helpers/db.js";

/**
 * "Press every button": visit every console page reachable from the nav,
 * follow every internal link, and submit every POST form with the values the
 * page itself pre-fills. Any 5xx, broken link or leaked "undefined" fails.
 */
let app: FastifyInstance;
beforeAll(async () => {
  await resetState({ mode: "human_approval" });
  setInstagramClient(new FakeInstagram().client());
  const jpeg = await sharp({ create: { width: 900, height: 1100, channels: 3, background: { r: 120, g: 90, b: 70 } } }).jpeg().toBuffer();
  setStorageFetch(async () => new Response(new Uint8Array(jpeg), { status: 200, headers: { "content-type": "image/jpeg" } }));
  app = await buildServer();
  // Data so every page has real rows and forms: a created post, a conversation, a person, an event, a hatching influencer.
  const r = await app.inject({ method: "POST", url: "/admin/create", headers: { accept: "application/json" } });
  await HANDLERS[JOBS.contentCreate]({ name: JOBS.contentCreate, data: { influencerId: 1, runId: r.json().id } } as unknown as Job);
  const payload = commentPayload({ commentId: "crawl1", text: "Which pair for a rainy day?" });
  const ev = await storeWebhookEvent("meta", JSON.stringify(payload), payload);
  await processWebhookEvent(ev!.id);
  const it = await one<{ id: number }>("SELECT id FROM interactions");
  await processInteraction(it!.id);
  await withInfluencer(1, () => createEvent({ title: "Crawl fest", starts_at: new Date(Date.now() - 86400_000) }));
  await createInfluencer({ name: "Crawly" });
});
afterAll(async () => {
  await app?.close();
  setStorageFetch(fetch);
  await teardown();
});

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const SKIP_LINK = /^\/admin\/(logout|connect)|^\/media\/|\/api\//;

interface FormSpec {
  page: string;
  action: string;
  fields: URLSearchParams;
  async: boolean;
}

function formsOf(page: string, html: string): FormSpec[] {
  const out: FormSpec[] = [];
  for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)) {
    const attrs = m[1];
    if (!/method="post"/i.test(attrs) || /data-dynamic/.test(attrs)) continue; // dynamic forms get their action from JS
    const action = decode(/action="([^"]+)"/.exec(attrs)?.[1] ?? page).split("#")[0];
    if (!action.startsWith("/admin")) continue;
    const f = new URLSearchParams();
    const body = m[2];
    for (const i of body.matchAll(/<input\b([^>]*)>/g)) {
      const a = i[1];
      const name = /name="([^"]+)"/.exec(a)?.[1];
      if (!name) continue;
      const type = /type="([^"]+)"/.exec(a)?.[1] ?? "text";
      if (type === "file") continue;
      if ((type === "checkbox" || type === "radio") && !/\bchecked\b/.test(a)) continue;
      f.append(name, decode(/value="([^"]*)"/.exec(a)?.[1] ?? (type === "checkbox" ? "on" : "")));
    }
    for (const s of body.matchAll(/<select\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
      const sel = /<option value="([^"]*)"[^>]*selected/.exec(s[2]) ?? /<option value="([^"]*)"/.exec(s[2]);
      f.append(s[1], decode(sel?.[1] ?? ""));
    }
    for (const t of body.matchAll(/<textarea\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) f.append(t[1], decode(t[2]));
    out.push({ page, action, fields: f, async: /data-async/.test(attrs) });
  }
  return out;
}

describe("console crawl", () => {
  it("every page and link renders, and every form submits without a server error", async () => {
    const seen = new Set<string>();
    const queue = ["/admin"];
    const forms: FormSpec[] = [];
    const problems: string[] = [];
    while (queue.length && seen.size < 200) {
      const url = queue.shift()!;
      if (seen.has(url)) continue;
      seen.add(url);
      const r = await app.inject({ url });
      if (r.statusCode >= 400) {
        problems.push(`GET ${url} → ${r.statusCode}`);
        continue;
      }
      if (r.statusCode === 303) continue;
      const html = r.body.replace(/<script\b[\s\S]*?<\/script>/g, ""); // JS templates aren't links or forms
      const main = html.slice(html.indexOf('id="main"'), html.indexOf("</main>"));
      if (/\bundefined\b|\[object Object\]|\bNaN\b/.test(main)) problems.push(`GET ${url} leaks undefined/NaN`);
      for (const l of html.matchAll(/href="(\/admin[^"#]*)/g)) {
        const link = decode(l[1]);
        if (!SKIP_LINK.test(link) && !seen.has(link)) queue.push(link);
      }
      forms.push(...formsOf(url, html));
    }
    expect(seen.size).toBeGreaterThan(25);

    // Submit each distinct form once. Destructive platform actions go last so they don't hide other pages.
    const unique = [...new Map(forms.map((f) => [`${f.action}?${[...f.fields.keys()].sort().join(",")}`, f])).values()];
    const last = (f: FormSpec) => /\/status$|\/forget$|\/delete$/.test(f.action);
    unique.sort((a, b) => Number(last(a)) - Number(last(b)));
    for (const f of unique) {
      const r = await app.inject({
        method: "POST",
        url: f.action,
        payload: f.fields.toString(),
        headers: { "content-type": "application/x-www-form-urlencoded", ...(f.async ? { accept: "application/json" } : {}) },
      });
      if (r.statusCode >= 500) problems.push(`POST ${f.action} (from ${f.page}) → ${r.statusCode}: ${r.body.slice(0, 200)}`);
      if (r.statusCode === 404) problems.push(`POST ${f.action} (from ${f.page}) → 404 (no such route)`);
      const loc = String(r.headers.location ?? "");
      if (loc && !loc.startsWith("/") && !loc.startsWith("https://www.instagram.com") && !loc.startsWith("https://api.instagram.com")) problems.push(`POST ${f.action} redirected off-site: ${loc}`);
    }
    expect(unique.length).toBeGreaterThan(30);
    expect(problems).toEqual([]);
  });
});
