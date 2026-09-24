// Build step: nothing to copy today (fonts, migrations and config are read
// from the repo root at runtime), but verify they exist so a broken image
// fails at build time instead of on the first carousel.
import { existsSync } from "node:fs";
const required = ["assets/fonts/ArchivoBlack-Regular.ttf", "assets/fonts/Inter-Bold.ttf", "assets/fonts/Inter-Medium.ttf", "db/migrations/001_init.sql", "config/persona.yaml"];
const missing = required.filter((p) => !existsSync(p));
if (missing.length) {
  console.error(`Missing runtime assets: ${missing.join(", ")}`);
  process.exit(1);
}
console.log("runtime assets present");
