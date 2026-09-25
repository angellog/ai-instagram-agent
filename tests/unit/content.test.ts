import { describe, expect, it } from "vitest";
import { repetitionScore } from "../../src/content/repetition.js";
import { enforceContinuity } from "../../src/content/continuity.js";
import { planActivities } from "../../src/content/activities.js";
import { fitCaption } from "../../src/content/caption.js";
import { nextPublishTime } from "../../src/content/produce.js";
import { loadPersonaFromFile } from "../../src/persona/loader.js";
import type { RecentItem } from "../../src/content/history.js";

const persona = loadPersonaFromFile("config/persona.yaml").persona;

const recent = (over: Partial<RecentItem>): RecentItem => ({
  postId: "p",
  ideaId: 1,
  status: "published",
  format: "carousel",
  structure: "educational",
  topic: "How to clean white leather sneakers",
  hook: "Your white pairs deserve better",
  caption: "Three steps I use every Sunday to keep white leather clean.",
  visual: { location_id: "apartment", outfit: "plain black cropped zip hoodie", activity: "sneaker cleaning session", compositions: ["detail", "medium"] },
  createdAt: new Date(),
  publishedAt: new Date(),
  ...over,
});

describe("repetition score", () => {
  it("rejects a near-duplicate of a recent post", () => {
    const r = repetitionScore(
      {
        topic: "How to clean white leather sneakers at home",
        hook: "Your white pairs deserve better care",
        caption: "Three steps I use every Sunday to keep white leather clean",
        structure: "educational",
        format: "carousel",
        visual: { location_id: "apartment", outfit: "plain black cropped zip hoodie", activity: "sneaker cleaning session", compositions: ["detail", "medium"] },
      },
      [recent({})],
    );
    expect(r.score).toBeGreaterThan(0.9);
    expect(r.reasons.join(" ")).toMatch(/topic close/);
    expect(r.components.location).toBeGreaterThan(0);
  });

  it("accepts a clearly different concept", () => {
    const r = repetitionScore(
      {
        topic: "Sunrise run at the Kololo airstrip",
        hook: "5:40am and the city is still quiet",
        caption: "First light, cool air, and the new runners finally broken in.",
        structure: "lifestyle_diary",
        format: "carousel",
        visual: { location_id: "kololo-track", outfit: "oversized white mesh jersey", activity: "sunrise run", compositions: ["environment", "full_body"] },
      },
      [recent({})],
    );
    expect(r.score).toBeLessThan(0.3);
  });

  it("penalizes the same structure twice in a row and repeated shot sequences", () => {
    const r = repetitionScore(
      { topic: "A totally new topic about books", hook: "What I read this week", caption: "Books.", structure: "educational", format: "carousel", visual: { compositions: ["detail", "medium"] } },
      [recent({})],
    );
    expect(r.components.structure).toBe(0.12);
    expect(r.components.composition).toBe(0.08);
  });
});

describe("continuity", () => {
  it("keeps the same outfit within a day unless there is a workout", () => {
    const prev = recent({ visual: { local_day: "2026-09-24", time_of_day: "morning", outfit: "cream knit + denim", activity: "breakfast" } });
    const same = enforceContinuity({ outfit: "black hoodie", time_of_day: "afternoon" }, { localDay: "2026-09-24", slot: "afternoon", activity: "reading", hairstyle: "braids" }, [prev]);
    expect(same.state.outfit).toBe("cream knit + denim");
    const gym = enforceContinuity({ outfit: "white mesh jersey", time_of_day: "golden_hour" }, { localDay: "2026-09-24", slot: "evening", activity: "gym", hairstyle: "braids" }, [prev]);
    expect(gym.state.outfit).toBe("white mesh jersey");
  });

  it("never lets time of day run backwards or disagree with the slot", () => {
    const prev = recent({ visual: { local_day: "2026-09-24", time_of_day: "golden_hour", outfit: "x" } });
    const r = enforceContinuity({ outfit: "x", time_of_day: "sunrise" }, { localDay: "2026-09-24", slot: "afternoon", hairstyle: "braids" }, [prev]);
    expect(r.state.time_of_day).toBe("golden_hour");
    expect(r.adjustments.length).toBeGreaterThan(0);
  });

  it("pins the persona hairstyle", () => {
    const r = enforceContinuity({ hairstyle: "pink bob", time_of_day: "morning" }, { localDay: "d", slot: "morning", hairstyle: "box braids" }, []);
    expect(r.state.hairstyle).toBe("box braids");
  });
});

describe("activity planner", () => {
  it("is deterministic for a given day", () => {
    expect(planActivities(persona, "2026-09-24", 4)).toEqual(planActivities(persona, "2026-09-24", 4));
    expect(planActivities(persona, "2026-09-24", 4)).not.toEqual(planActivities(persona, "2026-09-25", 5));
  });
  it("spreads activities across the day and respects weekday-only activities", () => {
    const plan = planActivities(persona, "2026-09-26", 6); // Saturday
    expect(plan).toHaveLength(persona.daily_life.activities_per_day);
    expect(new Set(plan.map((a) => a.slot)).size).toBeGreaterThanOrEqual(5);
    expect(plan.some((a) => a.activity.includes("shop shift"))).toBe(false);
  });
  it("avoids yesterday's location for the same activity when it can", () => {
    for (let d = 1; d <= 20; d++) {
      const day = `2026-10-${String(d).padStart(2, "0")}`;
      const plan = planActivities(persona, day, 3, [{ activity: "breakfast", location: "apartment" }]);
      const b = plan.find((a) => a.activity === "breakfast");
      if (b) expect(b.location).toBe("kololo-cafe");
    }
  });
});

describe("caption", () => {
  it("appends normalized, de-duplicated hashtags within limits", () => {
    const c = fitCaption("Rotation check #sneakers", ["sneakers", "#kampala", "street style!", "#a", "#b", "#c", "#d"], { hashtags: { always: ["#zuri"], pool: [], max: 3 } });
    expect(c).toBe("Rotation check #sneakers\n\n#zuri #kampala #streetstyle #a");
  });
  it("never exceeds 2,200 characters", () => {
    expect(fitCaption("x".repeat(5000), ["#tag"], { hashtags: { always: [], pool: [], max: 5 } }).length).toBeLessThanOrEqual(2200);
  });
});

describe("posting window", () => {
  const c = { posting_window_start_hour: 8, posting_window_end_hour: 22 };
  it("publishes now inside the window", () => {
    const now = new Date("2026-09-24T09:00:00Z"); // 12:00 Kampala
    expect(nextPublishTime(now, c, "Africa/Kampala")).toEqual(now);
  });
  it("waits for the window to open", () => {
    const now = new Date("2026-09-24T21:30:00Z"); // 00:30 Kampala
    const at = nextPublishTime(now, c, "Africa/Kampala");
    expect(at.toISOString()).toBe("2026-09-25T05:05:00.000Z"); // 08:05 Kampala
  });
});

describe("vision QC verdict", () => {
  const base = { acceptable: true, character_consistent: "not_applicable" as const, anatomy_issues: false, garbled_text_or_logos: false, extra_people: false, matches_brief: true, issues: [] };
  it("accepts hands and feet on detail shots", async () => {
    const { visionVerdict } = await import("../../src/content/qc.js");
    expect(visionVerdict(base, false).ok).toBe(true);
  });
  it("does not fail a good photo for pose or prop differences from the brief", async () => {
    const { visionVerdict } = await import("../../src/content/qc.js");
    const r = visionVerdict({ ...base, acceptable: false, matches_brief: false, character_consistent: "yes", issues: ["phone not visible in mirror"] }, true);
    expect(r).toEqual({ ok: true, problems: [] });
  });
  it("rejects anatomy problems, garbled text, extra people and identity drift", async () => {
    const { visionVerdict } = await import("../../src/content/qc.js");
    expect(visionVerdict({ ...base, anatomy_issues: true }, false).ok).toBe(false);
    expect(visionVerdict({ ...base, garbled_text_or_logos: true }, false).ok).toBe(false);
    expect(visionVerdict({ ...base, extra_people: true }, false).ok).toBe(false);
    expect(visionVerdict({ ...base, character_consistent: "no" }, true).ok).toBe(false);
  });
});

describe("persona photo style", () => {
  it("defaults to plain photos with no text overlays", () => {
    expect(persona.carousel.text_overlays).toBe(false);
    expect(persona.visual.photography.camera_feel).toMatch(/iPhone/);
  });
});
