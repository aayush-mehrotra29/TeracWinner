import assert from "node:assert/strict";
import test from "node:test";
import { sendClaimedReport } from "../../src/lib/outreach/report-outbox";
import type { PreparedReportDelivery } from "../../src/lib/outreach/report-delivery";

const prepared = {
  deliveryKey: "report:test:v1",
  email: { messageId: "<report-test@gmail.com>", to: "customer@example.com" },
} as PreparedReportDelivery;

test("a durable claim precedes Gmail and one accepted send is recorded", async () => {
  const actions: string[] = [];
  const worked = await sendClaimedReport(prepared, {
    claim: async (id) => { actions.push(`claim:${id}`); return true; },
    send: async () => { actions.push("send"); },
    markSent: async () => { actions.push("sent"); },
    markUncertain: async () => { actions.push("uncertain"); },
  });
  assert.equal(worked, true);
  assert.deepEqual(actions, ["claim:<report-test@gmail.com>", "send", "sent"]);
});

test("a competing worker that loses the claim never sends", async () => {
  let sends = 0;
  const worked = await sendClaimedReport(prepared, {
    claim: async () => false,
    send: async () => { sends += 1; },
    markSent: async () => { throw new Error("unexpected"); },
    markUncertain: async () => { throw new Error("unexpected"); },
  });
  assert.equal(worked, false);
  assert.equal(sends, 0);
});

test("an SMTP timeout after claim is held for review without retry", async () => {
  const actions: string[] = [];
  await sendClaimedReport(prepared, {
    claim: async () => { actions.push("claim"); return true; },
    send: async () => { actions.push("send"); throw new Error("connection dropped after DATA"); },
    markSent: async () => { actions.push("sent"); },
    markUncertain: async (reason) => { actions.push(`uncertain:${reason}`); },
  });
  assert.deepEqual(actions, ["claim", "send", "uncertain:connection dropped after DATA"]);
});

test("if sent status cannot be confirmed, delivery stays uncertain", async () => {
  const actions: string[] = [];
  await sendClaimedReport(prepared, {
    claim: async () => true,
    send: async () => { actions.push("send"); },
    markSent: async () => { throw new Error("database timeout"); },
    markUncertain: async (reason) => { actions.push(reason); },
  });
  assert.deepEqual(actions, ["send", "Gmail accepted the PDF but status recording failed: database timeout"]);
});
