/**
 * Per-model input adapters. kie's market models disagree on field names for
 * reference images (image_input / image_urls / input_urls) and on supported
 * aspect ratios; this is the one place that knows (docs/RESEARCH.md §3).
 */
export interface ImageRequest {
  prompt: string;
  referenceUrls: string[];
  aspectRatio: "4:5" | "3:4" | "1:1";
}

interface ModelSpec {
  maxRefs: number;
  /** Conservative pre-spend estimate used by the budget guard. */
  estCredits: number;
  build(r: ImageRequest): Record<string, unknown>;
}

export const MODELS: Record<string, ModelSpec> = {
  "nano-banana-pro": {
    maxRefs: 8,
    estCredits: 24,
    build: (r) => ({
      prompt: r.prompt.slice(0, 10_000),
      image_input: r.referenceUrls.slice(0, 8),
      aspect_ratio: r.aspectRatio,
      resolution: "2K",
      output_format: "jpg",
    }),
  },
  "nano-banana-2": {
    maxRefs: 14,
    estCredits: 16,
    build: (r) => ({
      prompt: r.prompt.slice(0, 20_000),
      image_input: r.referenceUrls.slice(0, 14),
      aspect_ratio: r.aspectRatio,
      resolution: "2K",
      output_format: "jpg",
    }),
  },
  "google/nano-banana-edit": {
    maxRefs: 10,
    estCredits: 8,
    build: (r) => ({
      prompt: r.prompt.slice(0, 5_000),
      image_urls: r.referenceUrls.slice(0, 10),
      aspect_ratio: r.aspectRatio,
      output_format: "jpeg",
    }),
  },
  "gpt-image-2-5-flare-image-to-image": {
    maxRefs: 16,
    estCredits: 12,
    build: (r) => ({
      prompt: r.prompt,
      input_urls: r.referenceUrls.slice(0, 16),
      aspect_ratio: r.aspectRatio === "4:5" ? "3:4" : r.aspectRatio,
      resolution: "2K",
    }),
  },
};

export function modelSpec(model: string): ModelSpec {
  const m = MODELS[model];
  if (!m) throw new Error(`Unsupported kie model "${model}". Supported: ${Object.keys(MODELS).join(", ")}`);
  return m;
}
