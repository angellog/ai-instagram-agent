import type { Persona } from "./schema.js";

/** Pronoun forms for prompts about this persona. Unset means neutral wording. */
export function pronouns(p: Persona): { subj: string; obj: string; poss: string; Subj: string; is: string } {
  const k = p.identity.pronouns ?? "they";
  const f = k === "she" ? { subj: "she", obj: "her", poss: "her", is: "is" } : k === "he" ? { subj: "he", obj: "him", poss: "his", is: "is" } : { subj: "they", obj: "them", poss: "their", is: "are" };
  return { ...f, Subj: f.subj[0].toUpperCase() + f.subj.slice(1) };
}

/** True when a caption names the brand (case-insensitive, ignores spaces and hyphens). */
export function namesBrand(text: string, brand: string | undefined): boolean {
  if (!brand) return false;
  const squash = (s: string) => s.toLowerCase().replace(/[\s\-_.]/g, "");
  return squash(text).includes(squash(brand));
}
