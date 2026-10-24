import assert from "node:assert/strict";
import test from "node:test";
import { emailRunKey, inputFromEmail, type ClaimedIntake } from "../../src/lib/outreach/research-handoff";

const row: ClaimedIntake = {
  message_key: "gmail:thread:42", sender: "buyer@example.com", subject: "Our snack idea",
  body_text: "A crunchy snack made from seaweed and rice, with Korean street-food flavors.",
  body_incomplete: false, attachment_names: ["package.png"],
  received_at: "2026-10-24T15:00:00.000Z", research_attempts: 1,
  research_claim_token: "3fb50536-b324-4da4-b25a-c0f84e4ea3c9",
  analysis: {
    category: "product_submission", summary: "Snack concept", product_name: "Seoul Street",
    product_description: "A crunchy seaweed and rice snack inspired by Seoul street food.",
    product_url: "http://127.0.0.1/private", target_audience: null,
    research_question: null, order_reference: "BOX-42", missing_information: ["Image not read"],
    next_action: "needs_details",
  },
};

test("product email starts a text-based light simulation even when an attachment is unread", () => {
  const result = inputFromEmail(row);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.input.mode, "light_simulation");
  assert.deepEqual(result.input.imageAssetIds, []);
  assert.deepEqual(result.input.urls, []);
  assert.match(result.input.idea, /Seoul Street/);
  assert.match(result.input.audience ?? "", /did not specify/);
});

test("irrelevant and incomplete emails do not start a run", () => {
  assert.equal(inputFromEmail({ ...row, analysis: { ...(row.analysis as object), category: "spam" } }).status, "skipped");
  assert.equal(inputFromEmail({ ...row, body_incomplete: true }).status, "needs_details");
  assert.equal(inputFromEmail({ ...row, body_text: "", analysis: { ...(row.analysis as object), product_description: null } }).status, "needs_details");
});

test("message key produces one stable bounded run key", () => {
  const first = emailRunKey(row.message_key);
  assert.equal(first, emailRunKey(row.message_key));
  assert.notEqual(first, emailRunKey("gmail:thread:43"));
  assert.ok(first.length <= 128);
});
