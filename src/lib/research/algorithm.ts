import type {
  BuyerContext, BuyerEvaluation, DiscussionArtifact, EvidenceArtifact, EvaluationChoice,
  GraphArtifact, GraphEdge, GraphNode, IdeaInput, IntakeArtifact, ReportContent,
  SensitivityScenario, WorldModelArtifact,
} from "./types";
import type { SynthesisOutput } from "./schemas";

export function presentationOrder(index: number, conceptCount: number): string[] {
  if (conceptCount === 2) return index % 2 === 0
    ? ["concept_a", "concept_b", "status_quo"]
    : ["concept_b", "concept_a", "status_quo"];
  return ["concept_a", "status_quo"];
}

export function tallyChoices(evaluations: BuyerEvaluation[]): Record<EvaluationChoice, number> {
  const counts: Record<EvaluationChoice, number> = {
    concept_a: 0, concept_b: 0, status_quo: 0, neither: 0, insufficient_information: 0,
  };
  for (const evaluation of evaluations) counts[evaluation.choice]++;
  return counts;
}

export function directionalVerdict(evaluations: BuyerEvaluation[], evidence: EvidenceArtifact, scenarios: SensitivityScenario[]): ReportContent["verdict"] {
  const usableSources = new Set(evidence.sources.filter((source) => source.excerpt.trim().length >= 40).map((source) => source.id));
  const citedUsableSources = new Set(evidence.claims.flatMap((claim) => claim.sourceIds).filter((id) => usableSources.has(id)));
  if (!evaluations.length || usableSources.size < 3 || citedUsableSources.size < 2 || evidence.contradictions.length) return "inconclusive";
  const counts = tallyChoices(evaluations);
  const conceptSelections = counts.concept_a + counts.concept_b;
  const winnerCount = Math.max(counts.concept_a, counts.concept_b);
  const baselineWinner = counts.concept_a >= counts.concept_b ? "concept_a" : "concept_b";
  if (counts.insufficient_information >= 2) return "inconclusive";
  const baseline: ReportContent["verdict"] = winnerCount >= 6 ? "favorable" : conceptSelections <= 2 ? "unfavorable" : "inconclusive";
  if (baseline === "inconclusive") return baseline;
  for (const scenario of scenarios) {
    if (scenario.result.startsWith("Not evaluable:")) continue;
    const revised = scenario.revisedChoices;
    if (revised && evaluations.every((evaluation) => revised[evaluation.contextId])) {
      const scenarioCounts = tallyChoices(evaluations.map((evaluation) => ({ ...evaluation, choice: revised[evaluation.contextId] })));
      const scenarioVerdict = scenarioCounts.insufficient_information >= 2 ? "inconclusive"
        : scenarioCounts[baselineWinner] >= 6 ? "favorable"
        : scenarioCounts.concept_a + scenarioCounts.concept_b <= 2 ? "unfavorable" : "inconclusive";
      if (scenarioVerdict !== baseline) return "inconclusive";
    } else {
      const margin = baseline === "favorable" ? winnerCount - 6 : 2 - conceptSelections;
      if (scenario.changedChoices > margin) return "inconclusive";
    }
  }
  return baseline;
}

export function pricingAnalysis(input: IdeaInput, world: WorldModelArtifact): ReportContent["pricing"] {
  const benchmarks = world.priceBenchmarks.filter((item) => Number.isFinite(item.price) && item.price > 0);
  const cost = input.unitCost;
  const margin = input.minimumGrossMargin;
  const unit = input.priceUnit ? normalizePriceUnit(input.priceUnit) : null;
  if (typeof cost !== "number" || cost < 0 || typeof margin !== "number" || margin < 0 || margin >= 1 || !unit) {
    return { status: "benchmarks_only", marginFloor: null, testPrices: [], benchmarks, note: "Provide unit cost, a matching price unit, and minimum gross margin for test prices." };
  }
  const comparable = benchmarks.filter((item) => normalizePriceUnit(item.unit) === unit);
  const floor = cost / (1 - margin);
  if (!Number.isFinite(floor) || floor > 1_000_000_000) {
    return { status: "benchmarks_only", marginFloor: null, testPrices: [], benchmarks, note: "Supplied unit economics do not produce a finite, usable margin floor." };
  }
  if (comparable.length < 3 || new Set(comparable.map((item) => item.sourceId)).size < 3) {
    return { status: "benchmarks_only", marginFloor: floor, testPrices: [], benchmarks, note: "Fewer than three same-unit comparable prices were found; test prices would be poorly anchored." };
  }
  const sorted = comparable.map((item) => item.price).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const centsUp = (value: number) => Math.ceil(value * 100 - 1e-8) / 100;
  const low = centsUp(Math.max(floor + 0.01, median * 0.85));
  const middle = centsUp(Math.max(low + 0.01, median));
  const high = centsUp(Math.max(middle + 0.01, median * 1.15));
  return { status: "test_prices", marginFloor: centsUp(floor), testPrices: [low, middle, high], benchmarks, note: "Directional prices to test, anchored to same-unit public comparables and the supplied margin floor." };
}

export function normalizePriceUnit(raw: string): string | null {
  const unit = raw.trim().toLowerCase().replace(/\s+/g, " ").replace(/^usd\s*/, "");
  if (["item", "per item", "/item", "each", "unit", "per unit", "/unit"].includes(unit)) return "item";
  if (["month", "monthly", "mo", "per month", "/month", "/mo", "per mo"].includes(unit)) return "month";
  if (["year", "yearly", "yr", "annual", "annually", "per year", "/year", "/yr"].includes(unit)) return "year";
  if (["per user per month", "user/month", "/user/month", "per seat per month", "seat/month", "/seat/month"].includes(unit)) return "seat_month";
  if (["one time", "one-time", "one_time", "lifetime", "per purchase"].includes(unit)) return "one_time";
  return null;
}

export function sourceSupportsPrice(price: number, unit: string, excerpt: string): boolean {
  const normalizedUnit = normalizePriceUnit(unit);
  if (!Number.isFinite(price) || price <= 0 || !excerpt.trim() || !normalizedUnit) return false;
  const amount = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)`;
  const patterns = [
    new RegExp(String.raw`(?:\$|\bUSD\s*)\s*${amount}`, "gi"),
    new RegExp(String.raw`\b${amount}\s*(?:USD\b|dollars?\b|\/\s*(?:month|mo|year|yr|item|unit|seat)\b|per\s+(?:month|year|item|unit|seat)\b)`, "gi"),
  ];
  return patterns.some((pattern) => [...excerpt.matchAll(pattern)].some((match) => {
    const parsed = Number(String(match[1]).replaceAll(",", ""));
    if (Math.abs(parsed - price) > 0.01) return false;
    const start = match.index ?? 0;
    const suffix = excerpt.slice(start + match[0].length, start + match[0].length + 24).toLowerCase();
    const directUnit = suffix.match(/^\s*(?:\/\s*|per\s+)(month|mo|year|yr|item|unit)\b/)?.[1];
    if (directUnit && normalizePriceUnit(directUnit) !== normalizedUnit) return false;
    const before = excerpt.slice(0, start);
    const clauseStart = Math.max(...[",", ";", "!", "?", "\n"].map((separator) => before.lastIndexOf(separator)));
    const after = excerpt.slice(start + match[0].length);
    const nextBreaks = [",", ";", "!", "?", "\n"].map((separator) => after.indexOf(separator)).filter((index) => index >= 0);
    const clauseEnd = nextBreaks.length ? start + match[0].length + Math.min(...nextBreaks) : excerpt.length;
    const context = excerpt.slice(Math.max(clauseStart + 1, start - 48), Math.min(clauseEnd, start + match[0].length + 36)).toLowerCase();
    if (normalizedUnit === "item") return /\b(item|unit|each)\b/.test(context);
    if (normalizedUnit === "month") return /\b(month|mo|monthly)\b/.test(context);
    if (normalizedUnit === "year") return /\b(year|yr|annual|annually)\b/.test(context);
    if (normalizedUnit === "seat_month") return /\b(seat|user)\b/.test(context) && /\b(month|mo|monthly)\b/.test(context);
    return /\b(one.time|lifetime|purchase)\b/.test(context);
  }));
}

export function badCitationIds(synthesis: SynthesisOutput, evidence: EvidenceArtifact): string[] {
  const ids = new Set(evidence.sources.filter((source) => source.excerpt.trim().length >= 40).map((source) => source.id));
  const references = [
    ...synthesis.questionAnswers.flatMap((item) => item.evidenceIds),
    ...synthesis.findings.flatMap((item) => item.evidenceIds),
    ...synthesis.strengths.flatMap((item) => item.evidenceIds),
    ...synthesis.weaknesses.flatMap((item) => item.evidenceIds),
    ...synthesis.recommendations.flatMap((item) => item.evidenceIds),
    ...synthesis.nextExperiment.evidenceIds,
  ];
  const points = [...synthesis.questionAnswers, ...synthesis.findings, ...synthesis.strengths, ...synthesis.weaknesses, ...synthesis.recommendations, synthesis.nextExperiment];
  const missingExternal = points.flatMap((point, index) => point.basis === "external" && point.evidenceIds.length === 0 ? [`missing-external-citation:${index}`] : []);
  const invalidHuman = points.flatMap((point, index) => point.basis === "human" ? [`premature-human-basis:${index}`] : []);
  const prose = [
    synthesis.verdictReason, synthesis.executiveSummary, synthesis.pricingNote,
    ...synthesis.questionAnswers.flatMap((item) => [item.question, item.answer]),
    ...synthesis.findings.map((point) => point.text),
    ...synthesis.strengths.map((point) => point.text),
    ...synthesis.weaknesses.map((point) => point.text),
    ...synthesis.recommendations.map((point) => point.text),
    synthesis.nextExperiment.text, ...synthesis.caveats,
  ];
  const inlineSourceIds = prose.flatMap((text) => [...text.matchAll(/\bsrc:[A-Za-z0-9_-]+\b/g)]
    .filter((match) => !ids.has(match[0]))
    .map((match) => `unknown-inline-source-id:${match[0]}`));
  return [...new Set([...references.filter((id) => !ids.has(id)), ...missingExternal, ...invalidHuman, ...inlineSourceIds])];
}

export function buildGraph(args: {
  intake: IntakeArtifact;
  evidence?: EvidenceArtifact;
  world?: WorldModelArtifact;
  contexts?: BuyerContext[];
  evaluations?: BuyerEvaluation[];
  scenarios?: SensitivityScenario[];
  discussion?: DiscussionArtifact;
  verdict?: ReportContent["verdict"];
}): GraphArtifact {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const addNode = (node: GraphNode) => { if (!nodes.some((existing) => existing.id === node.id)) nodes.push(node); };
  const addEdge = (source: string, target: string, kind: GraphEdge["kind"], label = "") => {
    if (nodes.some((node) => node.id === source) && nodes.some((node) => node.id === target)) {
      edges.push({ id: `${source}:${target}:${kind}`, source, target, kind, label });
    }
  };
  addNode({ id: "idea", kind: "outcome", label: "The idea", summary: args.intake.decision, sourceIds: [], metadata: { geography: args.intake.geography } });
  for (const source of args.evidence?.sources ?? []) {
    addNode({ id: source.id, kind: "source", label: source.title.slice(0, 80), summary: source.excerpt.slice(0, 500), sourceIds: [source.id], metadata: { url: source.url, category: source.category } });
  }
  for (const claim of args.evidence?.claims ?? []) {
    addNode({ id: claim.id, kind: "claim", label: claim.text.slice(0, 80), summary: claim.text, sourceIds: claim.sourceIds, metadata: { confidence: claim.confidence, polarity: claim.polarity } });
    for (const sourceId of claim.sourceIds) addEdge(sourceId, claim.id, claim.polarity === "challenges" ? "challenges" : "supports");
    addEdge(claim.id, "idea", claim.polarity === "challenges" ? "challenges" : "supports");
  }
  for (const [index, assumption] of (args.world?.assumptions ?? args.intake.assumptions).entries()) {
    const id = `assumption:${index}`;
    addNode({ id, kind: "assumption", label: assumption.slice(0, 80), summary: assumption, sourceIds: [], metadata: {} });
    addEdge(id, "idea", "informs");
  }
  for (const context of args.contexts ?? []) {
    addNode({ id: context.id, kind: "context", label: context.label, summary: `${context.job}. Current alternative: ${context.currentAlternative}`, sourceIds: [], metadata: { budget: context.budget } });
    addEdge(context.id, "idea", "evaluates");
  }
  for (const evaluation of args.evaluations ?? []) {
    addNode({
      id: evaluation.id, kind: "outcome", label: evaluation.choice.replaceAll("_", " "),
      summary: evaluation.rationale, sourceIds: evaluation.evidenceIds,
      metadata: { contextId: evaluation.contextId, choice: evaluation.choice, uncertainty: evaluation.uncertainty },
    });
    addEdge(evaluation.contextId, evaluation.id, "evaluates");
    addEdge(evaluation.id, "idea", "informs");
    for (const [index, objection] of evaluation.objections.entries()) {
      const id = `objection:${evaluation.contextId}:${index}`;
      addNode({ id, kind: "objection", label: objection.slice(0, 80), summary: objection, sourceIds: evaluation.evidenceIds, metadata: {} });
      addEdge(evaluation.id, id, "informs");
      addEdge(id, "idea", "challenges");
    }
  }
  for (const scenario of args.scenarios ?? []) {
    addNode({ id: scenario.id, kind: "scenario", label: scenario.change.slice(0, 80), summary: scenario.result, sourceIds: scenario.evidenceIds, metadata: { variable: scenario.variable, changedChoices: scenario.changedChoices } });
    addEdge(scenario.id, "idea", "changes");
  }
  if (args.verdict) {
    const idea = nodes.find((node) => node.id === "idea");
    if (idea) idea.metadata.verdict = args.verdict;
  }
  return { nodes, edges };
}
