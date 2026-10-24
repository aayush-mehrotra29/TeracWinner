import type { JsonSchema } from "../providers/openai";

const string: JsonSchema = { type: "string" };
const number: JsonSchema = { type: "number" };
const boolean: JsonSchema = { type: "boolean" };
const strings: JsonSchema = { type: "array", items: string };
const obj = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const arr = (items: JsonSchema): JsonSchema => ({ type: "array", items });
const choice = (...values: string[]): JsonSchema => ({ type: "string", enum: values });

const point = obj({ text: string, evidenceIds: strings, basis: choice("external", "synthetic", "assumption", "human") });

export const schemas = {
  intake: obj({
    decision: string,
    audience: string,
    geography: string,
    concepts: strings,
    searchTerms: strings,
    missingFacts: strings,
    customerFacts: strings,
    assumptions: strings,
  }),
  plan: obj({ queries: strings }),
  claims: obj({
    claims: arr(obj({ text: string, sourceIds: strings, polarity: choice("supports", "challenges", "context"), confidence: choice("low", "medium", "high") })),
    contradictions: arr(obj({ claimIds: strings, explanation: string })),
    gaps: strings,
  }),
  image: obj({ observation: string }),
  world: obj({
    interpretations: arr(obj({ text: string, sourceIds: strings })),
    assumptions: strings,
    alternativeSolutions: strings,
    priceBenchmarks: arr(obj({ label: string, price: number, unit: string, sourceId: string })),
  }),
  contexts: obj({
    contexts: arr(obj({
      label: string, job: string, budget: string, constraints: strings,
      currentAlternative: string, decisionCriteria: strings, assumptions: strings,
    })),
  }),
  evaluation: obj({
    choice: choice("concept_a", "concept_b", "status_quo", "neither", "insufficient_information"),
    rationale: string, advantages: strings, objections: strings, evidenceIds: strings, uncertainty: string,
  }),
  sensitivity: obj({ changedChoices: number, result: string, evidenceIds: strings }),
  discussion: obj({ objection: string, perspectives: arr(obj({ contextId: string, position: string })), conclusion: string }),
  synthesis: obj({
    verdictReason: string,
    executiveSummary: string,
    questionAnswers: arr(obj({ question: string, answer: string, evidenceIds: strings, basis: choice("external", "synthetic", "assumption") })),
    findings: arr(point), strengths: arr(point), weaknesses: arr(point), recommendations: arr(point),
    nextExperiment: point,
    pricingNote: string,
    caveats: strings,
  }),
  review: obj({ valid: boolean, issues: strings }),
  addendum: obj({ comparison: string, findings: arr(point), caveats: strings }),
  followup: obj({ answer: string, citations: strings, requiresNewResearch: boolean }),
} satisfies Record<string, JsonSchema>;

export type SynthesisOutput = {
  verdictReason: string;
  executiveSummary: string;
  questionAnswers: Array<{ question: string; answer: string; evidenceIds: string[]; basis: "external" | "synthetic" | "assumption" }>;
  findings: Array<{ text: string; evidenceIds: string[]; basis: "external" | "synthetic" | "assumption" | "human" }>;
  strengths: Array<{ text: string; evidenceIds: string[]; basis: "external" | "synthetic" | "assumption" | "human" }>;
  weaknesses: Array<{ text: string; evidenceIds: string[]; basis: "external" | "synthetic" | "assumption" | "human" }>;
  recommendations: Array<{ text: string; evidenceIds: string[]; basis: "external" | "synthetic" | "assumption" | "human" }>;
  nextExperiment: { text: string; evidenceIds: string[]; basis: "external" | "synthetic" | "assumption" | "human" };
  pricingNote: string;
  caveats: string[];
};
