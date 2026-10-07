import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse, stringify } from "yaml";
import { LLM } from "./llm.js";
import { MockProvider } from "./providers.js";
import type { CompletionRequest } from "./types.js";

/**
 * Offline LLM for LLM_PROVIDER=mock (local development, demos, e2e tests).
 * Deterministic, schema-valid answers per operation so every pipeline stage
 * runs without a key. It is intentionally plain; real quality comes from the
 * real model.
 */
export function createDevMockProvider(): MockProvider {
  const lastUser = (r: CompletionRequest) => r.messages[r.messages.length - 1]?.content ?? "";
  const between = (s: string, a: string, b: string) => {
    const i = s.indexOf(a);
    if (i < 0) return "";
    const j = s.indexOf(b, i + a.length);
    return s.slice(i + a.length, j < 0 ? undefined : j);
  };

  return new MockProvider((req) => {
    throw new Error(`dev mock has no handler for ${req.operation}`);
  })
    .on("conversation.classify", (r) => {
      const t = lastUser(r).toLowerCase();
      const intent = /price|how much|size|stock|buy|order/.test(t)
        ? "question_product"
        : /are you (real|ai|a bot|human)/.test(t)
          ? "question_about_persona"
          : /post about|make a post|do a video/.test(t)
            ? "content_request"
            : /\?/.test(t)
              ? "question_general"
              : /love|fire|clean|nice|dope|🔥/.test(t)
                ? "compliment"
                : "niche_talk";
      return { intent, confidence: 0.8, sentiment: "positive", language: "en", is_question: t.includes("?"), needs_memory: true, needs_business_info: intent === "question_product" };
    })
    .on("conversation.decide", (r) => {
      const u = lastUser(r);
      const msg = between(u, 'MESSAGE: """', '"""');
      const intent = between(u, "intent=", " ");
      const memIds = [...between(u, "MEMORIES", "THREAD").matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
      const kn = [...between(u, "KNOWLEDGE:", "\n\n").matchAll(/\[([\w-]+)\]/g)].map((m) => m[1]);
      if (intent === "question_product") {
        return {
          action: "escalate",
          channel: "private",
          reply_value: "required",
          response: "Good question! The FeetBit team handles sizes and prices, message them on WhatsApp +256 789 652 909 or DM @feetbit.sneakers.",
          used_memory_ids: [],
          used_knowledge_ids: kn,
          workflow: "none",
          content_request_topic: null,
          confidence: 0.8,
          reason: "Product/price question goes to the store team.",
        };
      }
      return {
        action: "reply",
        channel: "public",
        reply_value: "required",
        response: intent === "question_about_persona" ? "I'm an AI creator made by the FeetBit team, the sneaker talk is real though 👟" : `Love that! ${msg.length > 40 ? "Great point." : "Clean choice."} 👟`,
        used_memory_ids: memIds.slice(0, 1),
        used_knowledge_ids: [], // a small-talk reply cites no business facts
        workflow: intent === "content_request" ? "content_request" : "none",
        content_request_topic: intent === "content_request" ? msg.slice(0, 120) : null,
        confidence: 0.75,
        reason: "Friendly reply to a direct message.",
      };
    })
    // Offline fact-check rewrite: restate the first KNOWLEDGE entry the reply relied on.
    .on("conversation.fix_facts", (r) => {
      const fact = between(lastUser(r), "KNOWLEDGE:", "\n\n").split("\n").find((l) => /^\s*\[/.test(l)) ?? "";
      return fact.replace(/^\s*\[[\w-]+\]\s*/, "").trim() || between(lastUser(r), 'DRAFT REPLY: """', '"""');
    })
    .on("safety.moderate", () => ({ level: "green", categories: [], reason: "mock moderator: nothing notable" }))
    .on("memory.extract", (r) => {
      const msg = between(lastUser(r), 'message: """', '"""');
      const m = msg.match(/i (?:love|like|prefer|wear) ([\w\s'-]{3,40})/i);
      // The creator's own story: "I'm watching/playing/heading to X" becomes canon.
      const reply = between(lastUser(r), 'reply (use it only for "self"): """', '"""');
      const own = reply.match(/i'?m (watching|playing|reading|heading to|going to) ([\w\s'-]{3,40})/i);
      return {
        memories: m ? [{ kind: "interest", content: `Likes ${m[1].trim()}`, confidence: 0.85, importance: 0.6, expires_on: null }] : [],
        self: own ? [{ kind: /heading|going/i.test(own[1]) ? "self_plan" : "self_fact", content: `The creator is ${own[1].toLowerCase()} ${own[2].trim()}`, expires_on: null }] : [],
      };
    })
    .on("conversation.social_rewrite", () => "haha same, honestly")
    .on("memory.summarize", () => "Friendly follower who talks sneakers.")
    .on("config.test", () => "OK")
    .on("trends.brief", (r) => {
      const n = (lastUser(r).match(/^\d+\./gm) ?? []).length;
      return { items: Array.from({ length: Math.min(n, 3) }, (_, i) => ({ index: i + 1, note: "Sneaker and street-style news this creator would talk about", use: i === 0 ? "post" : "conversation" })) };
    })
    .on("profile.kit", () => ({
      display_name: "Zuri | Sneakers & Kampala",
      usernames: ["zuri.kicks", "zuri_rotation", "Zuri Kampala!"],
      bios: [
        { style: "clean", text: "Kampala sneaker & street-style diaries 👟\nRotations, fit checks, city days\nAI creator by FeetBit" },
        { style: "playful", text: "Collecting pairs faster than excuses 👟✨ Kampala days, clean fits, strong coffee" },
        { style: "community", text: "Your daily sneaker fix from Kampala 👟\nTell me your grail in the comments 👇\n🤖 AI creator" },
      ],
      category: "Digital creator",
      link_idea: "FeetBit store page or a link-in-bio with the latest drops",
      highlights: ["Rotation", "Fit checks", "Kampala", "Drops", "Ask Zuri", "A really long highlight name"],
      first_story: "A poll: which pair should I wear tomorrow?",
    }))
    .on("benchmark.judge", () => ({ identity: 7, photorealism: 7, adherence: 8, notes: "mock judge" }))
    .on("persona.compose", (r) => devPersona(lastUser(r)))
    // Offline TikTok caption: a hook line and a few hashtags.
    // Offline reel director: an explainer for tips creators, a moment for everyone else.
    .on("reel.plan", (r) => {
      const u = lastUser(r);
      const loc = (u.split("LOCATIONS:")[1] ?? "").match(/^([\w-]+):/m)?.[1] ?? null;
      const material = /- id ([0-9a-f-]{36}) \|/.exec(u.split("REEL MATERIAL")[1] ?? "")?.[1] ?? null;
      const clip = (shot: string, seconds: number) => ({ shot, motion: "she looks up and smiles, gentle handheld drift", composition: "medium", include_character: true, location_id: loc, time_of_day: "afternoon", seconds });
      const explainer = /prefer an explainer/.test(u);
      const row = (label: string, extra: Record<string, unknown> = {}) => ({ label, section: null, icon_color: "#34C759", value: null, toggle: null, chevron: true, ...extra });
      return {
        decision: "post",
        reason: "A useful short reel.",
        reel: {
          kind: explainer ? "explainer" : "moment",
          topic: explainer ? "Save battery with Low Power Mode" : "Slow afternoon at the shop",
          hook: explainer ? "Your battery, twice as long" : "afternoons like this",
          caption: explainer ? "One switch, a lot more battery." : "Small moments, big mood.",
          hashtags: [],
          os: explainer ? "ios" : null,
          intro: clip("She holds up her phone in the shop", 4),
          clips: explainer ? [] : [clip("Coffee on the counter", 3)],
          steps: explainer
            ? [
                { say: "Open Settings, tap Battery", tap: "Battery", screen: { title: "Settings", back: null, footer: null, rows: [row("Wi-Fi", { value: "Home" }), row("Battery"), row("Privacy & Security")] } },
                { say: "Turn on Low Power Mode", tap: "Low Power Mode", screen: { title: "Battery", back: "Settings", footer: null, rows: [row("Low Power Mode", { icon_color: null, toggle: false, chevron: false })] } },
              ]
            : [],
          material_id: material,
          featured_item: "",
        },
      };
    })
    .on("reel.verify", (r) => {
      const steps = JSON.parse(lastUser(r).split("STEPS:\n")[1] ?? "[]");
      return { accurate: true, os_version: "iOS 18", problems: [], steps };
    })
    // Offline interview: business answers become knowledge, everything else a memory.
    .on("interview.apply", (r) => {
      const u = lastUser(r);
      const answers = [...u.matchAll(/Q \(([\w:-]+)\): [^\n]*\nA: ([^\n]+)/g)].map((m) => ({ topic: m[1], answer: m[2] }));
      const loc = answers.find((a) => a.topic === "business_location");
      const life = answers.filter((a) => a.topic.startsWith("life"));
      return {
        interests_add: [], signature_phrases_add: [], avoid_phrases_add: [], boundaries_add: [], weekend_ideas_add: [], location_looks: [],
        knowledge: loc ? [{ id: "shop-location", keywords: ["shop", "where", "location", "address"], content: `The shop is at ${loc.answer}.`, must_include: [loc.answer] }] : [],
        memories: life.map((a) => ({ kind: "self_fact", content: `The creator ${a.answer}`, expires_on: null })),
        summary: [...(loc ? [`Business fact: the shop is at ${loc.answer}`] : []), ...life.map((a) => `Remembered: ${a.answer}`)],
      };
    })
    .on("interview.experience", (r) => ({ memories: [{ kind: "self_fact", content: `The creator ${between(lastUser(r), "NOTE: ", "\n") || lastUser(r).replace("NOTE: ", "")}`, expires_on: null }], weekend_idea: null }))
    .on("library.caption", () => ({ caption: "New in, and honestly it's my favourite this week.", hashtags: [], alt_text: "Business photo" }))
    .on("tiktok.caption", () => ({ title: "New laces, same me", caption: "Sunday reset, sneakers first 👟", hashtags: ["sneakers", "kampala", "fitcheck"] }))
    // Offline standard upgrade: fill each requested section from the reference persona.
    .on("persona.upgrade", (r) => devUpgrade(lastUser(r)))
    .on("image.validate", () => ({
      acceptable: true,
      character_consistent: "yes",
      anatomy_issues: false,
      garbled_text_or_logos: false,
      extra_people: false,
      matches_brief: true,
      issues: [],
    }))
    // Offline story planner: rotate kinds so consecutive stories differ; text only when she isn't in frame.
    .on("story.plan", (r) => {
      const u = lastUser(r);
      const act = u.match(/^- (\d+) \| (\w+) \| ([^|]+) \| ([\w-]+)/m);
      const seen = ((u.split("RECENT STORIES")[1] ?? "").split("\n\n")[0].match(/^- (?!none yet)/gm) ?? []).length;
      const shop = /- brand:/.test(r.system);
      const plans = [
        { kind: "moment", include_character: false, composition: "detail", shot: "Fresh white laces being threaded into a clean pair on a wooden table", text: "Sunday laces ritual" },
        { kind: "look", include_character: true, composition: "mirror", shot: "Quick mirror fit check by the front door", text: "" },
        ...(shop ? [{ kind: "brand", include_character: false, composition: "detail", shot: "A new pair on the shop wall under warm spotlights", text: "Just landed at the shop" }] : []),
        { kind: "question", include_character: false, composition: "flat_lay", shot: "Two pairs side by side on the floor, top-down", text: "Which pair for Saturday?" },
      ];
      const pick = plans[seen % plans.length];
      return {
        decision: "post",
        reason: "A light moment worth a story.",
        story: { ...pick, activity_id: act ? Number(act[1]) : null, location_id: act?.[4] && act[4] !== "-" ? act[4] : null, time_of_day: "morning", featured_item: "", alt_text: pick.shot },
      };
    })
    .on("content.plan", (r) => {
      const u = lastUser(r);
      const act = u.match(/^- (\d+) \| (\w+) \| ([^|]+) \| ([\w-]+)/m);
      const attempt = (u.match(/Attempt \d+ was REJECTED/g) ?? []).length;
      // Like a real director: avoid what was posted recently (topic and place).
      const recentBlock = (u.split("RECENT POSTS")[1] ?? "").split("\n\n")[0].toLowerCase();
      const topics = [
        ["Morning rotation check", "Three pairs, one decision, zero coffee yet."],
        ["Three ways to keep white pairs clean", "Save this before your next rainy walk."],
        ["Why I always pack a second pair", "Learned this the muddy way."],
        ["Reading list and a quiet coffee", "Slow afternoons hit different."],
        ["Golden hour fit check", "The light did most of the work today."],
        ["Market run in my comfiest pair", "Owino at 8am is a sport of its own."],
        ["Rooftop sunset, new laces", "Tiny upgrade, big mood."],
        ["Lunch break walk around town", "Ten thousand steps, one clean pair."],
      ];
      const fresh = topics.filter(([t]) => !recentBlock.includes(t.toLowerCase()));
      const [topicBase, line] = (fresh.length ? fresh : topics)[(Math.floor(Date.now() / 1000) + attempt) % (fresh.length || topics.length)];
      const topic = topicBase;
      const locs = [...(u.split("LOCATIONS:")[1] ?? "").split("\n\n")[0].matchAll(/^([\w-]+):/gm)].map((m) => m[1]);
      const freshLoc = locs.find((l) => !recentBlock.includes(`loc=${l}`)) ?? locs[0] ?? null;
      const carousel = attempt % 2 === 0;
      const slide = (i: number) => ({
        role: i === 0 ? "cover" : "slide",
        shot: i === 0 ? "She laces up her sneakers, smiling at the camera" : `Detail shot ${i}`,
        composition: i === 0 ? "full_body" : i % 2 ? "detail" : "medium",
        include_character: i === 0 || i % 2 === 0,
        overlay_kind: carousel ? (i === 0 ? "cover" : "body") : "none",
        overlay_heading: carousel ? (i === 0 ? topic : `Tip ${i}`) : "",
        overlay_body: carousel && i > 0 ? "Short, useful and specific advice goes here." : "",
        alt_text: `Photo ${i + 1} of the series`,
      });
      return {
        decision: "post",
        reason: "An interesting moment that has not been posted recently.",
        idea: {
          source: act ? "activity" : "evergreen",
          activity_id: act ? Number(act[1]) : null,
          format: carousel ? "carousel" : "single",
          structure: carousel ? "educational" : "moment",
          topic,
          hook: topic,
          angle: "practical",
          location_id: act?.[4] && act[4] !== "-" && !recentBlock.includes(`loc=${act[4]}`) ? act[4] : freshLoc,
          time_of_day: "morning",
          outfit: "cream ribbed knit crop top with light-wash wide-leg denim",
          featured_item: "",
          // Like a director that likes business uploads: take the first one offered.
          library_item_id: /BUSINESS LIBRARY/.test(u) ? (/- id ([0-9a-f-]{36}) \|/.exec(u)?.[1] ?? null) : null,
          slides: Array.from({ length: carousel ? 4 : 1 }, (_, i) => slide(i)),
          caption: `${line} ${["Which pair would you pick?", "Tell me your go-to this week.", "Rate the fit 1–10."][attempt % 3]}`,
          hashtags: ["#sneakers", "#kampala"],
        },
      };
    });
}

/** Offline persona composer: the reference persona, renamed from the brief. */
function devUpgrade(prompt: string): string {
  const keys = (/exactly these keys: (.+)\.\s*$/m.exec(prompt)?.[1] ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  const ref = parse(readFileSync(resolve(process.env.PERSONA_PATH ?? "config/persona.yaml"), "utf8")) as Record<string, unknown>;
  const at = (path: string) => path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), ref);
  return stringify(Object.fromEntries(keys.map((k) => [k, at(k)])));
}

function devPersona(prompt: string): string {
  const name = /^Name: (.+)$/m.exec(prompt.split("BRIEF:")[1] ?? "")?.[1]?.trim() ?? "Nova";
  const tpl = readFileSync(resolve(process.env.PERSONA_PATH ?? "config/persona.yaml"), "utf8");
  return tpl.replace(/^  name: .+$/m, `  name: ${name}`).replace(/^  handle: .+$/m, `  handle: "@${name.toLowerCase().replace(/[^a-z0-9]/g, "")}"`);
}

export function createDevLLM(): LLM {
  return new LLM(createDevMockProvider());
}
