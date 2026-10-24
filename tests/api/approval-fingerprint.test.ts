import assert from "node:assert/strict";
import test from "node:test";
import { approvalFingerprint, isLaunchedApprovalRetry } from "../../src/lib/api/study";

test("approval fingerprint ignores JSON key order but changes with cost or shared materials", () => {
  const quote = { id: "feasibility-123", amountUsd: 48, currency: "USD" };
  const materials = { audience: "US buyers", questions: [{ id: "choice", prompt: "Which?" }] };
  const approved = approvalFingerprint(quote, materials);

  assert.equal(approved, approvalFingerprint(
    { currency: "USD", amountUsd: 48, id: "feasibility-123" },
    { questions: [{ prompt: "Which?", id: "choice" }], audience: "US buyers" },
  ));
  assert.notEqual(approved, approvalFingerprint({ ...quote, amountUsd: 60 }, materials));
  assert.notEqual(approved, approvalFingerprint(quote, { ...materials, audience: "US students" }));
});

test("a launched study accepts only an exact replay of the owner-approved quote and materials", () => {
  const launched = { status: "awaiting_response", launched_at: "2026-10-24T18:00:00Z", approved_fingerprint: "exact" };
  assert.equal(isLaunchedApprovalRetry(launched, "exact"), true);
  assert.equal(isLaunchedApprovalRetry({ ...launched, status: "collecting" }, "exact"), true);
  assert.equal(isLaunchedApprovalRetry({ ...launched, status: "completed" }, "exact"), true);
  assert.equal(isLaunchedApprovalRetry(launched, "changed"), false);
  assert.equal(isLaunchedApprovalRetry({ ...launched, launched_at: null }, "exact"), false);
});
