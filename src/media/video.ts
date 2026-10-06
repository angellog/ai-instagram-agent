import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegStatic from "ffmpeg-static";
import sharp from "sharp";
import { PermanentError } from "../lib/errors.js";

/**
 * Video and image preparation for Instagram. ffmpeg ships with the app
 * (ffmpeg-static), so the server never depends on a system install.
 * Reels: MP4, H.264 + AAC, 1080x1920, 30 fps, faststart, 3-90 seconds.
 */

export const REEL = { w: 1080, h: 1920, fps: 30, minS: 3, maxS: 90 } as const;

export function ffmpegPath(): string {
  const p = process.env.FFMPEG_PATH ?? (ffmpegStatic as unknown as string | null);
  if (!p) throw new PermanentError("ffmpeg is not available on this server");
  return p;
}

/** Run ffmpeg; resolves with stderr (where ffmpeg reports), rejects with its last lines. */
export function ffmpeg(args: string[], timeoutMs = 10 * 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath(), ["-hide_banner", ...args], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) reject(new PermanentError(`ffmpeg failed: ${String(stderr).split("\n").filter(Boolean).slice(-3).join(" | ") || err.message}`));
      else resolve(String(stderr));
    });
  });
}

export interface VideoInfo {
  durationS: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

/** Duration, size and audio of a video file, read from ffmpeg's own report. */
export async function probeVideo(path: string): Promise<VideoInfo> {
  // `-i` alone exits non-zero ("At least one output file must be specified"): read stderr either way.
  const out = await new Promise<string>((resolve) => execFile(ffmpegPath(), ["-hide_banner", "-i", path], { timeout: 60_000 }, (_e, _o, stderr) => resolve(String(stderr))));
  const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(out);
  const v = /Stream #\S+.*Video: [^\n]*?(\d{2,5})x(\d{2,5})/.exec(out);
  if (!d || !v) throw new PermanentError("that file isn't a readable video");
  const rot = /rotate\s*:\s*(-?\d+)|displaymatrix: rotation of (-?[\d.]+)/.exec(out);
  const rotated = rot && Math.abs(Number(rot[1] ?? rot[2])) % 180 === 90;
  return {
    durationS: Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]),
    width: rotated ? Number(v[2]) : Number(v[1]),
    height: rotated ? Number(v[1]) : Number(v[2]),
    hasAudio: /Stream #\S+.*Audio:/.test(out),
  };
}

/** A temp workspace that is always cleaned up. */
export async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "aia-media-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Any phone video → an Instagram-ready vertical reel: 1080x1920 (blurred fill
 * when the source isn't 9:16), 30 fps H.264/AAC, silent track added when the
 * source has none, trimmed to the reel limit.
 */
export async function toReelMp4(input: Buffer, opts: { maxS?: number } = {}): Promise<{ mp4: Buffer; info: VideoInfo }> {
  return withTemp(async (dir) => {
    const src = join(dir, "in");
    const out = join(dir, "out.mp4");
    await writeFile(src, input);
    const info = await probeVideo(src);
    if (info.durationS < REEL.minS) throw new PermanentError(`video is ${info.durationS.toFixed(1)}s; Instagram reels need at least ${REEL.minS}s`);
    const maxS = Math.min(opts.maxS ?? REEL.maxS, REEL.maxS);
    const { w, h, fps } = REEL;
    const filter = `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=24:2[bg];[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,fps=${fps},format=yuv420p[v]`;
    const args = ["-y", "-i", src];
    // Instagram expects an audio track: add silence when the clip has none.
    if (!info.hasAudio) args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
    args.push("-filter_complex", filter, "-map", "[v]", "-map", info.hasAudio ? "0:a:0" : "1:a:0");
    if (!info.hasAudio) args.push("-shortest");
    args.push("-t", String(maxS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-maxrate", "5M", "-bufsize", "10M", "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-movflags", "+faststart", out);
    await ffmpeg(args);
    const mp4 = await readFile(out);
    return { mp4, info: { ...(await probeVideo(out)) } };
  });
}

/** One frame (at `atS` seconds) as a JPEG: thumbnails, vision checks, reel covers. */
export async function frameAt(input: Buffer, atS = 1): Promise<Buffer> {
  return withTemp(async (dir) => {
    const src = join(dir, "in");
    const out = join(dir, "frame.jpg");
    await writeFile(src, input);
    await ffmpeg(["-y", "-ss", String(atS), "-i", src, "-frames:v", "1", "-q:v", "3", out]);
    return readFile(out);
  });
}

/**
 * A business photo → the shape the post needs: 4:5 feed (1080x1350, Instagram's
 * tallest feed shape and what every generated slide uses) or 9:16 story, centre-cropped.
 */
export async function toFeedJpeg(input: Buffer, target: "feed" | "story"): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const img = sharp(input, { failOn: "none" }).rotate();
  const meta = await img.metadata();
  if (!meta.width || !meta.height) throw new PermanentError("that file isn't a readable image");
  const [width, height] = target === "story" ? [1080, 1920] : [1080, 1350];
  const jpeg = await img.resize(width, height, { fit: "cover", position: "attention" }).jpeg({ quality: 90 }).toBuffer();
  return { jpeg, width, height };
}
