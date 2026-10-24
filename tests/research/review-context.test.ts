import assert from "node:assert/strict";
import test from "node:test";
import { runSynthesis } from "../../src/lib/research/stages";
import type { ResearchModels } from "../../src/lib/research/models";
import type { ResearchStore } from "../../src/lib/research/store";
import type { SynthesisOutput } from "../../src/lib/research/schemas";
import type {
  BuyerContext, BuyerEvaluation, DiscussionArtifact, EvidenceArtifact, IntakeArtifact,
  RunRow, SensitivityScenario, WorldModelArtifact,
} from "../../src/lib/research/types";

test("skeptical review receives saved synthetic evidence and repairs an unknown inline source once", async () => {
  const run: RunRow = {
    id: "run", project_id: "project", owner_id: "owner", mode: "light_simulation",
    status: "running", stage: "review", input: { idea: "A refillable cleaner" }, version: 1,
    budget_usd: 0, spent_usd: 0,
  };
  const intake: IntakeArtifact = {
    decision: "Would renters choose it?", audience: "US apartment renters", geography: "United States",
    concepts: ["Refillable cleaner"], searchTerms: [], missingFacts: [], customerFacts: [], assumptions: [],
  };
  const evidence: EvidenceArtifact = {
    sources: [{
      id: "src:valid", url: "https://example.com", title: "Comparable product", publishedAt: null,
      excerpt: "A public comparable product lists refillable packaging and its current price for apartment renters.",
      provider: "exa", fetchedAt: "2026-10-24", category: "competitor", limitations: [],
    }],
    claims: [{ id: "claim:0", text: "Refillable packaging exists", sourceIds: ["src:valid"], polarity: "context", confidence: "medium" }],
    contradictions: [{ claimIds: ["claim:0", "claim:1"], explanation: "Conflicting positioning" }],
    gaps: [], searchQueries: [],
  };
  const world: WorldModelArtifact = {
    customerFacts: [], externalClaims: evidence.claims, interpretations: [], assumptions: ["Awareness is unknown"],
    alternativeSolutions: [], priceBenchmarks: [],
    imageObservations: [{ assetId: "image", observation: "Visual analysis failed", status: "failed" }],
  };
  const contexts: BuyerContext[] = [{
    id: "buyer:1", label: "Small apartment", job: "Clean a kitchen", budget: "$20",
    constraints: [], currentAlternative: "store brand", decisionCriteria: [], assumptions: [],
  }];
  const evaluations: BuyerEvaluation[] = [{
    id: "evaluation:buyer:1", contextId: "buyer:1", presentationOrder: ["concept_a", "status_quo"],
    choice: "status_quo", rationale: "Unclear value", advantages: [], objections: ["Cost"],
    evidenceIds: [], uncertainty: "Price unknown",
  }];
  const scenarios: SensitivityScenario[] = [{
    id: "scenario:message", variable: "message", change: "Explain refills", contextIds: [],
    changedChoices: 0, revisedChoices: { "buyer:1": "status_quo" }, result: "No change", evidenceIds: [],
  }];
  const discussion: DiscussionArtifact = {
    objection: "Cost", perspectives: [{ contextId: "buyer:1", position: "Wait" }],
    conclusion: "Cost remains unclear", independentChoicesUnchanged: true,
  };
  const draft: SynthesisOutput = {
    verdictReason: "Evidence is too thin", executiveSummary: "One buyer kept the status quo.",
    questionAnswers: [], findings: [{ text: "The synthetic buyer kept the status quo.", evidenceIds: [], basis: "synthetic" }],
    strengths: [], weaknesses: [], recommendations: [],
    nextExperiment: { text: "Test a concrete price", evidenceIds: [], basis: "assumption" },
    pricingNote: "No comparable price", caveats: [],
  };
  const stageKinds: string[] = [];
  const store = {
    stage: async (_run: RunRow, _stage: string, kind: string, work: () => Promise<unknown>) => {
      stageKinds.push(kind);
      return work();
    },
    saveArtifact: async () => undefined,
  } as unknown as ResearchStore;
  const reviews: Array<Record<string, unknown>> = [];
  let synthesisCalls = 0;
  const models = {
    ask: async (args: { stage: string; input: string }) => {
      if (args.stage === "synthesis") {
        synthesisCalls += 1;
        return synthesisCalls === 1 ? { ...draft, executiveSummary: "Unknown source (src:missing)." } : draft;
      }
      if (args.stage === "review") {
        reviews.push(JSON.parse(args.input) as Record<string, unknown>);
        return { valid: true, issues: [] };
      }
      throw new Error(`Unexpected model stage ${args.stage}`);
    },
  } as unknown as ResearchModels;

  const result = await runSynthesis(store, run, models, intake, evidence, world, contexts, evaluations, scenarios, discussion);
  assert.deepEqual(result, draft);
  assert.deepEqual(stageKinds, ["synthesis_draft", "review_initial", "synthesis_repair", "review_final", "synthesis"]);
  assert.equal(synthesisCalls, 2);
  assert.equal(reviews.length, 2);
  assert.deepEqual(reviews[0].contexts, contexts);
  assert.deepEqual(reviews[0].independentEvaluations, evaluations);
  assert.deepEqual(reviews[0].sensitivityScenarios, scenarios);
  assert.deepEqual(reviews[0].objectionDiscussion, discussion);
  assert.deepEqual(reviews[0].imageObservations, world.imageObservations);
  assert.deepEqual(reviews[0].contradictions, evidence.contradictions);
  assert.deepEqual(reviews[0].badCitationIds, ["unknown-inline-source-id:src:missing"]);
  assert.deepEqual(reviews[1].badCitationIds, []);
});
