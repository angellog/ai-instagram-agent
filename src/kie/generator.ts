import sharp from "sharp";
import { env, kieKeys } from "../config/env.js";
import { download } from "../storage/host.js";
import { KieClient } from "./client.js";
import { modelSpec, type ImageRequest } from "./models.js";

export interface GeneratedImage {
  bytes: Buffer;
  sourceUrl: string;
  model: string;
  taskId: string;
  credits: number;
  latencyMs: number;
}

export interface ImageGenerator {
  readonly name: string;
  readonly model: string;
  estimateCredits(): number;
  /** Submit and wait. `onSubmitted` persists the task id before polling so a crash can resume. */
  generate(req: ImageRequest, onSubmitted?: (taskId: string, keyIndex: number) => Promise<void>): Promise<GeneratedImage>;
  /** Resume waiting on a task submitted by an earlier attempt. */
  resume?(taskId: string, keyIndex?: number): Promise<GeneratedImage>;
}

export class KieImageGenerator implements ImageGenerator {
  readonly name = "kie";
  constructor(
    private readonly client: KieClient,
    readonly model: string,
  ) {}

  estimateCredits(): number {
    return modelSpec(this.model).estCredits;
  }

  async generate(req: ImageRequest, onSubmitted?: (taskId: string, keyIndex: number) => Promise<void>): Promise<GeneratedImage> {
    const started = Date.now();
    const spec = modelSpec(this.model);
    const { taskId, keyIndex } = await this.client.createTask(this.model, spec.build({ ...req, referenceUrls: req.referenceUrls.slice(0, spec.maxRefs) }));
    await onSubmitted?.(taskId, keyIndex);
    return this.finish(taskId, keyIndex, started);
  }

  async resume(taskId: string, keyIndex?: number): Promise<GeneratedImage> {
    return this.finish(taskId, keyIndex, Date.now());
  }

  private async finish(taskId: string, keyIndex: number | undefined, started: number): Promise<GeneratedImage> {
    const t = await this.client.waitForTask(taskId, keyIndex);
    const url = t.resultUrls[0];
    // kie result URLs expire (docs: 14 days, sometimes 24h); copy immediately.
    const bytes = await download(url);
    return {
      bytes,
      sourceUrl: url,
      model: this.model,
      taskId,
      credits: t.creditsConsumed ?? this.estimateCredits(),
      latencyMs: t.costTimeMs ?? Date.now() - started,
    };
  }
}

/**
 * Offline generator for development mode, dry-run demos and tests: a
 * deterministic 1080×1350 image whose colours derive from the prompt, so the
 * whole pipeline (validation, composition, hosting, QC) runs with no spend.
 */
export class MockImageGenerator implements ImageGenerator {
  readonly name = "mock";
  readonly model = "mock-image";
  calls = 0;

  estimateCredits(): number {
    return 0;
  }

  async generate(req: ImageRequest, onSubmitted?: (taskId: string, keyIndex: number) => Promise<void>): Promise<GeneratedImage> {
    this.calls++;
    const taskId = `mock-${Date.now()}-${this.calls}`;
    await onSubmitted?.(taskId, 0);
    let h = 0;
    for (const ch of req.prompt) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const c1 = `#${(h & 0xffffff).toString(16).padStart(6, "0")}`;
    const c2 = `#${((h >>> 8) & 0xffffff).toString(16).padStart(6, "0")}`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350">
      <defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
      <rect width="1080" height="1350" fill="url(#a)"/>
      <circle cx="540" cy="520" r="210" fill="#ffffff" fill-opacity="0.35"/>
      <rect x="330" y="760" width="420" height="380" rx="60" fill="#000000" fill-opacity="0.25"/></svg>`;
    const bytes = await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
    return { bytes, sourceUrl: `mock://${taskId}`, model: this.model, taskId, credits: 0, latencyMs: 5 };
  }
}

let instance: ImageGenerator | undefined;

export function imageGenerator(): ImageGenerator {
  if (!instance) {
    const e = env();
    instance =
      // Offline images only when asked for, or in development without a key.
      // Production without a key fails loudly in the KieClient constructor.
      e.MOCK_IMAGES || (kieKeys(e).length === 0 && e.NODE_ENV !== "production")
        ? new MockImageGenerator()
        : new KieImageGenerator(new KieClient({ keys: kieKeys(e), baseUrl: e.KIE_BASE_URL, uploadBaseUrl: e.KIE_UPLOAD_BASE_URL }), e.KIE_IMAGE_MODEL);
  }
  return instance;
}

export function setImageGenerator(g: ImageGenerator | undefined): void {
  instance = g;
}
