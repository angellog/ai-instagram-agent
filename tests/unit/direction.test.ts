import { describe, expect, it } from "vitest";
import { cleanDirection, DIRECTION_MAX } from "../../src/content/create.js";
import { directionBlock, followsDirection } from "../../src/content/director.js";

describe("operator direction", () => {
  it("is tidied to one capped line; blank means none", () => {
    expect(cleanDirection("  Jordan 4\n\tat the  shop ")).toBe("Jordan 4 at the shop");
    expect(cleanDirection("   ")).toBeUndefined();
    expect(cleanDirection(42)).toBeUndefined();
    expect(cleanDirection("x".repeat(500))).toHaveLength(DIRECTION_MAX);
  });

  it("becomes a must-follow block that still defers to persona, safety and facts", () => {
    expect(directionBlock(undefined, "post")).toBe("");
    const b = directionBlock("date night, white AF1", "post");
    expect(b).toContain('about: "date night, white AF1"');
    expect(b).toMatch(/may not decide to wait/);
    expect(b).toMatch(/never state prices, stock, addresses or offers/);
  });

  it("keeps an outfit the operator asked for", () => {
    expect(followsDirection("black cargo pants, Jordan 4 Black Cat", "Jordan 4 Black Cat at the shop")).toBe(true);
    expect(followsDirection("linen dress", "Jordan 4 at the shop")).toBe(false);
    expect(followsDirection("anything", undefined)).toBe(false);
  });
});
