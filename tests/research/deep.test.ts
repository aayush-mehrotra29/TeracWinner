import assert from "node:assert/strict";
import test from "node:test";
import type { ResearchModels } from "../../src/lib/research/models";
import type { ResearchStore } from "../../src/lib/research/store";
import { IntegrationBlockedError } from "../../src/lib/providers/errors";
import { draftTotalUsd, getProviderSubmissions, humanAddendumDecision, prepareDeepStudy, savedAddendumMatches, validateDraft } from "../../src/lib/research/deep";
import { observeImages } from "../../src/lib/research/images";
import type { RunRow } from "../../src/lib/research/types";

function imageFixture(): { store: ResearchStore; run: RunRow } {
  const query = {
    select: () => query, eq: () => query,
    single: async () => ({ data: { path: "owner/image.png", mime_type: "image/png" }, error: null }),
  };
  const store = {
    db: {
      from: () => query,
      storage: { from: () => ({ download: async () => ({ data: new Blob([new Uint8Array([137, 80, 78, 71])]), error: null }) }) },
    },
  } as unknown as ResearchStore;
  const run = {
    id: "run", project_id: "project", owner_id: "owner", mode: "light_research", status: "running", stage: "world",
    input: { idea: "A new product", assetIds: ["asset-1"] }, version: 1, budget_usd: 1, spent_usd: 0,
  } satisfies RunRow;
  return { store, run };
}

test("ordinary image analysis failure is visibly labeled", async () => {
  const { store, run } = imageFixture();
  const models = { ask: async () => { throw new Error("invalid image data"); } } as unknown as ResearchModels;
  assert.deepEqual(await observeImages(store, run, models), [
    { assetId: "asset-1", observation: "Visual analysis failed: invalid image data", status: "failed" },
  ]);
});

test("credential or budget blocks during image analysis stop the run", async () => {
  const { store, run } = imageFixture();
  const models = { ask: async () => { throw new IntegrationBlockedError("budget exhausted", "budget"); } } as unknown as ResearchModels;
  await assert.rejects(observeImages(store, run, models), IntegrationBlockedError);
});

test("human addendum stays pending, then publishes on target or closed fieldwork, including late review", () => {
  assert.equal(humanAddendumDecision("launched", 1, 5, "active"), "pending");
  assert.equal(humanAddendumDecision("launched", 5, 5, "active"), "publish");
  assert.equal(humanAddendumDecision("launched", 1, 5, "completed"), "publish");
  assert.equal(humanAddendumDecision("completed", 4, 5, "completed"), "publish");
});

test("saved human addendum fingerprint allows a crash retry to reuse its report version", () => {
  const saved = { kind: "human_addendum", content: { metadata: { humanResponseFingerprint: "answers-v1", reportVersion: 2 } } };
  assert.equal(savedAddendumMatches(saved, "answers-v1"), true);
  assert.equal(savedAddendumMatches(saved, "answers-v2"), false);
  assert.equal(savedAddendumMatches({ ...saved, kind: "synthetic" }, "answers-v1"), false);
});

test("fresh Terac draft price is read from current opportunity pricing", () => {
  assert.equal(draftTotalUsd({ data: { pricing: { total_cost_cents: 75000 } } }), 750);
  assert.equal(draftTotalUsd({ opportunity: { pricing: { total_cost_cents: 1250 } } }), 12.5);
  assert.equal(draftTotalUsd({ data: { pricing: { total_cost_cents: "75000" } } }), null);
  assert.equal(draftTotalUsd({ data: { pricing: {} } }), null);
});

test("direct opportunity requires five participants and records Terac's all-in total", () => {
  const draft = {
    id: "opportunity-1", projectId: "project-1", internalTitle: "Orit run run-1",
    status: "draft", participantCount: 5, allInCostPerParticipantUsd: 42,
    totalUsd: 210, draftEditorUrl: "https://terac.com/draft/opportunity-1", raw: { id: "opportunity-1" },
  };
  const quote = validateDraft(draft);
  assert.equal(quote.amountUsd, 210);
  assert.equal(quote.costPerParticipantUsd, 42);
  assert.equal("requestedIncentiveUsd" in quote, false);
  assert.equal(quote.id, "opportunity-1");
  assert.throws(() => validateDraft({ ...draft, participantCount: 6 }), IntegrationBlockedError);
  assert.throws(() => validateDraft({ ...draft, participantCount: null }), IntegrationBlockedError);
  assert.throws(() => validateDraft({ ...draft, totalUsd: null }), IntegrationBlockedError);
});

test("sandbox test participants cannot unlock the first real response gate", () => {
  assert.deepEqual(getProviderSubmissions({ data: [
    { id: "test-1", status: "approved", participant_name: "Test Participant", opportunity_id: "opportunity-1" },
    { id: "test-2", status: "approved", is_test: true, opportunity_id: "opportunity-1" },
    { id: "human-1", status: "Work review", participant_name: "Research Participant", opportunity_id: "opportunity-1" },
    { id: "human-2", status: "Awaiting-Review", participant_name: "Research Participant", opportunity_id: "opportunity-1" },
  ] }), [
    { id: "human-1", status: "work_review", opportunityId: "opportunity-1" },
    { id: "human-2", status: "awaiting_review", opportunityId: "opportunity-1" },
  ]);
});

test("deep flow asks for an explicit audience before creating a form or calling a model", async () => {
  const { run } = imageFixture();
  run.mode = "deep_simulation";
  const priorKey = process.env.TERAC_API_KEY;
  process.env.TERAC_API_KEY = "test-only";
  const writes: string[] = [];
  const store = {
    finish: async (_run: RunRow, status: string) => { writes.push(status); },
    eventOnce: async (_run: RunRow, kind: string) => { writes.push(kind); },
  } as unknown as ResearchStore;
  try {
    assert.equal(await prepareDeepStudy(store, run), false);
    assert.deepEqual(writes, ["needs_input", "needs_input"]);
  } finally {
    if (priorKey === undefined) delete process.env.TERAC_API_KEY;
    else process.env.TERAC_API_KEY = priorKey;
  }
});

test("deep fieldwork blocks before any model call when Terac worker credentials are absent", async () => {
  const { run } = imageFixture();
  run.mode = "deep_simulation";
  run.input.audience = "US adults who buy this category";
  const priorKey = process.env.TERAC_API_KEY;
  delete process.env.TERAC_API_KEY;
  try {
    await assert.rejects(
      prepareDeepStudy({} as ResearchStore, run),
      (error: unknown) => error instanceof IntegrationBlockedError && /TERAC_API_KEY/.test(error.message),
    );
  } finally {
    if (priorKey === undefined) delete process.env.TERAC_API_KEY;
    else process.env.TERAC_API_KEY = priorKey;
  }
});
