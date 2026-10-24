import { createHash } from "node:crypto";

/** Stable A/B presentation order for a Terac submission across page reloads. */
export function studyConceptOrder(studyId: string, submissionId: string, concepts: string[]): string[] {
  const available = concepts.slice(0, 2);
  if (available.length !== 2) return available;
  const reverse = createHash("sha256").update(`${studyId}:${submissionId}`).digest()[0] % 2 === 1;
  return reverse ? [available[1], available[0]] : available;
}
