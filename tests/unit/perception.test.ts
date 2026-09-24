import { describe, expect, it } from "vitest";
import { perceive, sampled } from "../../src/conversation/agent.js";
import { windowOpen } from "../../src/conversation/send.js";
import { controlsSchema } from "../../src/config/controls.js";

const c = controlsSchema.parse({ mode: "autonomous" });

describe("deterministic perception", () => {
  it("skips keywords owned by OpenReply campaigns", () => {
    expect(perceive({ text: "LINK please", kind: "comment" }, "normal", c)).toMatchObject({ skip: true, reason: expect.stringContaining("OpenReply") });
  });
  it("skips emoji-only, spam, blocked users and story mentions", () => {
    expect(perceive({ text: "🔥🔥", kind: "comment" }, "normal", c).skip).toBe(true);
    expect(perceive({ text: "DM us for collab promo!!", kind: "comment" }, "normal", c).skip).toBe(true);
    expect(perceive({ text: "check https://spam.example", kind: "comment" }, "normal", c).skip).toBe(true);
    expect(perceive({ text: "hello", kind: "comment" }, "blocked", c).skip).toBe(true);
    expect(perceive({ text: "tagged you", kind: "story_mention" }, "normal", c).skip).toBe(true);
  });
  it("lets real messages through", () => {
    expect(perceive({ text: "Which pair for a wedding?", kind: "comment" }, "normal", c).skip).toBe(false);
  });
  it("stops everything while paused", () => {
    expect(perceive({ text: "hi", kind: "dm" }, "normal", { ...c, paused: true }).skip).toBe(true);
  });
});

describe("reply sampling", () => {
  it("is deterministic per interaction and roughly matches the rate", () => {
    expect(sampled(42, 0.5)).toBe(sampled(42, 0.5));
    const hits = Array.from({ length: 2000 }, (_, i) => sampled(i, 0.3)).filter(Boolean).length;
    expect(hits / 2000).toBeGreaterThan(0.25);
    expect(hits / 2000).toBeLessThan(0.35);
    expect(sampled(1, 1)).toBe(true);
    expect(sampled(1, 0)).toBe(false);
  });
});

describe("messaging windows", () => {
  const now = Date.now();
  it("enforces 24h for DMs and 7 days for private replies", () => {
    expect(windowOpen({ kind: "dm", occurred_at: new Date(now - 23 * 3600_000) }, "dm", now)).toBe(true);
    expect(windowOpen({ kind: "dm", occurred_at: new Date(now - 25 * 3600_000) }, "dm", now)).toBe(false);
    expect(windowOpen({ kind: "comment", occurred_at: new Date(now - 6 * 86400_000) }, "private_reply", now)).toBe(true);
    expect(windowOpen({ kind: "comment", occurred_at: new Date(now - 8 * 86400_000) }, "private_reply", now)).toBe(false);
    expect(windowOpen({ kind: "comment", occurred_at: new Date(now - 30 * 86400_000) }, "public_reply", now)).toBe(true);
  });
});
