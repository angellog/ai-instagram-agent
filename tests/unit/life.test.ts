import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { anchorWords, genericProblems, pickMoments, progressOf, resolveLife } from "../../src/content/life.js";
import { coerceShapes, mergeSections, personaChecks } from "../../src/influencers/standard.js";
import { parsePersona } from "../../src/persona/parse.js";

const zuri = parsePersona(readFileSync("config/persona.yaml", "utf8"));
const arc = zuri.life.arcs[0];
const DAY = 86_400_000;

describe("storyline pace", () => {
  it("starts due, then waits every_days after a beat, and finishes", () => {
    const now = new Date("2026-10-08T10:00:00Z");
    expect(progressOf(arc, undefined, now)).toMatchObject({ done: 0, next: arc.beats[0], due: true, waitDays: 0 });
    const justPosted = progressOf(arc, { n: 1, last_at: new Date(now.getTime() - DAY), last_beat: arc.beats[0] }, now);
    expect(justPosted).toMatchObject({ done: 1, next: arc.beats[1], due: false, waitDays: arc.every_days - 1 });
    expect(progressOf(arc, { n: 1, last_at: new Date(now.getTime() - arc.every_days * DAY), last_beat: arc.beats[0] }, now).due).toBe(true);
    expect(progressOf(arc, { n: 99, last_at: now, last_beat: "x" }, now)).toMatchObject({ done: arc.beats.length, next: null, due: false, waitDays: 0 });
  });
});

describe("moments", () => {
  it("offers the same fresh set all day, never one used recently", () => {
    const a = pickMoments(zuri, [], "2026-10-08");
    expect(a).toHaveLength(4);
    expect(pickMoments(zuri, [], "2026-10-08")).toEqual(a);
    expect(pickMoments(zuri, [], "2026-10-09")).not.toEqual(a);
    const used = zuri.life.moments.slice(0, zuri.life.moments.length - 4);
    expect(pickMoments(zuri, used, "2026-10-08").sort()).toEqual(zuri.life.moments.slice(-4).sort());
    // Everything used: falls back to the whole library rather than nothing.
    expect(pickMoments(zuri, zuri.life.moments, "2026-10-08")).toHaveLength(4);
  });
});

describe("what a post stood on", () => {
  const ctx = { arcs: [progressOf(arc, undefined)], moments: [], callbacks: [{ postId: "p1", topic: "t", caption: "", daysAgo: 9 }] };
  it("keeps only real arcs, offered callbacks and concrete moments", () => {
    expect(resolveLife(zuri, ctx, { arc_id: arc.id, moment: "the rolex guy folded mine before I ordered", callback_post_id: "p1" })).toEqual({
      arc_id: arc.id, beat_index: 0, beat: arc.beats[0], moment: "the rolex guy folded mine before I ordered", callback_post_id: "p1",
    });
    expect(resolveLife(zuri, ctx, { arc_id: "made-up", moment: "nice", callback_post_id: "p9" })).toBeUndefined();
  });
});

describe("anti-generic", () => {
  it("sends back stock lines", () => {
    const out = genericProblems({ topic: "Sunday", hook: "Golden hour", caption: "Living my best life ✨ good vibes only" }, zuri, { moment: "x".repeat(20) });
    expect(out).toEqual(["stock phrase: living my best life", "stock phrase: good vibes", "stock phrase: golden hour"]);
  });

  it("wants one specific thing: a beat, a moment, a callback, the operator's words, or a real place, person or number", () => {
    const vague = { topic: "Afternoon coffee", hook: "coffee time", caption: "a little pause today" };
    expect(genericProblems(vague, zuri, undefined)[0]).toMatch(/^too generic/);
    expect(genericProblems(vague, zuri, { moment: "the barista spelled it Zuli again" })).toEqual([]);
    expect(genericProblems(vague, zuri, undefined, "new arrivals at the shop")).toEqual([]);
    expect(genericProblems({ ...vague, caption: "Nana is late again" }, zuri, undefined)).toEqual([]);
    expect(genericProblems({ ...vague, caption: "Kololo mornings are the only ones" }, zuri, undefined)).toEqual([]);
    expect(genericProblems({ ...vague, caption: "km 12 and still smiling" }, zuri, undefined)).toEqual([]);
  });

  it("reads anchors from her places and people", () => {
    const words = anchorWords(zuri);
    expect(words).toEqual(expect.arrayContaining(["kampala", "kololo", "ntinda", "pioneer", "nana", "brian"]));
    expect(words).not.toContain("this");
  });
});

describe("the Standard holds every influencer to a timeline", () => {
  it("flags a persona with no storylines, moments or people, and Zuri passes", () => {
    const bare = parsePersona(readFileSync("config/persona.yaml", "utf8").replace(/\nlife:[\s\S]*?(?=\ntrends:)/, ""));
    const failing = personaChecks(bare).filter((c) => !c.ok).map((c) => c.key);
    expect(failing).toEqual(expect.arrayContaining(["life_arcs", "moments", "circle"]));
    expect(personaChecks(zuri).filter((c) => ["life_arcs", "moments", "circle"].includes(c.key)).every((c) => c.ok)).toBe(true);
  });

  it("forgives the shapes a model sends for storylines and merges them in", () => {
    let arcs: unknown = [{ id: "Learning To Braid!", title: "Braids", story: "s", beats: [{ text: "one" }, "two", { step: "three" }, "four"], every_days: "5" }];
    coerceShapes("life.arcs", arcs, (v) => (arcs = v));
    expect(arcs).toEqual([{ id: "learning-to-braid", title: "Braids", story: "s", beats: ["one", "two", "three", "four"], every_days: 5 }]);
    const bare = readFileSync("config/persona.yaml", "utf8").replace(/\nlife:[\s\S]*?(?=\ntrends:)/, "");
    const merged = mergeSections(bare, `life.arcs:\n  - { id: braids, title: Braids, story: s, beats: [a, b, c, d] }\nlife.moments: [{ text: "rain on the roof" }]\nlife.circle:\n  - { name: Amina, who: sister }`, ["life.arcs", "life.moments", "life.circle"]);
    const p = parsePersona(merged);
    expect(p.life).toEqual({ arcs: [{ id: "braids", title: "Braids", story: "s", beats: ["a", "b", "c", "d"], every_days: 4 }], moments: ["rain on the roof"], circle: [{ name: "Amina", who: "sister" }] });
  });
});
