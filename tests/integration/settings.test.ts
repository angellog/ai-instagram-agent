import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrap } from "../../src/bootstrap.js";
import { clearSetting, mask, setSetting, setting, settingsView, SETTINGS } from "../../src/config/settings.js";
import { many, one } from "../../src/db/pool.js";
import { llmConfig } from "../../src/llm/llm.js";
import { SettingsProvider } from "../../src/llm/providers.js";
import type { LLMProvider } from "../../src/llm/types.js";
import { VERSION } from "../../src/version.js";
import { resetState, teardown } from "../helpers/db.js";

beforeEach(() => resetState());
afterAll(() => teardown());

describe("in-app settings (Config page)", () => {
  it("stores secrets encrypted, overrides env, and never exposes the full value", async () => {
    await setSetting("FAL_KEY", "fal-secret-key-1234567890");
    const row = await one<{ value_enc: string | null; value_plain: string | null }>("SELECT value_enc, value_plain FROM app_settings WHERE key = 'FAL_KEY'");
    expect(row!.value_plain).toBeNull();
    expect(row!.value_enc).not.toContain("fal-secret");
    expect(await setting("FAL_KEY")).toBe("fal-secret-key-1234567890");
    const view = (await settingsView()).find((s) => s.key === "FAL_KEY")!;
    expect(view).toMatchObject({ source: "app", display: "fal-••••7890" });
    expect(JSON.stringify(await settingsView())).not.toContain("fal-secret-key");
  });

  it("falls back to the environment and reports where each value comes from", async () => {
    const view = await settingsView();
    expect(view.find((s) => s.key === "WEBHOOK_VERIFY_TOKEN")).toMatchObject({ source: "env" });
    expect(view.find((s) => s.key === "RUNWAY_API_KEY")).toMatchObject({ source: "unset", display: "" });
    await setSetting("OPENREPLY_DEFER_KEYWORDS", "PRICE, SIZE");
    expect(await setting("OPENREPLY_DEFER_KEYWORDS")).toBe("PRICE, SIZE");
    await clearSetting("OPENREPLY_DEFER_KEYWORDS");
    expect(await setting("OPENREPLY_DEFER_KEYWORDS")).toBe("LINK,GUIDE");
  });

  it("validates choices and rejects unknown keys", async () => {
    await expect(setSetting("LLM_PROVIDER", "skynet")).rejects.toThrow(/must be one of/);
    await expect(setSetting("NOT_A_KEY", "x")).rejects.toThrow(/Unknown setting/);
    expect(mask("short")).toBe("••••");
    expect(SETTINGS.every((s) => ["llm", "generation", "storage", "instagram", "openreply", "alerts"].includes(s.group))).toBe(true);
  });

  it("the LLM picks up a new key or model without a restart", async () => {
    await setSetting("LLM_API_KEY", "sk-ant-test-1");
    await setSetting("LLM_MODEL", "claude-sonnet-5");
    const built: string[] = [];
    const fake = (c: { apiKey?: string; model: string }): LLMProvider => {
      built.push(`${c.apiKey}/${c.model}`);
      return { name: "fake", modelFor: () => c.model, complete: async () => ({ text: "{}", model: c.model, inputTokens: 1, outputTokens: 1 }) };
    };
    const p = new SettingsProvider(llmConfig, fake);
    await p.complete({ system: "", messages: [], tier: "smart", maxTokens: 1, operation: "t" } as never);
    await p.complete({ system: "", messages: [], tier: "smart", maxTokens: 1, operation: "t" } as never);
    await setSetting("LLM_MODEL", "claude-opus-5-5");
    await p.complete({ system: "", messages: [], tier: "smart", maxTokens: 1, operation: "t" } as never);
    expect(built).toEqual(["sk-ant-test-1/claude-sonnet-5", "sk-ant-test-1/claude-opus-5-5"]);
  });
});

describe("bootstrap (v0 → v1 upgrade path)", () => {
  it("imports the file persona into influencer #1, creates its soul, catalog and policy; idempotent", async () => {
    const inf = await one<{ slug: string; name: string; avatar_url: string }>("SELECT slug, name, avatar_url FROM influencers WHERE id = 1");
    expect(inf).toMatchObject({ slug: "zuri", name: "Zuri", avatar_url: expect.stringContaining("zuri-face-v2") });
    const souls = await many<{ soul_id: string; status: string }>("SELECT soul_id, status FROM souls");
    expect(souls).toEqual([{ soul_id: "soul_zuri_v1", status: "active" }]);
    expect(await one("SELECT count(*)::int AS n FROM generation_providers")).toEqual({ n: 8 });
    const policy = await one<{ mode: string }>("SELECT mode FROM generation_policies WHERE influencer_id = 0");
    expect(policy!.mode).toBe("preferred_fallback");
    await bootstrap();
    await bootstrap();
    expect(await many("SELECT 1 FROM souls")).toHaveLength(1);
    expect(await many("SELECT 1 FROM persona_versions WHERE influencer_id = 1")).toHaveLength(1);
  });
});

describe("version", () => {
  it("matches package.json", () => {
    expect(VERSION).toBe(JSON.parse(readFileSync("package.json", "utf8")).version);
  });
});
