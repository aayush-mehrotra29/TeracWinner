import assert from "node:assert/strict";
import test from "node:test";
import { saveFollowupMessages } from "../../src/lib/api/followup-messages";
import { followupRequestFingerprint, parseFollowupOptions } from "../../src/lib/api/followup-input";
import { ApiError } from "../../src/lib/api/http";
import type { createAdminClient } from "../../src/lib/db/admin";

type Row = Record<string, unknown>;

function messageDb(initial: Row[] = []) {
  const rows = [...initial];
  const db = {
    from(table: string) {
      assert.equal(table, "messages");
      return {
        insert(record: Row) {
          return { select: () => ({ single: async () => {
            const duplicate = rows.some((row) => row.owner_id === record.owner_id &&
              row.idempotency_key === record.idempotency_key && row.role === record.role);
            if (duplicate) return { data: null, error: { code: "23505" } };
            const saved = { ...record, id: `message-${rows.length + 1}` };
            rows.push(saved);
            return { data: saved, error: null };
          } }) };
        },
        select() {
          const filters: Array<[string, unknown]> = [];
          const query = {
            eq(key: string, value: unknown) { filters.push([key, value]); return query; },
            maybeSingle: async () => ({
              data: rows.find((row) => filters.every(([key, value]) => row[key] === value)) ?? null,
              error: null,
            }),
          };
          return query;
        },
      };
    },
  } as unknown as ReturnType<typeof createAdminClient>;
  return { db, rows };
}

const content = "Please include the new source in the research";
const fingerprint = followupRequestFingerprint(content,
  parseFollowupOptions({ urls: ["https://example.org/new"] }));
const args = {
  projectId: "project-1", ownerId: "owner-1", runId: "run-2", requestKey: "request-1",
  content, requestFingerprint: fingerprint, answer: "A versioned run has started.", answerCitations: [],
};

test("retry completes chat records after a run was committed with no messages", async () => {
  const { db, rows } = messageDb();
  const first = await saveFollowupMessages(db, args);
  const retry = await saveFollowupMessages(db, args);
  assert.equal(rows.length, 2);
  assert.equal(retry.message.id, first.message.id);
  assert.equal(retry.answer.id, first.answer.id);
  assert.deepEqual(first.message.citations, [fingerprint]);
});

test("retry repairs a saved user message when the assistant insert failed", async () => {
  const savedUser = {
    id: "message-1", project_id: args.projectId, owner_id: args.ownerId,
    run_id: args.runId, idempotency_key: args.requestKey,
    role: "user", content, citations: [fingerprint],
  };
  const { db, rows } = messageDb([savedUser]);
  const recovered = await saveFollowupMessages(db, args);
  assert.equal(rows.length, 2);
  assert.equal(recovered.message.id, "message-1");
  assert.equal(recovered.answer.role, "assistant");
});

test("recovery refuses a different attachment with the same idempotency key", async () => {
  const savedUser = {
    id: "message-1", project_id: args.projectId, owner_id: args.ownerId,
    run_id: args.runId, idempotency_key: args.requestKey,
    role: "user", content, citations: [fingerprint],
  };
  const { db, rows } = messageDb([savedUser]);
  const changed = followupRequestFingerprint(content,
    parseFollowupOptions({ urls: ["https://example.org/different"] }));
  await assert.rejects(saveFollowupMessages(db, { ...args, requestFingerprint: changed }),
    (error: unknown) => error instanceof ApiError && error.status === 409);
  assert.equal(rows.length, 1);
});
