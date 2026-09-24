import { similarity } from "../lib/text.js";
import type { RecentItem, VisualState } from "./history.js";

/**
 * Similarity / repetition score (brief §11). Checks recent topics, hooks,
 * captions, visual compositions, locations, activities, outfits and carousel
 * structures. Deterministic and explainable: every point of the score comes
 * with a reason the director sees when it is asked for an alternative.
 */

export interface Candidate {
  topic: string;
  hook: string;
  caption: string;
  structure: string;
  format: string;
  visual: VisualState;
}

export interface RepetitionResult {
  score: number;
  reasons: string[];
  components: Record<string, number>;
}

const WINDOW_CATEGORICAL = 3;

export function repetitionScore(c: Candidate, recent: RecentItem[]): RepetitionResult {
  const reasons: string[] = [];
  const comp: Record<string, number> = {};

  const maxSim = (get: (r: RecentItem) => string, value: string) => {
    let best = 0;
    let at: RecentItem | undefined;
    for (const r of recent) {
      const s = similarity(value, get(r));
      if (s > best) {
        best = s;
        at = r;
      }
    }
    return { best, at };
  };

  const topic = maxSim((r) => r.topic, c.topic);
  const hook = maxSim((r) => r.hook, c.hook);
  const caption = maxSim((r) => r.caption, c.caption);
  comp.topic = round(topic.best);
  comp.hook = round(hook.best * 0.95);
  comp.caption = round(caption.best * 0.9);
  const textual = Math.max(comp.topic, comp.hook, comp.caption);
  if (topic.best >= 0.5) reasons.push(`topic close to "${topic.at?.topic}" (${round(topic.best)})`);
  if (hook.best >= 0.5) reasons.push(`hook close to "${hook.at?.hook}" (${round(hook.best)})`);
  if (caption.best >= 0.5) reasons.push(`caption overlaps a recent caption (${round(caption.best)})`);

  const last = recent.slice(0, WINDOW_CATEGORICAL);
  let categorical = 0;
  const loc = c.visual.location_id;
  if (loc && last.some((r) => r.visual.location_id === loc)) {
    categorical += 0.15;
    comp.location = 0.15;
    reasons.push(`location "${loc}" used in the last ${WINDOW_CATEGORICAL} posts`);
  }
  const act = c.visual.activity;
  if (act && last.some((r) => r.visual.activity === act)) {
    categorical += 0.15;
    comp.activity = 0.15;
    reasons.push(`activity "${act}" posted recently`);
  }
  if (c.visual.outfit && last.some((r) => r.visual.outfit && similarity(r.visual.outfit, c.visual.outfit!) >= 0.6)) {
    categorical += 0.12;
    comp.outfit = 0.12;
    reasons.push("same outfit as a recent post");
  }
  if (recent[0] && recent[0].structure === c.structure && c.format === "carousel") {
    categorical += 0.12;
    comp.structure = 0.12;
    reasons.push(`same carousel structure "${c.structure}" as the previous post`);
  }
  const sig = (v: VisualState) => (v.compositions ?? []).join(">");
  if (c.visual.compositions?.length && last.some((r) => sig(r.visual) === sig(c.visual))) {
    categorical += 0.08;
    comp.composition = 0.08;
    reasons.push("identical shot sequence to a recent post");
  }

  return { score: round(Math.min(1, textual + categorical)), reasons, components: comp };
}

const round = (n: number) => Math.round(n * 1000) / 1000;
