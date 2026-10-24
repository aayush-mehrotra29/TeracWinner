import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMatchingFollowupRequest, assertMatchingSavedFollowupRun,
  followupRequestFingerprint, followupRunInput, parseFollowupOptions,
} from "../../src/lib/api/followup-input";
import { ApiError } from "../../src/lib/api/http";
import type { ResearchInput } from "../../src/lib/api/validation";

const imageA = "6b57880c-1fa2-4f91-b7db-609a9be85181";
const imageB = "6b57880c-1fa2-4f91-b7db-609a9be85182";
const prior: ResearchInput = {
  idea: "An AI market research studio for founders",
  mode: "light_research",
  concepts: ["A guided research workspace"],
  urls: ["https://example.com/pricing"],
  imageAssetIds: [imageA],
  audience: "Independent founders",
  geography: "US",
};

test("follow-up options validate public URLs, asset IDs, mode, and explicit presence", () => {
  assert.equal(parseFollowupOptions({ content: "What changed?" }).startsNewRun, false);
  assert.deepEqual(parseFollowupOptions({ content: "Use this", urls: ["https://example.org/a#b"],
    imageAssetIds: [imageB], mode: "light_simulation" }), {
    urls: ["https://example.org/a"], imageAssetIds: [imageB], mode: "light_simulation", startsNewRun: true,
  });
  assert.equal(parseFollowupOptions({ urls: [] }).startsNewRun, true);
  assert.throws(() => parseFollowupOptions({ urls: ["http://example.org"] }), /HTTPS/);
  assert.throws(() => parseFollowupOptions({ urls: ["https://localhost/admin"] }), /HTTPS/);
  assert.throws(() => parseFollowupOptions({ imageAssetIds: ["not-an-asset-id"] }), /asset ID/);
  assert.throws(() => parseFollowupOptions({ mode: "unbounded" }), /mode/);
});

test("attached sources and images merge into the next run without dropping saved context", () => {
  const options = parseFollowupOptions({ urls: ["https://example.com/pricing#plan", "https://example.org/reviews"],
    imageAssetIds: [imageA, imageB], mode: "deep_simulation" });
  const fingerprint = followupRequestFingerprint("Assess the updated concept", options);
  const next = followupRunInput(prior, prior.idea, options, "Assess the updated concept", fingerprint);
  assert.deepEqual(next.urls, ["https://example.com/pricing", "https://example.org/reviews"]);
  assert.deepEqual(next.imageAssetIds, [imageA, imageB]);
  assert.deepEqual(next.concepts, prior.concepts);
  assert.equal(next.audience, prior.audience);
  assert.equal(next.mode, "deep_simulation");
  assert.equal(next.followupQuestion, "Assess the updated concept");
  assert.equal(next.followupRequestFingerprint, fingerprint);
  assert.doesNotThrow(() => assertMatchingSavedFollowupRun(next, fingerprint));
  assert.throws(() => assertMatchingSavedFollowupRun(next, "different-fingerprint"),
    (error: unknown) => error instanceof ApiError && error.status === 409);
});

test("combined follow-up inputs cannot bypass per-run attachment caps", () => {
  const urls = ["a", "b", "c", "d", "e"].map((letter) => `https://${letter}.example.com/`);
  const images = [imageA, imageB,
    "6b57880c-1fa2-4f91-b7db-609a9be85183", "6b57880c-1fa2-4f91-b7db-609a9be85184"];
  assert.throws(() => followupRunInput({ ...prior, urls }, prior.idea,
    parseFollowupOptions({ urls: ["https://new.example.com"] }), "Compare", "fingerprint"), /URLs/);
  assert.throws(() => followupRunInput({ ...prior, imageAssetIds: images }, prior.idea,
    parseFollowupOptions({ imageAssetIds: ["6b57880c-1fa2-4f91-b7db-609a9be85185"] }), "Compare", "fingerprint"), /image assets/);
});

test("same idempotency key cannot replay a different attachment or mode request", () => {
  const first = parseFollowupOptions({ urls: ["https://example.org/source"] });
  const fingerprint = followupRequestFingerprint("Explore this", first);
  assert.doesNotThrow(() => assertMatchingFollowupRequest(fingerprint, fingerprint, true));
  const changedUrl = followupRequestFingerprint("Explore this",
    parseFollowupOptions({ urls: ["https://example.org/other"] }));
  assert.throws(() => assertMatchingFollowupRequest(fingerprint, changedUrl, true),
    (error: unknown) => error instanceof ApiError && error.status === 409);
  const changedMode = followupRequestFingerprint("Explore this",
    parseFollowupOptions({ urls: ["https://example.org/source"], mode: "deep_simulation" }));
  assert.throws(() => assertMatchingFollowupRequest(fingerprint, changedMode, true),
    (error: unknown) => error instanceof ApiError && error.status === 409);
  assert.throws(() => assertMatchingFollowupRequest(undefined, fingerprint, true),
    (error: unknown) => error instanceof ApiError && error.status === 409);
});
