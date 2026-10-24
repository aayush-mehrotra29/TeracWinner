import assert from "node:assert/strict";
import test from "node:test";
import { canReviewStudyResponse } from "../../src/lib/study/review";

test("owner can review matched answers during fieldwork and after a late addendum", () => {
  assert.equal(canReviewStudyResponse("awaiting_response"), true);
  assert.equal(canReviewStudyResponse("collecting"), true);
  assert.equal(canReviewStudyResponse("completed"), true);
  assert.equal(canReviewStudyResponse("needs_approval"), false);
  assert.equal(canReviewStudyResponse("creating_form"), false);
});
