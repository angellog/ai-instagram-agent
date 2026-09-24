import { describe, expect, it } from "vitest";
import { containsKeyword, isLowContent, similarity, truncate } from "../../src/lib/text.js";

describe("text similarity", () => {
  it("scores near-identical phrasing high and unrelated text low", () => {
    expect(similarity("5 things nobody tells you about Jordan 1s", "Five things nobody tells you about Jordan 1s")).toBeGreaterThan(0.6);
    expect(similarity("Morning run at Kololo with coffee after", "Cleaning suede without ruining it")).toBeLessThan(0.15);
  });
  it("is symmetric and zero for empty input", () => {
    const a = "rotation check for the week";
    const b = "weekly rotation check";
    expect(similarity(a, b)).toBeCloseTo(similarity(b, a), 6);
    expect(similarity("", b)).toBe(0);
  });
});

describe("keyword matching", () => {
  it("matches whole words only, case-insensitively, in any script", () => {
    expect(containsKeyword("Send me the LINK please", "link")).toBe(true);
    expect(containsKeyword("linked in", "link")).toBe(false);
    expect(containsKeyword("Привет ССЫЛКА", "ссылка")).toBe(true);
  });
});

describe("low-content detection", () => {
  it("flags emoji/tag-only comments", () => {
    expect(isLowContent("🔥🔥🔥")).toBe(true);
    expect(isLowContent("@friend @other")).toBe(true);
    expect(isLowContent("fire 🔥")).toBe(false);
  });
  it("truncates with an ellipsis", () => {
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
    expect(truncate("abc", 5)).toBe("abc");
  });
});
