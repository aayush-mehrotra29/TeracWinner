import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ResearchModels } from "../../src/lib/research/models";
import { ResearchStore } from "../../src/lib/research/store";
import type { RunRow } from "../../src/lib/research/types";
import { IntegrationBlockedError } from "../../src/lib/providers/errors";

type Row = Record<string, unknown>;

function fakeDb() {
  const tables: Record<string, Row[]> = { runs: [], run_artifacts: [], run_events: [], stage_attempts: [], provider_calls: [], model_calls: [] };
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    let write: { kind: "update" | "insert"; data: Row } | null = null;
    let descending = false;
    const matching = () => (tables[table] ?? []).filter((row) => filters.every(([key, value]) => row[key] === value));
    const applyWrite = () => {
      if (!write) return matching();
      if (write.kind === "insert") {
        const row = { ...write.data, id: write.data.id ?? `row:${(tables[table] ?? []).length + 1}` };
        tables[table] ??= [];
        tables[table].push(row);
        return [row];
      }
      return matching().map((row) => Object.assign(row, write!.data));
    };
    const builder = {
      select: () => builder,
      eq: (key: string, value: unknown) => { filters.push([key, value]); return builder; },
      order: (_key: string, options?: { ascending?: boolean }) => { descending = options?.ascending === false; return builder; },
      limit: async (count: number) => ({ data: (descending ? [...matching()].reverse() : matching()).slice(0, count), error: null }),
      maybeSingle: async () => ({ data: matching()[0] ?? null, error: null }),
      single: async () => ({ data: applyWrite()[0] ?? null, error: null }),
      insert: (data: Row) => { write = { kind: "insert", data }; return builder; },
      update: (data: Row) => { write = { kind: "update", data }; return builder; },
      upsert: async (data: Row) => {
        tables[table] ??= [];
        const existing = tables[table].find((row) => row.run_id === data.run_id && row.kind === data.kind && row.key === data.key);
        if (existing) Object.assign(existing, data);
        else tables[table].push({ ...data, id: `row:${tables[table].length + 1}` });
        return { error: null };
      },
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) => Promise.resolve({ data: applyWrite(), error: null }).then(resolve),
    };
    return builder;
  };
  return { tables, client: { from } as unknown as SupabaseClient };
}

function run(): RunRow {
  return {
    id: "00000000-0000-0000-0000-000000000001", project_id: "project", owner_id: "owner",
    mode: "light_research", status: "queued", stage: null, input: { idea: "Test idea" },
    version: 1, budget_usd: 1, spent_usd: 0,
  };
}

test("committed stage artifact resumes without repeating paid work", async () => {
  const db = fakeDb();
  const first = new ResearchStore(db.client);
  const record = run();
  let calls = 0;
  const value = await first.stage(record, "intake", "intake", async () => { calls++; return { audience: "buyers" }; }, record.input);
  assert.equal(value.audience, "buyers");
  const restarted = new ResearchStore(db.client);
  const resumed = await restarted.stage(record, "intake", "intake", async () => { calls++; throw new Error("must not run"); }, record.input);
  assert.deepEqual(resumed, value);
  assert.equal(calls, 1);
  assert.equal(db.tables.stage_attempts.length, 1);
  assert.equal(db.tables.stage_attempts[0].status, "completed");
});

test("failed stage attempt is recorded and retry increments attempt", async () => {
  const db = fakeDb();
  const store = new ResearchStore(db.client);
  const record = run();
  await assert.rejects(store.stage(record, "intake", "intake", async () => { throw new Error("provider unavailable"); }, record.input));
  await store.stage(record, "intake", "intake", async () => ({ audience: "buyers" }), record.input);
  assert.deepEqual(db.tables.stage_attempts.map((row) => [row.attempt, row.status]), [[1, "failed"], [2, "completed"]]);
});

test("model budget is checked before any external request", async () => {
  const db = fakeDb();
  const record = { ...run(), budget_usd: 0.00001 };
  const models = new ResearchModels(new ResearchStore(db.client), record);
  await assert.rejects(models.ask({
    stage: "intake", model: "gpt-6-luna", schemaName: "test_v1",
    schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    instructions: "Test", input: "hello", maxOutputTokens: 500,
  }), IntegrationBlockedError);
  assert.equal(db.tables.stage_attempts.length, 0);
});

test("provider call retains actual charge when saving returned data fails", async () => {
  const db = fakeDb();
  const record = run();
  const store = new ResearchStore(db.client);
  await assert.rejects(store.paidCall({
    run: record, stage: "evidence", provider: "exa", operation: "search", key: "first", reserveUsd: 0.03,
    work: async () => ({ costUsd: 0.07, requestId: "exa-request-1" }),
    save: async () => { throw new Error("artifact write failed"); },
  }));
  assert.equal(record.spent_usd, 0.07);
  assert.equal(db.tables.provider_calls[0].status, "failed");
  assert.equal(db.tables.provider_calls[0].cost_usd, 0.07);
  assert.equal(db.tables.provider_calls[0].request_id, "exa-request-1");
  await assert.rejects(store.paidCall({
    run: record, stage: "evidence", provider: "exa", operation: "search", key: "first", reserveUsd: 0.03,
    work: async () => { throw new Error("duplicate paid call"); },
    save: async () => {},
  }), IntegrationBlockedError);
});

test("actual provider overrun is recorded before blocking more work", async () => {
  const db = fakeDb();
  const record = { ...run(), budget_usd: 0.05 };
  const store = new ResearchStore(db.client);
  await assert.rejects(store.paidCall({
    run: record, stage: "evidence", provider: "exa", operation: "search", key: "overrun", reserveUsd: 0.03,
    work: async () => ({ costUsd: 0.08, requestId: "exa-overrun" }),
    save: async () => {},
  }), IntegrationBlockedError);
  assert.equal(record.spent_usd, 0.08);
  assert.equal(db.tables.provider_calls[0].status, "completed");
  assert.equal(db.tables.provider_calls[0].cost_usd, 0.08);
});

test("zero provider budget removes the cap while retaining cost records", async () => {
  const db = fakeDb();
  const record = { ...run(), budget_usd: 0 };
  const store = new ResearchStore(db.client);
  const response = await store.paidCall({
    run: record, stage: "evidence", provider: "exa", operation: "search", key: "uncapped", reserveUsd: 0.03,
    work: async () => ({ costUsd: 0.08, requestId: "exa-uncapped" }),
    save: async () => {},
  });
  assert.equal(response.costUsd, 0.08);
  assert.equal(record.spent_usd, 0.08);
  assert.equal(db.tables.provider_calls[0].status, "completed");
});

test("completed model output is replayed from a durable checkpoint", async () => {
  const db = fakeDb();
  const record = { ...run(), budget_usd: 0 };
  const store = new ResearchStore(db.client);
  const models = new ResearchModels(store, record);
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({
      id: "resp_saved", status: "completed", output_text: JSON.stringify({ answer: "saved" }),
      usage: { input_tokens: 100, output_tokens: 20 },
    }), { status: 200 });
  }) as typeof fetch;
  const args = {
    stage: "intake" as const, model: "gpt-6-luna" as const, schemaName: "checkpoint_test_v1",
    schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
    instructions: "Test", input: "idea", maxOutputTokens: 100,
  };
  try {
    assert.deepEqual(await models.ask(args), { answer: "saved" });
    assert.deepEqual(await new ResearchModels(new ResearchStore(db.client), record).ask(args), { answer: "saved" });
    assert.equal(calls, 1);
    assert.equal(db.tables.model_calls.length, 1);
    assert.equal(db.tables.model_calls[0].status, "completed");
    assert.equal(db.tables.run_artifacts.filter((row) => row.kind === "model_output").length, 1);
    assert.ok(record.spent_usd > 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});
