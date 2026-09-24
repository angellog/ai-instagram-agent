import { describe, expect, it } from "vitest";
import { applyMemoryPolicy, memoryKey } from "../../src/memory/policy.js";

const now = new Date("2026-09-24T10:00:00Z");

describe("memory policy", () => {
  it("stores a confident interest with no expiry", () => {
    const v = applyMemoryPolicy({ kind: "interest", content: "Collects Jordan 4s", confidence: 0.9 }, now);
    expect(v.store).toBe(true);
    if (v.store) {
      expect(v.expiresAt).toBeNull();
      expect(v.key).toBe("interest:collects_jordan_4s");
    }
  });

  it("expires questions after 30 days and events on their date", () => {
    const q = applyMemoryPolicy({ kind: "question", content: "Asked how to clean suede", confidence: 0.8 }, now);
    expect(q.store && q.expiresAt?.toISOString().slice(0, 10)).toBe("2026-10-24");
    const e = applyMemoryPolicy({ kind: "event", content: "Running a 10k on Saturday", confidence: 0.8, expires_on: "2026-09-27" }, now);
    expect(e.store && e.expiresAt?.toISOString().slice(0, 10)).toBe("2026-09-29");
  });

  it("rejects low confidence, past events and unknown kinds", () => {
    expect(applyMemoryPolicy({ kind: "interest", content: "Maybe likes Nike", confidence: 0.4 }, now).store).toBe(false);
    expect(applyMemoryPolicy({ kind: "event", content: "Had a race", confidence: 0.9, expires_on: "2026-01-01" }, now).store).toBe(false);
    expect(applyMemoryPolicy({ kind: "gossip", content: "Something", confidence: 0.9 }, now).store).toBe(false);
  });

  it.each([
    ["health", "Was in hospital last week with anxiety"],
    ["religion", "Goes to church every Sunday"],
    ["politics", "Supports NUP"],
    ["finances", "Has a lot of debt"],
    ["location", "Lives at plot 12 Kira road"],
    ["minor", "Is 14 years old"],
    ["phone", "Phone number is +256 772 555 111"],
    ["email", "Email is a.person@example.com"],
    ["third party", "My friend's number is in the bio"],
  ])("never stores %s", (_n, content) => {
    const v = applyMemoryPolicy({ kind: "fact", content, confidence: 0.95 }, now);
    expect(v.store).toBe(false);
  });

  it("produces stable keys so updates replace rather than duplicate", () => {
    expect(memoryKey("preference", "Prefers low-top Jordans")).toBe(memoryKey("preference", "prefers low top jordans!"));
  });
});
