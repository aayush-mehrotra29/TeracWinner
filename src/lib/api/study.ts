import { createHash } from "node:crypto";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

export function approvalFingerprint(quote: unknown, materials: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable({ quote, materials }))).digest("hex");
}

export function isLaunchedApprovalRetry(study: {
  status: string; launched_at?: string | null; approved_fingerprint?: string | null;
}, fingerprint: string): boolean {
  return Boolean(study.launched_at) &&
    ["launched", "awaiting_response", "collecting", "completed"].includes(study.status) &&
    study.approved_fingerprint === fingerprint;
}
