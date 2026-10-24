import assert from "node:assert/strict";
import test from "node:test";
import { studyConceptOrder } from "../../src/lib/study/presentation";

test("one-concept studies keep the only option", () => {
  assert.deepEqual(studyConceptOrder("study-1", "submission-1", ["A"]), ["A"]);
});

test("the same submission always receives the same option order", () => {
  const concepts = ["Concept A", "Concept B"];
  const original = studyConceptOrder("study-1", "submission-1", concepts);
  assert.deepEqual(studyConceptOrder("study-1", "submission-1", concepts), original);
  assert.deepEqual([...original].sort(), [...concepts].sort());
  assert.deepEqual(concepts, ["Concept A", "Concept B"]);
});

test("a series of independent submissions receives both presentation orders", () => {
  const concepts = ["Concept A", "Concept B"];
  const orders = new Set(Array.from({ length: 32 }, (_, index) =>
    studyConceptOrder("study-1", `submission-${index}`, concepts).join("|")));
  assert.equal(orders.size, 2);
});
