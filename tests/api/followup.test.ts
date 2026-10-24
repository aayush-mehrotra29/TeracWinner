import assert from "node:assert/strict";
import test from "node:test";
import { groundedFallback } from "../../src/lib/api/followup";
import type { ReportContent } from "../../src/lib/research/types";

const report = {
  sources: [{ id: "source:1" }],
  questionAnswers: [{
    question: "What objections do buyers have about onboarding?",
    answer: "Several buyers objected to a long setup process.",
    evidenceIds: ["source:1"],
  }],
  findings: [], strengths: [], weaknesses: [], recommendations: [],
  nextExperiment: { text: "", evidenceIds: [] },
  pricing: { note: "", benchmarks: [] },
} as unknown as ReportContent;

test("saved report answer cites its saved section and source", () => {
  assert.deepEqual(groundedFallback("What onboarding objections were found?", report), {
    answer: "From the saved report: Several buyers objected to a long setup process.",
    citations: ["report:questionAnswers:0", "source:1"],
    requiresNewResearch: false,
  });
});

test("saved synthetic finding can answer with a report citation when it has no external source", () => {
  const synthetic = {
    ...report,
    findings: [{ text: "Five of eight synthetic buyer contexts chose the status quo.", evidenceIds: [], basis: "synthetic" }],
  } as ReportContent;
  const answer = groundedFallback("What were the synthetic buyer findings?", synthetic);
  assert.equal(answer.requiresNewResearch, false);
  assert.deepEqual(answer.citations, ["report:findings:0"]);
});

test("uncovered questions request new research instead of inventing a finding", () => {
  const answer = groundedFallback("How many units will sell next year?", report);
  assert.equal(answer.requiresNewResearch, true);
  assert.deepEqual(answer.citations, []);
});
