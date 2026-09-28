import type { Controls } from "./controls.js";

/** Operating modes, in order of how much goes out on its own. */
export const MODES: Array<{ key: Controls["mode"]; label: string; hint: string }> = [
  { key: "development", label: "Development", hint: "Mock providers, nothing leaves the system" },
  { key: "dry_run", label: "Dry run", hint: "Full pipeline, nothing is sent or published" },
  { key: "human_approval", label: "Human approval", hint: "Everything waits for you in Reviews" },
  { key: "autonomous", label: "Autonomous", hint: "Green goes out on its own; yellow waits" },
];
