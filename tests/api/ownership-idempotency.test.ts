import assert from "node:assert/strict";
import test from "node:test";
import { budgetForMode, createRun, ownedProject, ownedRun } from "../../src/lib/api/research";
import { ApiError } from "../../src/lib/api/http";
import type { createAdminClient } from "../../src/lib/db/admin";
import type { ResearchInput } from "../../src/lib/api/validation";

function readOnlyDb(tables: Record<string, Array<Record<string, unknown>>>) {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
        maybeSingle: async () => ({
          data: (tables[table] ?? []).find((row) => filters.every(([key, value]) => row[key] === value)) ?? null,
          error: null,
        }),
      };
      return query;
    },
  } as unknown as ReturnType<typeof createAdminClient>;
}

const initial: ResearchInput = {
  idea: "A refillable cleaning product for apartments",
  mode: "light_research", concepts: ["Refillable bottle"], urls: [], imageAssetIds: [],
  geography: "US",
};

function payload(input: ResearchInput) {
  return { ...input, assetIds: input.imageAssetIds, unitCost: null,
    minimumGrossMargin: null, priceUnit: input.priceUnit };
}

test("owner-scoped reads hide another user's project and run", async () => {
  const db = readOnlyDb({
    projects: [{ id: "project-1", owner_id: "owner-a" }],
    runs: [{ id: "run-1", project_id: "project-1", owner_id: "owner-a" }],
  });
  await assert.rejects(ownedProject(db, "project-1", "owner-b"), (error: unknown) =>
    error instanceof ApiError && error.status === 404);
  await assert.rejects(ownedRun(db, "run-1", "owner-b"), (error: unknown) =>
    error instanceof ApiError && error.status === 404);
});

test("a duplicate run key returns the original only for the same initial request", async () => {
  const original = { id: "run-1", project_id: "project-1", owner_id: "owner-a", idempotency_key: "request-1" };
  const db = readOnlyDb({
    projects: [{ id: "project-1", owner_id: "owner-a" }],
    runs: [original],
    run_input_versions: [{ run_id: "run-1", owner_id: "owner-a", revision: 1, input: payload(initial) }],
  });
  assert.deepEqual(await createRun(db, "owner-a", "project-1", initial, "request-1"), original);
  await assert.rejects(
    createRun(db, "owner-a", "project-1", { ...initial, concepts: ["A different product"] }, "request-1"),
    (error: unknown) => error instanceof ApiError && error.status === 409,
  );
});

test("zero research budget means no application-level spend cap", () => {
  const prior = process.env.RESEARCH_BUDGET_LIGHT_RESEARCH_USD;
  process.env.RESEARCH_BUDGET_LIGHT_RESEARCH_USD = "0";
  try {
    assert.equal(budgetForMode("light_research"), 0);
  } finally {
    if (prior === undefined) delete process.env.RESEARCH_BUDGET_LIGHT_RESEARCH_USD;
    else process.env.RESEARCH_BUDGET_LIGHT_RESEARCH_USD = prior;
  }
});
