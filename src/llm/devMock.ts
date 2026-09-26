import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
                : "sneaker_talk";
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
          response: "Good question! The FeetBit team handles sizes and prices, message them on WhatsApp +256 789 652 909 or DM @feetbitstores.",
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
        used_knowledge_ids: kn,
        workflow: intent === "content_request" ? "content_request" : "none",
        content_request_topic: intent === "content_request" ? msg.slice(0, 120) : null,
        confidence: 0.75,
        reason: "Friendly reply to a direct message.",
      };
    })
    .on("safety.moderate", () => ({ level: "green", categories: [], reason: "mock moderator: nothing notable" }))
    .on("memory.extract", (r) => {
      const msg = between(lastUser(r), 'message: """', '"""');
      const m = msg.match(/i (?:love|like|prefer|wear) ([\w\s'-]{3,40})/i);
      return { memories: m ? [{ kind: "interest", content: `Likes ${m[1].trim()}`, confidence: 0.85, importance: 0.6, expires_on: null }] : [] };
    })
    .on("memory.summarize", () => "Friendly follower who talks sneakers.")
    .on("config.test", () => "OK")
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
    .on("image.validate", () => ({
      acceptable: true,
      character_consistent: "yes",
      anatomy_issues: false,
      garbled_text_or_logos: false,
      extra_people: false,
      matches_brief: true,
      issues: [],
    }))
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
          sneakers: "white leather low-top sneakers",
          slides: Array.from({ length: carousel ? 4 : 1 }, (_, i) => slide(i)),
          caption: `${line} ${["Which pair would you pick?", "Tell me your go-to this week.", "Rate the fit 1–10."][attempt % 3]}`,
          hashtags: ["#sneakers", "#kampala"],
        },
      };
    });
}

/** Offline persona composer: the reference persona, renamed from the brief. */
function devPersona(prompt: string): string {
  const name = /^Name: (.+)$/m.exec(prompt.split("BRIEF:")[1] ?? "")?.[1]?.trim() ?? "Nova";
  const tpl = readFileSync(resolve(process.env.PERSONA_PATH ?? "config/persona.yaml"), "utf8");
  return tpl.replace(/^  name: .+$/m, `  name: ${name}`).replace(/^  handle: .+$/m, `  handle: "@${name.toLowerCase().replace(/[^a-z0-9]/g, "")}"`);
}

export function createDevLLM(): LLM {
  return new LLM(createDevMockProvider());
}
