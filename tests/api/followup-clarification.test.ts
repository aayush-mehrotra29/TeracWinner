import assert from "node:assert/strict";
import test from "node:test";
import {
  CLARIFICATION_MESSAGE_MARKER, ClarificationClaimLostError,
  isClarificationMessage, resumeClarification, resumeNewClarification,
} from "../../src/lib/api/followup-clarification";
import { ApiError } from "../../src/lib/api/http";
import type { createAdminClient } from "../../src/lib/db/admin";

type Row = Record<string, unknown>;
const message = {
  id: "message-1", project_id: "project-1", owner_id: "owner-1", run_id: "run-1",
  role: "user", content: "The buyers are independent US founders.", citations: [CLARIFICATION_MESSAGE_MARKER],
};

function fixture(failOnce?: "delete" | "event") {
  const run: Row = {
    id: "run-1", project_id: "project-1", owner_id: "owner-1", status: "needs_input",
    input: { idea: "A research studio for founders", clarifications: [] },
  };
  const artifacts: Row[] = [{
    run_id: "run-1", owner_id: "owner-1", kind: "intake", key: "main", data: { decision: "" },
  }];
  const events: Row[] = [];
  const messages: Row[] = [];
  let failure = failOnce;
  const matches = (row: Row, filters: Array<[string, unknown]>) =>
    filters.every(([key, value]) => row[key] === value);
  const rowsFor = (table: string) => table === "runs" ? [run]
    : table === "run_artifacts" ? artifacts : table === "messages" ? messages : events;
  const query = (table: string, action: "select" | "delete" | "update", patch?: Row) => {
    const filters: Array<[string, unknown]> = [];
    const execute = () => {
      if (action === "delete") {
        if (table === "run_artifacts" && failure === "delete") {
          failure = undefined; return { error: new Error("transient delete failure") };
        }
        const rows = rowsFor(table);
        const index = rows.findIndex((row) => matches(row, filters));
        if (index >= 0) rows.splice(index, 1);
        return { error: null };
      }
      if (action === "update") {
        if (!matches(run, filters)) return { data: null, error: null };
        Object.assign(run, patch);
        return { data: { ...run }, error: null };
      }
      return { data: rowsFor(table).filter((row) => matches(row, filters)), error: null };
    };
    const builder = {
      eq(key: string, value: unknown) { filters.push([key, value]); return builder; },
      select() { return builder; },
      maybeSingle: async () => {
        const result = execute();
        if (!result.data || !Array.isArray(result.data)) return result;
        return { data: result.data[0] ?? null, error: null };
      },
      then(resolve: (value: unknown) => void) { resolve(execute()); },
    };
    return builder;
  };
  const db = {
    from(table: string) {
      return {
        select: () => query(table, "select"),
        delete: () => query(table, "delete"),
        update: (patch: Row) => query(table, "update", patch),
        insert: async (record: Row) => {
          if (table === "run_events") {
            if (failure === "event") { failure = undefined; return { error: new Error("transient event failure") }; }
            events.push(record);
            return { error: null };
          }
          if (table === "run_artifacts") {
            if (artifacts.some((row) => row.run_id === record.run_id && row.kind === record.kind && row.key === record.key)) {
              return { error: { code: "23505" } };
            }
            artifacts.push(record);
            return { error: null };
          }
          throw new Error(`Unexpected insert into ${table}`);
        },
      };
    },
  } as unknown as ReturnType<typeof createAdminClient>;
  return { db, run, artifacts, events, messages };
}

const args = { projectId: "project-1", ownerId: "owner-1", runId: "run-1", message };

test("retry resumes after an archived intake and failed deletion", async () => {
  const { db, run, artifacts, events } = fixture("delete");
  await assert.rejects(resumeClarification(db, args), /transient delete failure/);
  assert.equal(artifacts.filter((row) => row.key === `before-clarification-${message.id}`).length, 1);
  const resumed = await resumeClarification(db, args);
  assert.equal(resumed.status, "queued");
  assert.deepEqual((run.input as Row).clarifications, [message.content]);
  assert.deepEqual((run.input as Row).resumedClarificationMessageIds, [message.id]);
  assert.equal(artifacts.some((row) => row.key === "main"), false);
  assert.equal(events.length, 1);
  await resumeClarification(db, args);
  assert.equal(events.length, 1);
  assert.deepEqual((run.input as Row).clarifications, [message.content]);
});

test("retry writes a missing event after the run was already queued", async () => {
  const { db, run, events } = fixture("event");
  await assert.rejects(resumeClarification(db, args), /transient event failure/);
  assert.equal(run.status, "queued");
  assert.equal(events.length, 0);
  await resumeClarification(db, args);
  assert.equal(events.length, 1);
  assert.deepEqual((run.input as Row).clarifications, [message.content]);
  run.status = "needs_input"; // A later stage asks a different clarification.
  await resumeClarification(db, args);
  assert.equal(run.status, "needs_input");
  assert.equal(events.length, 1);
});

test("clarification resume checks message ownership and the run association", async () => {
  const { db } = fixture();
  assert.equal(isClarificationMessage(message), true);
  await assert.rejects(resumeClarification(db, { ...args, ownerId: "other-owner" }),
    (error: unknown) => error instanceof ApiError && error.status === 409);
  await assert.rejects(resumeClarification(db, { ...args, message: { ...message, run_id: "another-run" } }),
    (error: unknown) => error instanceof ApiError && error.status === 409);
});

test("older clarification without a marker recovers after the run update", async () => {
  const { db, run, events } = fixture();
  run.status = "queued";
  run.input = { ...run.input as Row, clarifications: [message.content] };
  const olderMessage = { ...message, citations: [] };
  await resumeClarification(db, { ...args, message: olderMessage });
  assert.deepEqual((run.input as Row).clarifications, [message.content]);
  assert.equal(events.length, 1);
});

test("two distinct clarifications racing for one run remove only the losing new message", async () => {
  const { db, run, messages, events } = fixture();
  const second = { ...message, id: "message-2", content: "The buyers are US small business owners." };
  messages.push(message, second);
  const attempts = await Promise.allSettled([
    resumeNewClarification(db, { ...args, message, created: true }),
    resumeNewClarification(db, { ...args, message: second, created: true }),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === "rejected" &&
    attempt.reason instanceof ClarificationClaimLostError).length, 1);
  assert.equal(messages.length, 1);
  assert.deepEqual((run.input as Row).resumedClarificationMessageIds, [messages[0].id]);
  assert.deepEqual((run.input as Row).clarifications, [messages[0].content]);
  assert.equal(events.length, 1);
});

test("a failure after claiming the run keeps the new message for retry", async () => {
  const { db, run, messages } = fixture("event");
  messages.push(message);
  await assert.rejects(resumeNewClarification(db, { ...args, created: true }),
    /transient event failure/);
  assert.equal(run.status, "queued");
  assert.equal(messages.length, 1);
  await resumeNewClarification(db, { ...args, created: false });
  assert.equal(messages.length, 1);
});
