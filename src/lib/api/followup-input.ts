import { createHash } from "node:crypto";
import { ApiError } from "./http";
import { parseResearchInput, type ResearchInput, type ResearchMode } from "./validation";

export interface FollowupOptions {
  urls?: string[];
  imageAssetIds?: string[];
  mode?: ResearchMode;
  startsNewRun: boolean;
}

const has = (value: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

export function parseFollowupOptions(body: unknown): FollowupOptions {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "Expected a JSON object.");
  }
  const data = body as Record<string, unknown>;
  const hasUrls = has(data, "urls");
  const hasImages = has(data, "imageAssetIds");
  const hasMode = has(data, "mode");
  // Reuse intake's public-HTTPS, asset-ID, mode, and per-request cap checks.
  const parsed = parseResearchInput({
    idea: "Follow-up research request",
    mode: hasMode ? data.mode : "light_research",
    urls: hasUrls ? data.urls : undefined,
    imageAssetIds: hasImages ? data.imageAssetIds : undefined,
  });
  return {
    urls: hasUrls ? parsed.urls : undefined,
    imageAssetIds: hasImages ? parsed.imageAssetIds : undefined,
    mode: hasMode ? parsed.mode : undefined,
    startsNewRun: hasUrls || hasImages || hasMode,
  };
}

export function followupRunInput(
  previous: unknown,
  idea: string,
  options: FollowupOptions,
  question: string,
  requestFingerprint: string,
): ResearchInput & { followupRequestFingerprint: string } {
  const prior = parseResearchInput(previous, idea);
  const urls = [...new Set([...prior.urls, ...(options.urls ?? [])])];
  const imageAssetIds = [...new Set([...prior.imageAssetIds, ...(options.imageAssetIds ?? [])])];
  // Validate the combined input too: each run still has at most five URLs and four images.
  const next = parseResearchInput({ ...prior, idea, mode: options.mode ?? prior.mode, urls, imageAssetIds });
  // The fingerprint is committed with the run before either chat message is saved.
  // A retry can then recover a partially written response without accepting a changed request.
  return { ...next, followupQuestion: question, followupRequestFingerprint: requestFingerprint };
}

export function followupRequestFingerprint(content: string, options: FollowupOptions): string {
  const request = JSON.stringify({
    content,
    urls: options.urls,
    imageAssetIds: options.imageAssetIds,
    mode: options.mode,
  });
  return `followup-request-sha256:${createHash("sha256").update(request).digest("hex")}`;
}

export function assertMatchingFollowupRequest(
  savedFingerprint: string | undefined,
  requestFingerprint: string,
  startsNewRun: boolean,
) {
  // Messages written before fingerprints existed can only be safely replayed as plain questions.
  if (savedFingerprint ? savedFingerprint !== requestFingerprint : startsNewRun) {
    throw new ApiError(409, "Idempotency key belongs to a different follow-up request.");
  }
}

export function assertMatchingSavedFollowupRun(input: unknown, requestFingerprint: string) {
  const saved = input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>).followupRequestFingerprint : undefined;
  assertMatchingFollowupRequest(typeof saved === "string" ? saved : undefined, requestFingerprint, true);
}
