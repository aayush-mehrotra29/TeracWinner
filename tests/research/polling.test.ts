import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { humanPollPage } from "../../src/worker/polling";

test("deep-study polling advances past the first batch and wraps", async () => {
  const ids = ["run-a", "run-b", "run-c", "run-d", "run-e"];
  const db = {
    from: () => {
      const query = {
        select: () => query, eq: () => query, in: () => query, order: () => query,
        range: async (from: number, to: number) => ({
          data: ids.slice(from, to + 1).map((id) => ({ id })), count: ids.length, error: null,
        }),
      };
      return query;
    },
  } as unknown as SupabaseClient;
  const first = await humanPollPage(db, 0, 2);
  const second = await humanPollPage(db, first.nextCursor, 2);
  const third = await humanPollPage(db, second.nextCursor, 2);
  const wrapped = await humanPollPage(db, third.nextCursor, 2);
  assert.deepEqual([first.ids, second.ids, third.ids, wrapped.ids], [
    ["run-a", "run-b"], ["run-c", "run-d"], ["run-e"], ["run-a", "run-b"],
  ]);
});
