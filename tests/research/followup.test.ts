import assert from "node:assert/strict";
import test from "node:test";
import { groundFollowupAnswer, reportCitationCatalog } from "../../src/lib/research/followup";
import type { ReportContent } from "../../src/lib/research/types";

const report = {
  questionAnswers: [{ question: "Where?", answer: "In a narrow audience.", evidenceIds: [] }],
  findings: [{ text: "A saved finding", evidenceIds: [], basis: "synthetic" }],
  strengths: [], weaknesses: [], recommendations: [],
  nextExperiment: { text: "Run a landing-page test", evidenceIds: [], basis: "assumption" },
  pricing: { note: "Benchmarks only" },
  sources: [{ id: "src:one", excerpt: "This public source provides a sufficiently detailed passage about a comparable product." }],
  humanAddendum: { findings: [{ text: "One respondent mentioned setup", evidenceIds: ["human:1"], basis: "human" }] },
} as unknown as ReportContent;

test("follow-up citation catalog exposes stable report point IDs", () => {
  assert.deepEqual(reportCitationCatalog(report).map((item) => item.id), [
    "report:questionAnswers:0", "report:findings:0", "report:nextExperiment:0", "report:pricing:0", "report:humanAddendum:0",
  ]);
});

test("answered follow-ups need a saved source or report point citation", () => {
  assert.equal(groundFollowupAnswer(report, { answer: "Yes", citations: [], requiresNewResearch: false }).requiresNewResearch, true);
  assert.equal(groundFollowupAnswer(report, { answer: "Yes", citations: ["report:findings:0"], requiresNewResearch: false }).requiresNewResearch, false);
  assert.equal(groundFollowupAnswer(report, { answer: "Yes", citations: ["report:findings:1"], requiresNewResearch: false }).requiresNewResearch, true);
  assert.equal(groundFollowupAnswer(report, { answer: "Needs a new study", citations: [], requiresNewResearch: true }).requiresNewResearch, true);
});
