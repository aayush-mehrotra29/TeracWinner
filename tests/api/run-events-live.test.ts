import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createAdminClient } from "../../src/lib/db/admin";
import { localWorkspaceOwnerId } from "../../src/lib/api/workspace-identity";

const base = process.env.ORIT_RUN_EVENTS_TEST_URL;

test("live run events retain cursor order and owner scoping", { skip: !base }, async (t) => {
  const address = new URL(base!);
  assert.ok(["127.0.0.1", "localhost"].includes(address.hostname), "This smoke test only targets a local server");
  const get = async (path: string) => fetch(new URL(path, address), { headers: { accept: "application/json" } });

  const projectsResponse = await get("/api/projects");
  assert.equal(projectsResponse.status, 200);
  const projects = (await projectsResponse.json() as { projects: Array<{ id: string }> }).projects;
  let runId: string | null = null;
  for (const project of projects) {
    const detailResponse = await get(`/api/projects/${project.id}`);
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json() as { runs: Array<{ id: string }> };
    if (detail.runs[0]) { runId = detail.runs[0].id; break; }
  }
  if (!runId) { t.skip("Local workspace has no saved research run"); return; }

  assert.equal((await get(`/api/runs/${runId}/events?after=-1`)).status, 400);
  const firstResponse = await get(`/api/runs/${runId}/events?after=0`);
  assert.equal(firstResponse.status, 200);
  assert.match(firstResponse.headers.get("cache-control") ?? "", /no-store/);
  const first = await firstResponse.json() as { events: Array<{ seq: number }>; lastSequence: number; status: string };
  assert.ok(first.events.length <= 200);
  assert.ok(first.events.every((event, index) => index === 0 || event.seq > first.events[index - 1].seq));
  assert.equal(first.lastSequence, first.events.at(-1)?.seq ?? 0);

  if (first.events.length) {
    const after = first.events[0].seq;
    const resumedResponse = await get(`/api/runs/${runId}/events?after=${after}`);
    assert.equal(resumedResponse.status, 200);
    const resumed = await resumedResponse.json() as { events: Array<{ seq: number }> };
    assert.ok(resumed.events.every((event) => event.seq > after));
  }

  const snapshotResponse = await get(`/api/runs/${runId}`);
  assert.equal(snapshotResponse.status, 200);
  const snapshot = await snapshotResponse.json() as { run: { status: string }; events: Array<{ seq: number }> };
  assert.equal(snapshot.run.status, first.status);
  assert.ok(Array.isArray(snapshot.events));

  let foreignRunId = randomUUID();
  try {
    const { data, error } = await createAdminClient().from("runs").select("id")
      .neq("owner_id", localWorkspaceOwnerId()).limit(1);
    if (!error && data?.[0]) foreignRunId = data[0].id;
  } catch { /* A missing admin key still permits the unknown-run 404 check. */ }
  assert.equal((await get(`/api/runs/${foreignRunId}/events?after=0`)).status, 404);
});
