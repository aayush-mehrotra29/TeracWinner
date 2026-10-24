import assert from "node:assert/strict";
import test from "node:test";
import { badCitationIds, buildGraph, directionalVerdict, normalizePriceUnit, presentationOrder, pricingAnalysis, sourceSupportsPrice } from "../../src/lib/research/algorithm";
import type { BuyerEvaluation, EvidenceArtifact, IntakeArtifact, WorldModelArtifact } from "../../src/lib/research/types";

const evidence: EvidenceArtifact = {
  sources: ["a", "b", "c"].map((name) => ({
    id: `src:${name}`, url: `https://${name}.example.com`, title: name, publishedAt: null,
    excerpt: `${name} has documented positioning and customer objections in this public page excerpt.`, provider: "exa" as const, fetchedAt: "2026-10-24", category: "other" as const, limitations: [],
  })),
  claims: [
    { id: "claim:0", text: "A", sourceIds: ["src:a"], polarity: "supports", confidence: "medium" },
    { id: "claim:1", text: "B", sourceIds: ["src:b"], polarity: "challenges", confidence: "medium" },
  ],
  contradictions: [], gaps: [], searchQueries: [],
};

function choices(values: BuyerEvaluation["choice"][]): BuyerEvaluation[] {
  return values.map((choice, index) => ({
    id: `evaluation:buyer:${index + 1}`, contextId: `buyer:${index + 1}`, presentationOrder: ["concept_a", "concept_b", "status_quo"],
    choice, rationale: `${choice} rationale`, advantages: [], objections: [], evidenceIds: ["src:a"], uncertainty: "Some",
  }));
}

test("two concepts alternate presentation order; one concept never offers B", () => {
  assert.deepEqual(presentationOrder(0, 2), ["concept_a", "concept_b", "status_quo"]);
  assert.deepEqual(presentationOrder(1, 2), ["concept_b", "concept_a", "status_quo"]);
  assert.deepEqual(presentationOrder(1, 1), ["concept_a", "status_quo"]);
});

test("directional verdict requires a clear split and no unresolved contradiction", () => {
  const split = choices(["concept_a", "concept_a", "concept_a", "concept_b", "concept_b", "concept_b", "status_quo", "neither"]);
  assert.equal(directionalVerdict(split, evidence, []), "inconclusive");
  const clear = choices(["concept_a", "concept_a", "concept_a", "concept_a", "concept_a", "concept_a", "status_quo", "neither"]);
  assert.equal(directionalVerdict(clear, evidence, []), "favorable");
  assert.equal(directionalVerdict(clear, { ...evidence, contradictions: [{ claimIds: ["claim:0", "claim:1"], explanation: "Conflicting sources" }] }, []), "inconclusive");
  assert.equal(directionalVerdict(clear, { ...evidence, sources: evidence.sources.slice(0, 1) }, []), "inconclusive");
  assert.equal(directionalVerdict(clear, { ...evidence, sources: evidence.sources.map((source, index) => index === 2 ? { ...source, excerpt: "" } : source) }, []), "inconclusive");
  assert.equal(directionalVerdict(clear, { ...evidence, claims: evidence.claims.map((claim) => ({ ...claim, sourceIds: ["src:a"] })) }, []), "inconclusive");
  assert.equal(directionalVerdict(clear, evidence, [{ id: "s", variable: "feature", change: "X", contextIds: [], changedChoices: 3, result: "flip", evidenceIds: [] }]), "inconclusive");
  assert.equal(directionalVerdict(clear, evidence, [{ id: "s", variable: "feature", change: "X", contextIds: ["buyer:1"], changedChoices: 1, result: "one change", evidenceIds: [] }]), "inconclusive");
  const weak = choices(["concept_a", "concept_a", "status_quo", "status_quo", "status_quo", "status_quo", "neither", "neither"]);
  assert.equal(directionalVerdict(weak, evidence, []), "unfavorable");
  assert.equal(directionalVerdict(weak, evidence, [{ id: "s", variable: "message", change: "X", contextIds: ["buyer:3"], changedChoices: 1, result: "one change", evidenceIds: [] }]), "inconclusive");
});

test("price suggestions require unit economics and return three distinct values above floor", () => {
  const world: WorldModelArtifact = {
    customerFacts: [], externalClaims: [], interpretations: [], assumptions: [], alternativeSolutions: [], imageObservations: [],
    priceBenchmarks: [10, 11, 12].map((price, index) => ({ label: `comp ${index}`, price, unit: "item", sourceId: `src:${index}` })),
  };
  assert.equal(pricingAnalysis({ idea: "x", unitCost: 10, minimumGrossMargin: 0.5, priceUnit: "item" }, world).status, "test_prices");
  const result = pricingAnalysis({ idea: "x", unitCost: 10, minimumGrossMargin: 0.5, priceUnit: "item" }, world);
  assert.equal(result.testPrices.length, 3);
  assert.ok(result.testPrices.every((price) => price > 20));
  assert.deepEqual([...result.testPrices].sort((a, b) => a - b), result.testPrices);
  assert.equal(pricingAnalysis({ idea: "x" }, world).status, "benchmarks_only");
  assert.equal(pricingAnalysis({ idea: "x", unitCost: 1e308, minimumGrossMargin: 0.9, priceUnit: "item" }, world).marginFloor, null);
  assert.equal(normalizePriceUnit("per item"), normalizePriceUnit("item"));
  assert.equal(normalizePriceUnit("monthly"), normalizePriceUnit("/month"));
  assert.notEqual(normalizePriceUnit("annual"), normalizePriceUnit("monthly"));
  assert.equal(normalizePriceUnit("per 100 items"), null);
  assert.equal(sourceSupportsPrice(12.5, "month", "Plans start at $12.50 per month."), true);
  assert.equal(sourceSupportsPrice(1200, "year", "The annual license costs USD 1,200."), true);
  assert.equal(sourceSupportsPrice(12.5, "month", "The source says $120.50 per month."), false);
  assert.equal(sourceSupportsPrice(50, "month", "The license costs $50/year."), false);
  assert.equal(sourceSupportsPrice(50, "month", "The annual plan is $50, while the monthly plan is $60."), false);
  assert.equal(sourceSupportsPrice(60, "month", "The annual plan is $50, while the monthly plan is $60."), true);
  assert.equal(sourceSupportsPrice(12.5, "month", "No price is stated here."), false);
});

test("external report points must cite listed sources", () => {
  const base = { verdictReason: "", executiveSummary: "", questionAnswers: [], findings: [{ text: "Claim", evidenceIds: [], basis: "external" as const }], strengths: [], weaknesses: [], recommendations: [], nextExperiment: { text: "test", evidenceIds: [], basis: "assumption" as const }, pricingNote: "", caveats: [] };
  assert.deepEqual(badCitationIds(base, evidence), ["missing-external-citation:0"]);
  assert.deepEqual(badCitationIds({ ...base, findings: [{ text: "Claim", evidenceIds: ["src:unknown"], basis: "external" }] }, evidence), ["src:unknown"]);
  assert.deepEqual(badCitationIds({ ...base, findings: [], questionAnswers: [{ question: "How does it compare?", answer: "Better", evidenceIds: [], basis: "external" }] }, evidence), ["missing-external-citation:0"]);
  assert.deepEqual(badCitationIds({ ...base, findings: [{ text: "Claim", evidenceIds: ["src:a"], basis: "external" }] }, {
    ...evidence, sources: evidence.sources.map((source) => source.id === "src:a" ? { ...source, excerpt: "" } : source),
  }), ["src:a"]);
  assert.deepEqual(badCitationIds({ ...base, executiveSummary: "Supported by (src:a)." }, evidence), ["missing-external-citation:0"]);
  assert.deepEqual(badCitationIds({ ...base, executiveSummary: "Attributed to (src:unknown)." }, evidence), ["missing-external-citation:0", "unknown-inline-source-id:src:unknown"]);
});

test("graph includes traceable buyer outcomes and source claims", () => {
  const intake: IntakeArtifact = { decision: "Will it appeal?", audience: "buyers", geography: "United States", concepts: ["A"], searchTerms: [], missingFacts: [], customerFacts: [], assumptions: [] };
  const graph = buildGraph({ intake, evidence, contexts: [{ id: "buyer:1", label: "Buyer", job: "buy", budget: "$20", constraints: [], currentAlternative: "status quo", decisionCriteria: [], assumptions: [] }], evaluations: choices(["concept_a"]) });
  assert.ok(graph.nodes.some((node) => node.id === "evaluation:buyer:1" && node.kind === "outcome"));
  assert.ok(graph.edges.some((edge) => edge.source === "buyer:1" && edge.target === "evaluation:buyer:1"));
  assert.ok(graph.edges.some((edge) => edge.source === "src:a" && edge.target === "claim:0"));
});
