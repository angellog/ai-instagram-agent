import { env } from "../../config/env.js";
import type { ProviderAdapter } from "../types.js";
import { KieAdapter } from "./kie.js";
import { FalAdapter } from "./fal.js";
import { HiggsfieldAdapter } from "./higgsfield.js";
import { LumaAdapter } from "./luma.js";
import { MockAdapter } from "./mock.js";
import { ReplicateAdapter } from "./replicate.js";
import { RunwayAdapter } from "./runway.js";
import { TopviewAdapter } from "./topview.js";

/**
 * Provider adapter registry. Adding a provider = one adapter class here + its
 * models in catalog.ts; nothing else in the app changes (brief v2 §3).
 */
let registry: Map<string, ProviderAdapter> | undefined;

function build(): Map<string, ProviderAdapter> {
  const list: ProviderAdapter[] = [
    new KieAdapter(),
    new HiggsfieldAdapter(),
    new FalAdapter(),
    new ReplicateAdapter(),
    new RunwayAdapter(),
    new LumaAdapter(),
    new TopviewAdapter(),
    new MockAdapter(),
  ];
  return new Map(list.map((a) => [a.id, a]));
}

export function adapters(): Map<string, ProviderAdapter> {
  registry ??= build();
  return registry;
}

export function adapter(id: string): ProviderAdapter {
  const a = adapters().get(id);
  if (!a) throw new Error(`No adapter for provider "${id}"`);
  return a;
}

/** Test hook. */
export function registerAdapter(a: ProviderAdapter): void {
  adapters().set(a.id, a);
}

export function mockAllowed(): boolean {
  const e = env();
  return e.MOCK_IMAGES || e.NODE_ENV !== "production";
}
