import { currentInfluencer, influencerId } from "../context.js";
import { errorMessage } from "../lib/errors.js";
import { recordEvent } from "../lib/events.js";
import { generate } from "../generation/service.js";
import { persona } from "../persona/loader.js";
import { addCandidateReference } from "../souls/souls.js";
import { composePersona, faceCandidatePrompts, type HatchBrief } from "./compose.js";
import { getInfluencer, setHatchState, updatePersona } from "./manage.js";

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

/** Persona-writing progress, kept in influencers.hatch_state for the wizard page. */
export interface PersonaJobState {
  persona_status?: "queued" | "running" | "done" | "failed";
  persona_error?: string | null;
  persona_batch?: string;
  persona_queued_at?: string;
}

/** A queued or running persona job older than this is treated as lost (worker restart, crash). */
export const PERSONA_STALE_MS = 12 * 60_000;

export function personaJobActive(s: PersonaJobState, now = Date.now()): boolean {
  if (s.persona_status !== "queued" && s.persona_status !== "running") return false;
  const at = Date.parse(s.persona_queued_at ?? "");
  return !Number.isFinite(at) || now - at < PERSONA_STALE_MS;
}

/**
 * `hatch.persona` job: write the persona from the saved brief. A whole persona
 * takes the model a minute or more, so it never runs inside a page request.
 * Only the latest request (batch) for an influencer is honoured.
 */
export async function composePersonaForHatch(id: number, batch: string): Promise<{ status: string; name?: string }> {
  const inf = await getInfluencer(id);
  if (!inf) return { status: "gone" };
  const state = inf.hatch_state as PersonaJobState & { brief?: HatchBrief };
  if (state.persona_batch && state.persona_batch !== batch) return { status: "superseded" };
  if (!state.brief) {
    await setHatchState(id, { persona_status: "failed", persona_error: "no brief saved" });
    return { status: "failed" };
  }
  await setHatchState(id, { persona_status: "running" });
  try {
    const composed = await composePersona(state.brief);
    await updatePersona(id, composed.yaml, "", "hatch");
    await setHatchState(id, { persona_status: "done", persona_error: null, step: "persona" });
    await recordEvent("info", "hatch", `Persona drafted for ${composed.name}`);
    return { status: "done", name: composed.name };
  } catch (e) {
    const message = errorMessage(e).slice(0, 300);
    await setHatchState(id, { persona_status: "failed", persona_error: message });
    await recordEvent("warn", "hatch", `Persona draft failed for ${inf.name}: ${message}`);
    return { status: "failed" };
  }
}
