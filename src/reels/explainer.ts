import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { z } from "zod";
import { PermanentError } from "../lib/errors.js";
import { ffmpegPath, withTemp } from "../media/video.js";
import { fonts } from "../render/compose.js";
import { frameSvg, rowCenters, screenSchema, type OsStyle, type Screen } from "./screens.js";

/**
 * The explainer segment of a tips reel: each step shows the screen, the finger
 * moves to the row to tap, taps (ripple + pressed row), a switch flips if the
 * step toggles something, and the next screen slides in like real navigation.
 */

export const stepSchema = z.object({
  say: z.string().describe("The on-screen caption for this step, max 50 chars, e.g. 'Tap Battery'"),
  screen: screenSchema,
  tap: z.string().nullable().describe("Exact label of the row tapped on this screen, or null when the step just shows the result"),
});
export type Step = z.infer<typeof stepSchema>;

export const FPS = 30;
const W = 1080;
const H = 1920;

interface Timeline {
  frames: number;
  at: (f: number) => Parameters<typeof frameSvg>[0];
}

const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : 1 - Math.pow(1 - t, 3));

/** Seconds per step: enough to read the caption and see the tap. */
export function stepSeconds(step: Step, last: boolean): number {
  const toggles = step.tap ? step.screen.rows.find((r) => r.label === step.tap)?.toggle !== null : false;
  return (step.tap ? 2.4 : 1.8) + (toggles ? 0.4 : 0) + (last ? 0.8 : 0.35);
}

export function explainerTimeline(steps: Step[], o: { os: OsStyle; bg: [string, string] }): Timeline {
  if (!steps.length) throw new PermanentError("an explainer needs at least one step");
  const spans = steps.map((s, i) => Math.round(stepSeconds(s, i === steps.length - 1) * FPS));
  const starts = spans.map((_, i) => spans.slice(0, i).reduce((a, b) => a + b, 0));
  const total = spans.reduce((a, b) => a + b, 0);
  return {
    frames: total,
    at: (f) => {
      let i = starts.findLastIndex((s) => f >= s);
      if (i < 0) i = 0;
      const step = steps[i];
      const t = (f - starts[i]) / FPS; // seconds into this step
      const span = spans[i] / FPS;
      const tapIdx = step.tap ? step.screen.rows.findIndex((r) => r.label === step.tap) : -1;
      const target = tapIdx >= 0 ? rowCenters(step.screen, o.os)[tapIdx] : undefined;
      const toggles = tapIdx >= 0 && step.screen.rows[tapIdx].toggle !== null;
      const tapAt = 0.55;
      const next = steps[i + 1];
      const slideStart = span - 0.35;
      const slide = next && t > slideStart ? ease((t - slideStart) / 0.35) : 0;
      const pressed = target && t >= tapAt && t < tapAt + (toggles ? 1.2 : 0.5) ? tapIdx : -1;
      const toggleT = toggles ? ease((t - tapAt - 0.15) / 0.3) : 0;
      // Keep a toggled row in its new state for the rest of the step.
      const screen: Screen = toggles && t > tapAt + 0.45 ? { ...step.screen, rows: step.screen.rows.map((r, k) => (k === tapIdx ? { ...r, toggle: !r.toggle } : r)) } : step.screen;
      const finger = target
        ? {
            x: target.x + (1 - ease(t / tapAt)) * 120,
            y: target.y + (1 - ease(t / tapAt)) * 260,
            alpha: t < tapAt + 0.9 ? Math.min(1, t / 0.2) : Math.max(0, 1 - (t - tapAt - 0.9) / 0.25),
            ripple: t >= tapAt && t < tapAt + 0.4 ? (t - tapAt) / 0.4 : 0,
          }
        : undefined;
      return {
        screen,
        next: next?.screen,
        slide,
        state: { pressed: toggles && t > tapAt + 0.45 ? -1 : pressed, toggleT: toggles && t <= tapAt + 0.45 ? toggleT : 0 },
        finger: slide > 0 ? undefined : finger,
        caption: step.say,
        stepLabel: steps.length > 1 ? `Step ${i + 1} of ${steps.length}` : undefined,
        bg: o.bg,
        os: o.os,
      };
    },
  };
}

/** Render the explainer to an MP4 (H.264, silent AAC track, 1080x1920, 30 fps). */
export async function renderExplainer(steps: Step[], o: { os: OsStyle; bg: [string, string] }): Promise<{ mp4: Buffer; seconds: number }> {
  const tl = explainerTimeline(steps, o);
  const fontFiles = fonts();
  return withTemp(async (dir) => {
    const out = join(dir, "explainer.mp4");
    const args = ["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "-", "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100", "-map", "0:v", "-map", "1:a", "-shortest", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out];
    const proc = spawn(ffmpegPath(), args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += String(d)));
    const done = new Promise<void>((resolve, reject) => {
      proc.on("error", reject);
      proc.on("close", (code) => (code === 0 ? resolve() : reject(new PermanentError(`explainer render failed: ${stderr.slice(-300)}`))));
    });
    let prev = "";
    let prevPixels: Buffer | undefined;
    for (let f = 0; f < tl.frames; f++) {
      const svg = frameSvg(tl.at(f));
      // Held frames are identical: render once, write again.
      if (svg !== prev || !prevPixels) {
        const img = new Resvg(svg, { fitTo: { mode: "width", value: W }, font: { fontFiles, loadSystemFonts: false, defaultFontFamily: "Inter" } }).render();
        prevPixels = Buffer.from(img.pixels);
        prev = svg;
      }
      if (!proc.stdin.write(prevPixels)) await new Promise((r) => proc.stdin.once("drain", r));
    }
    proc.stdin.end();
    await done;
    return { mp4: await readFile(out), seconds: tl.frames / FPS };
  });
}
