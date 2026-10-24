"use client";

import { ArrowDownToLine, ArrowUpRight, CheckCircle2, CircleHelp, ExternalLink, MoveRight, ShieldAlert } from "lucide-react";
import type { ReportContent, ReportPoint } from "@/lib/research/types";
import type { ReportVersion } from "./types";

export function asReportContent(report: ReportVersion | null): ReportContent | null {
  const content = report?.content;
  if (!content || typeof content.title !== "string" || !Array.isArray(content.questionAnswers) || !Array.isArray(content.sources)) return null;
  return content as unknown as ReportContent;
}

function EvidenceLinks({ ids, sources }: { ids: string[]; sources: ReportContent["sources"] }) {
  const found = ids.map((id) => sources.find((source) => source.id === id)).filter((source): source is ReportContent["sources"][number] => Boolean(source));
  if (!found.length) return null;
  return <span className="studio-inline-sources">{found.map((source, index) => <a href={`#source-${source.id}`} key={source.id}>Source {index + 1}</a>)}</span>;
}

function BasisLabel({ basis }: { basis: ReportPoint["basis"] }) {
  return <span className={`studio-point-basis is-${basis}`}>{basis === "external" ? "External evidence" : basis === "synthetic" ? "Synthetic" : basis === "human" ? "Human feedback" : "Assumption"}</span>;
}

function PointList({ points, sources, anchorSection }: { points: ReportPoint[]; sources: ReportContent["sources"]; anchorSection?: string }) {
  if (!points.length) return <p className="studio-report-muted">No supported finding in this category yet.</p>;
  return <ul className="studio-point-list">{points.map((point, index) => <li id={anchorSection ? `report:${anchorSection}:${index}` : undefined} key={`${index}-${point.text}`}><span className="studio-point-index">{String(index + 1).padStart(2, "0")}</span><div><BasisLabel basis={point.basis} />{point.text}<EvidenceLinks ids={point.evidenceIds} sources={sources} /></div></li>)}</ul>;
}

function HumanPointList({ points, sources }: { points: ReportPoint[]; sources: NonNullable<ReportContent["humanAddendum"]>["sources"] }) {
  return <ul className="studio-point-list">{points.map((point, index) => <li id={`report:humanAddendum:${index}`} key={`${index}-${point.text}`}><span className="studio-point-index">{String(index + 1).padStart(2, "0")}</span><div><BasisLabel basis={point.basis} />{point.text}<span className="studio-human-references">{point.evidenceIds.map((id) => {
    const source = sources.find((item) => item.id === id);
    return source ? <a key={id} href={`#human-source-${source.responseId}`} onClick={() => {
      const details = document.getElementById(`human-source-${source.responseId}`);
      if (details instanceof HTMLDetailsElement) details.open = true;
    }}>Reviewed response {sources.indexOf(source) + 1}</a> : <span key={id}>Saved response unavailable</span>;
  })}</span></div></li>)}</ul>;
}

const humanQuestionLabels: Record<string, string> = {
  current: "Current behavior", criteria: "Decision criteria", reaction: "First reaction",
  advantage: "Perceived advantage", concern: "Barriers", price: "Price view",
  change: "Suggested change", choice: "Choice and reason",
};

function HumanSources({ sources }: { sources: NonNullable<ReportContent["humanAddendum"]>["sources"] }) {
  if (!sources.length) return null;
  return <div className="studio-human-source-list"><h4>Reviewed answers behind these findings</h4>{sources.map((source, index) => <details className="studio-human-source" id={`human-source-${source.responseId}`} key={source.id}><summary>Reviewed response {index + 1} <span>{source.excerpts.length} saved answers</span></summary><div>{source.excerpts.map((excerpt) => <div key={excerpt.questionId}><span>{humanQuestionLabels[excerpt.questionId] ?? excerpt.questionId.replaceAll("_", " ")}</span><p>{excerpt.answer}</p></div>)}</div></details>)}</div>;
}

const choiceLabels: Record<string, string> = { concept_a: "Concept A", concept_b: "Concept B", status_quo: "Current alternative", neither: "Neither", insufficient_information: "Insufficient information" };

function displayReportTitle(title: string): string {
  if (title.length < 145) return title;
  const clauseEnd = title.lastIndexOf(",");
  const wordEnd = title.slice(0, 135).lastIndexOf(" ");
  return `${title.slice(0, clauseEnd > 100 ? clauseEnd : wordEnd > 100 ? wordEnd : 135).trimEnd()}…`;
}

export default function ReportView({ report, runId }: { report: ReportVersion | null; runId: string }) {
  const content = asReportContent(report);
  if (!content) return <div className="studio-report-pending"><div className="studio-report-pending-mark"><CircleHelp size={28} /></div><span className="studio-caps">Report pending</span><h2>The analysis is still being assembled.</h2><p>Once a report version is saved, its findings and sources will appear here.</p></div>;

  const isDeep = content.mode === "deep_simulation";
  const verdictLabel = content.verdict === "favorable" ? "Favorable, provisional" : content.verdict === "unfavorable" ? "Unfavorable, provisional" : "Inconclusive";
  const syntheticEntries = content.synthetic ? Object.entries(content.synthetic.counts).filter(([key, value]) => value > 0 && (key !== "concept_b" || content.synthetic?.counts.concept_b)) : [];

  return <article className="studio-report">
    <header className="studio-report-hero">
      <div className="studio-report-headerline"><span className="studio-caps">Analysis report / v{report?.version ?? content.metadata.reportVersion}</span><a className="studio-report-download" href={`/api/runs/${runId}/report?format=pdf&version=${report?.version ?? content.metadata.reportVersion}`}><ArrowDownToLine size={16} /> Download PDF</a></div>
      <h2 title={content.title}>{displayReportTitle(content.title)}</h2>
      <div className="studio-verdict-row"><span className={`studio-verdict is-${content.verdict}`}>{verdictLabel}</span><span>{content.verdictReason}</span></div>
    </header>

    <div className="studio-report-statrow">
      <div><span>01 / Evidence</span><strong>{content.metadata.evidenceCount}</strong><small>saved sources</small></div>
      <div><span>02 / Simulation</span><strong>{content.synthetic?.total ?? "—"}</strong><small>{content.synthetic ? "hypothetical contexts" : "not used in this mode"}</small></div>
      <div><span>03 / Human feedback</span><strong>{content.metadata.humanStatus === "complete" ? "Ready" : content.metadata.humanStatus === "pending" ? "Pending" : content.metadata.humanStatus === "insufficient" ? "Limited" : content.metadata.humanStatus === "unavailable" ? "Unavailable" : "—"}</strong><small>{content.metadata.humanStatus === "unavailable" ? "local-only setup" : isDeep ? "separate from synthetic results" : "not requested"}</small></div>
    </div>

    {isDeep && content.metadata.humanStatus === "unavailable" && <section className="studio-report-section studio-human-section"><span className="studio-caps">Human feedback</span><h3>No participant study in this run</h3><p>This report contains external research and synthetic buyer evaluations. The local app has no verified Terac-hosted response flow, so no human study was launched or included.</p></section>}

    <section className="studio-report-lead"><span className="studio-caps">Executive readout</span><p>{content.executiveSummary}</p></section>

    {content.findings.length > 0 && <section className="studio-report-section studio-key-findings"><div className="studio-report-section-head"><div><span className="studio-caps">The signals that matter</span><h3>Key findings</h3></div><span className="studio-report-section-index">↗</span></div><PointList points={content.findings} sources={content.sources} anchorSection="findings" /></section>}

    {content.synthetic && <section className="studio-report-section studio-synthetic-section"><div className="studio-report-section-head"><div><span className="studio-caps">Directional simulation</span><h3>How the hypothetical buyers decided</h3></div><span className="studio-report-section-index">01</span></div><p className="studio-synthetic-warning">These counts are the <strong>share of synthetic agents in this run</strong>. They are not a market share, purchase probability, or revenue forecast.</p><div className="studio-synthetic-bars">{syntheticEntries.map(([choice, count]) => <div className="studio-synthetic-row" key={choice}><span>{choiceLabels[choice] || choice.replaceAll("_", " ")}</span><div className="studio-synthetic-track"><div style={{ width: `${Math.round((count / content.synthetic!.total) * 100)}%` }} /></div><strong aria-label={`${count} of ${content.synthetic!.total}, share of synthetic agents in this run`}>{count}/{content.synthetic!.total}</strong></div>)}</div></section>}

    <section className="studio-report-section"><div className="studio-report-section-head"><div><span className="studio-caps">Decision questions</span><h3>What the research says</h3></div><span className="studio-report-section-index">{content.synthetic ? "02" : "01"}</span></div><div className="studio-answer-list">{content.questionAnswers.map((item, index) => <div className="studio-answer" id={`report:questionAnswers:${index}`} key={`${index}-${item.question}`}><div className="studio-answer-index">Q{String(index + 1).padStart(2, "0")}</div><div><h4>{item.question}</h4><p>{item.answer}</p><EvidenceLinks ids={item.evidenceIds} sources={content.sources} /></div></div>)}</div></section>

    <section className="studio-report-split"><div className="studio-report-section"><div className="studio-report-section-head"><div><span className="studio-caps">Where it works</span><h3>Reasons to believe</h3></div><CheckCircle2 size={20} /></div><PointList points={content.strengths} sources={content.sources} anchorSection="strengths" /></div><div className="studio-report-section"><div className="studio-report-section-head"><div><span className="studio-caps">Where it falls short</span><h3>Friction and objections</h3></div><ShieldAlert size={20} /></div><PointList points={content.weaknesses} sources={content.sources} anchorSection="weaknesses" /></div></section>

    <section className="studio-report-section" id="report:pricing:0"><div className="studio-report-section-head"><div><span className="studio-caps">Price evidence</span><h3>{content.pricing.status === "test_prices" ? "Prices to test" : "Comparable prices"}</h3></div><span className="studio-report-section-index">03</span></div><p className="studio-report-muted">{content.pricing.note}</p>{content.pricing.status === "test_prices" && content.pricing.marginFloor !== null && <div className="studio-price-floor">Minimum margin floor <strong>${content.pricing.marginFloor.toFixed(2)}</strong></div>}{content.pricing.testPrices.length > 0 && <div className="studio-price-cards">{content.pricing.testPrices.map((price, index) => <div key={`${index}-${price}`}><span>Test {String(index + 1).padStart(2, "0")}</span><strong>${price.toFixed(2)}</strong></div>)}</div>}{content.pricing.benchmarks.length > 0 && <div className="studio-benchmarks">{content.pricing.benchmarks.map((benchmark, index) => <div key={`${benchmark.sourceId}-${index}`}><span>{benchmark.label}</span><strong>${benchmark.price.toFixed(2)} <small>/ {benchmark.unit}</small></strong><EvidenceLinks ids={[benchmark.sourceId]} sources={content.sources} /></div>)}</div>}</section>

    <section className="studio-report-section studio-action-section"><div className="studio-report-section-head"><div><span className="studio-caps">Improve the idea</span><h3>What would change the result</h3></div><MoveRight size={21} /></div><PointList points={content.recommendations} sources={content.sources} anchorSection="recommendations" /><div className="studio-next-experiment" id="report:nextExperiment:0"><span className="studio-caps">Best next experiment</span><p><BasisLabel basis={content.nextExperiment.basis} />{content.nextExperiment.text}</p><EvidenceLinks ids={content.nextExperiment.evidenceIds} sources={content.sources} /></div></section>

    {content.humanAddendum && <section className="studio-report-section studio-human-section" id="studio-human-feedback"><div className="studio-report-section-head"><div><span className="studio-caps">Versioned addendum</span><h3>Human feedback</h3></div><strong>{content.humanAddendum.responses} responses</strong></div><p>{content.humanAddendum.comparison}</p><HumanPointList points={content.humanAddendum.findings} sources={content.humanAddendum.sources} />{content.humanAddendum.caveats.map((caveat, index) => <p className="studio-report-muted" key={index}>{caveat}</p>)}<HumanSources sources={content.humanAddendum.sources} /></section>}

    <section className="studio-report-section studio-source-section"><div className="studio-report-section-head"><div><span className="studio-caps">Research trail</span><h3>Sources and limits</h3></div><span className="studio-report-section-index">04</span></div><div className="studio-source-list">{content.sources.map((source, index) => <div className="studio-source" id={`source-${source.id}`} key={source.id}><span>{String(index + 1).padStart(2, "0")}</span><div><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}<ExternalLink size={14} /></a><p>{source.excerpt}</p><small>{source.provider.toUpperCase()} · {source.publishedAt ? new Date(source.publishedAt).toLocaleDateString() : "date not available"} · {source.category}</small></div></div>)}</div>{content.caveats.length > 0 && <div className="studio-caveats"><span className="studio-caps">Interpret with care</span>{content.caveats.map((caveat, index) => <p key={index}>{caveat}</p>)}</div>}</section>
    <footer className="studio-report-footer"><span>Generated {new Date(content.metadata.generatedAt).toLocaleString()} · report v{content.metadata.reportVersion}</span><a href="#top">Back to top <ArrowUpRight size={14} /></a></footer>
  </article>;
}
