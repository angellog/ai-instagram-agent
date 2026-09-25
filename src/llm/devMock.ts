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
      const topics = ["Morning rotation check", "Three ways to keep white pairs clean", "Why I always pack a second pair", "Reading list and a quiet coffee", "Golden hour fit check"];
      const topic = `${topics[(Date.now() / 1000 + attempt) % topics.length | 0]}${attempt ? ` (take ${attempt + 1})` : ""}`;
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
          location_id: act?.[4] && act[4] !== "-" ? act[4] : null,
          time_of_day: "morning",
          outfit: "cream ribbed knit crop top with light-wash wide-leg denim",
          sneakers: "white leather low-top sneakers",
          slides: Array.from({ length: carousel ? 4 : 1 }, (_, i) => slide(i)),
          caption: `${topic}. What is your go-to pair this week?`,
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
