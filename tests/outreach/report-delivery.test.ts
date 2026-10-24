import assert from "node:assert/strict";
import test from "node:test";
import { prepareReportDelivery, sendReportPdf, type ReportDeliveryInput } from "../../src/lib/outreach/report-delivery";

const runId = "5a146527-2d8c-42a5-9265-bb2e0c624ddc";
const ownerId = "8fa7563f-e3d4-4238-af3a-87082f86cc7f";

function input(): ReportDeliveryInput {
  return {
    run: { id: runId, owner_id: ownerId, status: "completed" },
    intake: {
      message_key: "gmail:oritsoftware@gmail.com:12345",
      sender: "Customer@Example.com",
      research_run_id: runId,
      research_owner_id: ownerId,
      research_status: "linked",
    },
    report: {
      title: "Coffee packaging\nwith clearer claims",
      metadata: {
        runId,
        reportVersion: 2,
        generatedAt: "2026-10-24T00:00:00.000Z",
        modelIds: [],
        evidenceCount: 0,
        simulationCount: 0,
        humanStatus: "not_requested",
      },
    },
    pdf: new TextEncoder().encode("%PDF-1.7\nvalid test attachment"),
  };
}

test("report delivery targets only the linked intake sender with a PDF attachment", () => {
  const first = prepareReportDelivery(input());
  const second = prepareReportDelivery(input());
  assert.equal(first.deliveryKey, second.deliveryKey);
  assert.equal(first.email.messageId, second.email.messageId);
  assert.equal(first.email.to, "customer@example.com");
  assert.equal(first.email.from.address, "oritsoftware@gmail.com");
  assert.equal(first.email.subject, "Your Orit research report: Coffee packaging with clearer claims");
  assert.equal(first.email.attachments[0].filename, "orit-research-report-v2.pdf");
  assert.equal(first.email.attachments[0].contentType, "application/pdf");
  assert.deepEqual(first.email.attachments[0].content, Buffer.from(input().pdf));
  assert.match(first.email.text, /sources, assumptions, and limitations/);
  assert.notEqual(prepareReportDelivery({ ...input(), report: { ...input().report, metadata: { ...input().report.metadata, reportVersion: 3 } } }).deliveryKey, first.deliveryKey);
});

test("report delivery rejects a missing run, sender, owner, or final report linkage before SMTP", () => {
  const scenarios: Array<(value: ReportDeliveryInput) => void> = [
    (value) => { value.run.status = "running"; },
    (value) => { value.intake.research_status = "pending"; },
    (value) => { value.intake.research_run_id = "another-run"; },
    (value) => { value.intake.research_owner_id = "another-owner"; },
    (value) => { value.intake.message_key = "manual:unverified"; },
    (value) => { value.intake.sender = "other@example.com, attacker@example.com"; },
    (value) => { value.intake.sender = "oritsoftware@gmail.com"; },
    (value) => { value.pdf = new TextEncoder().encode("not a PDF"); },
    (value) => { value.report.metadata.runId = "another-run"; },
  ];
  for (const change of scenarios) {
    const value = input();
    change(value);
    assert.throws(() => prepareReportDelivery(value));
  }
});

test("mocked Gmail acceptance sends once; ambiguous failures are passed to the caller without retry", async () => {
  const prepared = prepareReportDelivery(input());
  let calls = 0;
  const accepted = await sendReportPdf(prepared, async (email) => {
    calls += 1;
    assert.equal(email.to, "customer@example.com");
    return { accepted: [email.to], rejected: [], messageId: email.messageId };
  });
  assert.equal(calls, 1);
  assert.equal(accepted.deliveryKey, prepared.deliveryKey);
  assert.equal(accepted.messageId, prepared.email.messageId);
  await assert.rejects(() => sendReportPdf(prepared, async () => {
    calls += 1;
    throw new Error("connection dropped after DATA");
  }), /connection dropped after DATA/);
  assert.equal(calls, 2);
  await assert.rejects(() => sendReportPdf(prepared, async () => ({ accepted: [], rejected: [prepared.email.to] })), /did not confirm acceptance/);
});
