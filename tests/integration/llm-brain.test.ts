import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { setControls } from "../../src/config/controls.js";
import { clearSetting, setSetting } from "../../src/config/settings.js";
import { withInfluencerLoose } from "../../src/context.js";
import { many, one } from "../../src/db/pool.js";
import { brainFor, llmConfig } from "../../src/llm/llm.js";
import { resetState, teardown } from "../helpers/db.js";

beforeEach(async () => {
  await resetState();
  await one("INSERT INTO influencers (id, slug, name, status, hatched_at) VALUES (2, 'salima', 'Salima', 'active', now())");
  await setSetting("LLM_API_KEY", "sk-ant-test-0000000000");
});
afterAll(teardown);

describe("per-influencer language model brain", () => {
  it("runs an OpenAI influencer on the OpenAI key and models while the others stay on Claude", async () => {
    await setSetting("OPENAI_API_KEY", "sk-proj-test-0000000000");
    await setControls({ llm_brain: "openai" }, "test", 2);
    const salima = await withInfluencerLoose(2, () => llmConfig());
    expect(salima).toMatchObject({ provider: "openai_compatible", baseURL: "https://api.openai.com/v1", model: "gpt-6.1-sol", fastModel: "gpt-6-luna", apiKey: "sk-proj-test-0000000000" });
    const zuri = await withInfluencerLoose(1, () => llmConfig());
    expect(zuri.provider).not.toBe("openai_compatible");
    expect(zuri.apiKey).toBe("sk-ant-test-0000000000");
    await setSetting("OPENAI_MODEL", "gpt-5.6-terra");
    expect((await withInfluencerLoose(2, () => llmConfig())).model).toBe("gpt-5.6-terra");
    await clearSetting("OPENAI_MODEL");
  });

  it("keeps an OpenAI influencer on Claude with a warning when there is no OpenAI key", async () => {
    await clearSetting("OPENAI_API_KEY");
    await setControls({ llm_brain: "openai" }, "test", 2);
    expect(await brainFor(2)).toEqual({ wanted: "openai", active: "claude", reason: "no OpenAI API key on Config & keys" });
    expect((await withInfluencerLoose(2, () => llmConfig())).provider).not.toBe("openai_compatible");
    const events = await many<{ message: string }>("SELECT message FROM system_events WHERE source = 'llm'");
    expect(events.map((e) => e.message)).toContain("Set to the OpenAI brain but running on Claude: no OpenAI API key on Config & keys");
  });
});
