import { currentInfluencer, influencerId } from "../context.js";
import { errorMessage } from "../lib/errors.js";
import { recordEvent } from "../lib/events.js";
import { generate } from "../generation/service.js";
import { persona } from "../persona/loader.js";
import { addCandidateReference } from "../souls/souls.js";
import { faceCandidatePrompts } from "./compose.js";
import { getInfluencer, setHatchState } from "./manage.js";

export interface FaceCandidate {
  url: string;
  prompt: string;
  provider?: string;
  model?: string;
}

/**
 * `hatch.faces` job: three face options for the soul step, generated through
 * the engine from the persona's appearance (text-to-image, no references).
 * Progress lives in influencers.hatch_state so the wizard page can poll it.
 */
export async function generateFaceCandidates(batch: string): Promise<{ made: number; failed: number }> {
  const inf = currentInfluencer();
  const p = persona();
  const prompts = faceCandidatePrompts(`${p.visual.character.appearance}. Hair: ${p.visual.character.hairstyle}. Skin tone: ${p.visual.character.skin_tone}. Build: ${p.visual.character.body_type}.`, p.identity.location);
  const state = (await getInfluencer(inf.id))!.hatch_state as { faces?: FaceCandidate[] };
  const faces: FaceCandidate[] = [...(state.faces ?? [])];
  let failed = 0;
  const errors: string[] = [];
  for (const [i, prompt] of prompts.entries()) {
    try {
      const r = await generate({
        influencerId: influencerId(),
        idempotencyKey: `hatch:${inf.id}:${batch}:face:${i}`,
        purpose: "soul",
        modality: "text_to_image",
        prompt,
        references: [],
        aspectRatio: "4:5",
        resolution: "2K",
        quality: "high",
        identityConsistency: "low",
      });
      const url = r.assets[0].url;
      await addCandidateReference(inf.id, url, `face option ${faces.length + 1}`);
      faces.push({ url, prompt, provider: r.provider, model: r.model });
      await setHatchState(inf.id, { faces, faces_status: "running" });
    } catch (e) {
      failed++;
      errors.push(errorMessage(e).slice(0, 200));
    }
  }
  await setHatchState(inf.id, { faces, faces_status: "done", faces_error: errors[0] ?? null });
  await recordEvent(failed ? "warn" : "info", "hatch", `Face candidates for ${inf.name}: ${prompts.length - failed} made`, { failed, errors });
  return { made: prompts.length - failed, failed };
}
