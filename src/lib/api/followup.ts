import type { ReportContent } from "@/lib/research/types";

const stopWords = new Set([
  "about", "after", "against", "could", "does", "from", "have", "into", "more",
  "much", "only", "product", "report", "should", "than", "that", "their", "there",
  "these", "this", "those", "what", "when", "where", "which", "with", "would",
]);

function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [])
    .filter((word) => !stopWords.has(word)));
}

export function groundedFallback(question: string, report: ReportContent): {
  answer: string;
  citations: string[];
  requiresNewResearch: boolean;
} {
  const allowed = new Set([
    ...report.sources.map((source) => source.id),
    ...(report.humanAddendum?.findings.flatMap((finding) => finding.evidenceIds) ?? []),
  ]);
  const candidates = [
    ...report.questionAnswers.map((item, index) => ({
      prompt: item.question, text: item.answer, evidenceIds: item.evidenceIds,
      reportId: `report:questionAnswers:${index}`,
    })),
    ...report.findings.map((item, index) => ({ prompt: "finding performance", ...item,
      reportId: `report:findings:${index}` })),
    ...report.strengths.map((item, index) => ({ prompt: "strength advantage", ...item,
      reportId: `report:strengths:${index}` })),
    ...report.weaknesses.map((item, index) => ({ prompt: "weakness objection risk", ...item,
      reportId: `report:weaknesses:${index}` })),
    ...report.recommendations.map((item, index) => ({ prompt: "recommendation improve change", ...item,
      reportId: `report:recommendations:${index}` })),
    { prompt: "next experiment test", ...report.nextExperiment,
      reportId: "report:nextExperiment:0" },
    ...(report.humanAddendum?.findings.map((item, index) => ({ prompt: "human feedback", ...item,
      reportId: `report:humanAddendum:${index}` })) ?? []),
    { prompt: "price pricing cost", text: report.pricing.note, reportId: "report:pricing:0",
      evidenceIds: report.pricing.benchmarks.map((item) => item.sourceId) },
  ];
  const query = words(question);
  const scored = candidates.map((candidate) => {
    const citations = [candidate.reportId,
      ...[...new Set(candidate.evidenceIds)].filter((id) => allowed.has(id))];
    const text = words(`${candidate.prompt} ${candidate.text}`);
    const overlap = [...query].filter((word) => text.has(word)).length;
    return { ...candidate, citations, overlap };
  }).filter((candidate) => candidate.text.trim());
  scored.sort((a, b) => b.overlap - a.overlap);
  const best = scored[0];
  if (best && best.overlap >= Math.min(2, query.size) && query.size > 0) {
    return {
      answer: `From the saved report: ${best.text}`,
      citations: best.citations,
      requiresNewResearch: false,
    };
  }
  return {
    answer: "I cannot answer that reliably from the saved report. A new research run can investigate it with fresh evidence.",
    citations: [],
    requiresNewResearch: true,
  };
}
