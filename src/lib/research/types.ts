export type ResearchMode = "light_research" | "light_simulation" | "deep_simulation";

export type RunStatus =
  | "queued"
  | "running"
  | "needs_input"
  | "awaiting_approval"
  | "awaiting_humans"
  | "completed"
  | "failed"
  | "integration_blocked";

export type ResearchStage =
  | "intake"
  | "evidence"
  | "world"
  | "contexts"
  | "evaluations"
  | "sensitivities"
  | "discussion"
  | "synthesis"
  | "review"
  | "report"
  | "terac_feasibility"
  | "terac_fieldwork"
  | "human_addendum";

export interface IdeaInput {
  idea: string;
  concepts?: string[];
  audience?: string;
  decision?: string;
  geography?: string;
  urls?: string[];
  assetIds?: string[];
  unitCost?: number | null;
  minimumGrossMargin?: number | null;
  priceUnit?: string;
  constraints?: string;
  clarifications?: string[];
  followupQuestion?: string;
}

export interface IntakeArtifact {
  decision: string;
  audience: string;
  geography: string;
  concepts: string[];
  searchTerms: string[];
  missingFacts: string[];
  customerFacts: string[];
  assumptions: string[];
}

export interface EvidenceSource {
  id: string;
  url: string;
  title: string;
  publishedAt: string | null;
  excerpt: string;
  provider: "exa" | "solari";
  fetchedAt: string;
  category: "competitor" | "price" | "review" | "market" | "other";
  limitations: string[];
}

export interface EvidenceClaim {
  id: string;
  text: string;
  sourceIds: string[];
  polarity: "supports" | "challenges" | "context";
  confidence: "low" | "medium" | "high";
}

export interface EvidenceArtifact {
  sources: EvidenceSource[];
  claims: EvidenceClaim[];
  contradictions: Array<{ claimIds: string[]; explanation: string }>;
  gaps: string[];
  searchQueries: string[];
}

export interface WorldModelArtifact {
  customerFacts: string[];
  externalClaims: EvidenceClaim[];
  interpretations: Array<{ text: string; sourceIds: string[] }>;
  assumptions: string[];
  alternativeSolutions: string[];
  priceBenchmarks: Array<{ label: string; price: number; unit: string; sourceId: string }>;
  imageObservations: Array<{ assetId: string; observation: string; status: "analyzed" | "failed" }>;
}

export interface BuyerContext {
  id: string;
  label: string;
  job: string;
  budget: string;
  constraints: string[];
  currentAlternative: string;
  decisionCriteria: string[];
  assumptions: string[];
}

export type EvaluationChoice = "concept_a" | "concept_b" | "status_quo" | "neither" | "insufficient_information";

export interface BuyerEvaluation {
  id: string;
  contextId: string;
  presentationOrder: string[];
  choice: EvaluationChoice;
  rationale: string;
  advantages: string[];
  objections: string[];
  evidenceIds: string[];
  uncertainty: string;
}

export interface SensitivityScenario {
  id: string;
  variable: "price" | "message" | "feature";
  change: string;
  contextIds: string[];
  changedChoices: number;
  revisedChoices?: Record<string, EvaluationChoice>;
  result: string;
  evidenceIds: string[];
}

export interface DiscussionArtifact {
  objection: string;
  perspectives: Array<{ contextId: string; position: string }>;
  conclusion: string;
  independentChoicesUnchanged: true;
}

export interface GraphNode {
  id: string;
  kind: "source" | "claim" | "assumption" | "context" | "objection" | "scenario" | "outcome";
  label: string;
  summary: string;
  sourceIds: string[];
  metadata: Record<string, string | number | boolean | null>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: "supports" | "challenges" | "evaluates" | "changes" | "informs";
  label: string;
}

export interface GraphArtifact {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ReportPoint {
  text: string;
  evidenceIds: string[];
  basis: "external" | "synthetic" | "assumption" | "human";
}

export interface ReportContent {
  title: string;
  mode: ResearchMode;
  verdict: "favorable" | "unfavorable" | "inconclusive";
  verdictReason: string;
  executiveSummary: string;
  questionAnswers: Array<{ question: string; answer: string; evidenceIds: string[]; basis: "external" | "synthetic" | "assumption" }>;
  findings: ReportPoint[];
  strengths: ReportPoint[];
  weaknesses: ReportPoint[];
  recommendations: ReportPoint[];
  nextExperiment: ReportPoint;
  pricing: {
    status: "test_prices" | "benchmarks_only";
    marginFloor: number | null;
    testPrices: number[];
    benchmarks: Array<{ label: string; price: number; unit: string; sourceId: string }>;
    note: string;
  };
  synthetic: {
    total: number;
    counts: Record<EvaluationChoice, number>;
    label: "share of synthetic agents in this run";
  } | null;
  sources: EvidenceSource[];
  caveats: string[];
  metadata: {
    runId: string;
    reportVersion: number;
    generatedAt: string;
    modelIds: string[];
    evidenceCount: number;
    simulationCount: number;
    humanStatus: "not_requested" | "pending" | "insufficient" | "complete" | "unavailable";
    humanResponseFingerprint?: string;
  };
  humanAddendum?: {
    responses: number;
    comparison: string;
    findings: ReportPoint[];
    caveats: string[];
    sources: Array<{ id: string; responseId: string; excerpts: Array<{ questionId: string; answer: string }> }>;
  };
}

export interface RunRow {
  id: string;
  project_id: string;
  owner_id: string;
  mode: ResearchMode;
  status: RunStatus;
  stage: ResearchStage | null;
  input: IdeaInput;
  version: number;
  budget_usd: number;
  spent_usd: number;
}
