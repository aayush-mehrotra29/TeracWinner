"use client";

import { useState } from "react";
import { Check, ChevronDown, LoaderCircle } from "lucide-react";
import type { Run, RunEvent } from "./types";

type ResearchProgressProps = {
  run: Run;
  stages: string[];
  completedStages: ReadonlySet<string>;
  events: RunEvent[];
  labels: Record<string, string>;
  describeEvent: (event: RunEvent) => string;
  onInspect: (sequence: number) => void;
  defaultExpanded?: boolean;
};

const terminalStatuses = new Set<Run["status"]>(["completed", "failed", "integration_blocked"]);

function progressLabel(run: Run, currentLabel: string | null): string {
  switch (run.status) {
    case "queued": return "Research queued";
    case "needs_input": return "Waiting for project details";
    case "awaiting_approval": return "Waiting for opportunity approval";
    case "awaiting_humans": return "Waiting for participant feedback";
    case "completed": return "Research complete";
    case "failed": return "Research stopped";
    case "integration_blocked": return "Research blocked";
    default: return currentLabel ?? "Research in progress";
  }
}

function eventAction(event: RunEvent, describeEvent: ResearchProgressProps["describeEvent"]): string {
  const payload = event.payload ?? {};
  if (event.kind === "model_call_started" || event.kind === "model_call_completed") {
    const operation = typeof payload.operation === "string" && payload.operation.trim()
      ? payload.operation.trim() : "Agent analysis";
    const model = typeof payload.model === "string" ? payload.model : null;
    return `${operation}${event.kind === "model_call_completed" ? " saved" : " in progress"}${model ? ` · ${model}` : ""}`;
  }
  if (event.kind === "exa_search_started") {
    return typeof payload.query === "string" ? `Exa searching: ${payload.query}` : "Exa searching public sources";
  }
  if (event.kind === "exa_contents_started") return "Exa reading supplied links";
  if (event.kind === "exa_search_completed" || event.kind === "exa_contents_completed") {
    const count = typeof payload.acceptedCount === "number" ? payload.acceptedCount : payload.resultCount;
    return typeof count === "number" ? `Exa saved ${count} source${count === 1 ? "" : "s"}` : "Exa search complete";
  }
  if (event.kind === "source_discovered") {
    return typeof payload.title === "string" ? `Source saved: ${payload.title}` : "Source saved";
  }
  if (event.kind === "agent_evaluation") {
    const label = typeof payload.label === "string" ? payload.label : "Buyer";
    const choice = typeof payload.choice === "string" ? payload.choice.replaceAll("_", " ") : "evaluated";
    return `${label}: ${choice}`;
  }
  return describeEvent(event);
}

function meaningful(event: RunEvent): boolean {
  return !["queued", "stage_started", "stage_completed", "artifact"].includes(event.kind);
}

function sourceUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export default function ResearchProgress({
  run, stages, completedStages, events, labels, describeEvent, onInspect, defaultExpanded,
}: ResearchProgressProps) {
  const [expanded, setExpanded] = useState(Boolean(defaultExpanded));
  const terminal = terminalStatuses.has(run.status);
  const paused = ["needs_input", "awaiting_approval", "awaiting_humans"].includes(run.status);
  const currentLabel = run.stage ? labels[run.stage] ?? run.stage.replaceAll("_", " ") : null;
  const stageEvents = new Map<string, RunEvent[]>();
  for (const event of events) {
    if (!event.stage) continue;
    const saved = stageEvents.get(event.stage) ?? [];
    saved.push(event);
    stageEvents.set(event.stage, saved);
  }
  const visibleStages = [...new Set(terminal
    ? stages.filter((stage) => completedStages.has(stage) || stage === run.stage || stageEvents.has(stage))
    : stages)];
  const finishedCount = visibleStages.filter((stage) => completedStages.has(stage)).length;
  const latestAction = [...events].reverse().find((event) => meaningful(event));
  const evaluationCount = events.filter((event) => event.kind === "agent_evaluation").length;
  const sourceLinks = [...new Map(events.filter((event) => event.kind === "source_discovered").flatMap((event) => {
    const url = sourceUrl(event.payload?.url);
    if (!url) return [];
    return [[url, { url, title: typeof event.payload?.title === "string" ? event.payload.title : new URL(url).hostname }] as const];
  })).values()].reverse();
  const status = progressLabel(run, currentLabel);

  return <section className="studio-progress-card" aria-label="Research progress">
    <span className="sr-only" role="status" aria-live="polite">{status}. {finishedCount} of {visibleStages.length} stages complete. {latestAction ? eventAction(latestAction, describeEvent) : ""}</span>
    <details className="studio-progress-details" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className="studio-progress-summary">
        <span className={`studio-progress-state is-${run.status}`} aria-hidden="true">{run.status === "running" ? <LoaderCircle size={16} /> : run.status === "completed" ? <Check size={15} /> : <span />}</span>
        <span className="studio-progress-summary-copy"><strong>{status}</strong><small>{latestAction ? eventAction(latestAction, describeEvent) : run.status === "queued" ? "Waiting for the worker to begin" : currentLabel ? `${currentLabel} is the current stage` : "Saved run events will appear here"}</small></span>
        <span className="studio-progress-counter">{finishedCount}/{visibleStages.length}</span>
        <ChevronDown size={15} className="studio-progress-chevron" aria-hidden="true" />
      </summary>
      <ol className="studio-progress-stages">
        {visibleStages.map((stage) => {
          const saved = stageEvents.get(stage) ?? [];
          const completed = completedStages.has(stage);
          const active = run.stage === stage && !terminal && !completed;
          const failed = run.stage === stage && (run.status === "failed" || run.status === "integration_blocked");
          const last = [...saved].reverse().find(meaningful);
          const mapEvent = [...saved].reverse().find((event) => event.kind === "artifact" && event.payload?.kind === "graph");
          const stageEvaluations = stage === "evaluations" ? saved.filter((event) => event.kind === "agent_evaluation").length : 0;
          const detail = stage === "evaluations" && stageEvaluations > 0
            ? `${stageEvaluations} of 8 buyer agents evaluated${last ? ` · ${eventAction(last, describeEvent)}` : ""}`
            : last ? eventAction(last, describeEvent)
            : completed ? "Saved" : active ? paused ? "Waiting to continue" : "In progress" : "Not started";
          return <li key={stage} className={`studio-progress-stage ${completed ? "is-complete" : failed ? "is-failed" : active ? "is-active" : "is-pending"}`}>
            <span className="studio-progress-stage-marker" aria-hidden="true">{completed ? <Check size={12} /> : active && !paused ? <LoaderCircle size={13} /> : null}</span>
            <span className="studio-progress-stage-content"><strong>{labels[stage] ?? stage.replaceAll("_", " ")}</strong><small>{detail}</small></span>
            {mapEvent && <button type="button" onClick={() => onInspect(mapEvent.seq)} aria-label={`Explore saved map for ${labels[stage] ?? stage}`}>View map</button>}
          </li>;
        })}
      </ol>
    </details>
    {sourceLinks.length > 0 && <div className="studio-progress-sources" aria-label="Saved Exa sources">
      <div className="studio-progress-sources-head"><span>Exa sources found</span><strong>{sourceLinks.length}</strong></div>
      <div className="studio-progress-sources-list">{sourceLinks.map((source) => <a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer" title={source.title}><span className="studio-progress-source-title">{source.title}</span><span aria-hidden="true">↗</span></a>)}</div>
    </div>}
    {evaluationCount > 0 && run.status !== "completed" && <span className="studio-progress-agent-count">{evaluationCount} of 8 independent buyer agents finished</span>}
  </section>;
}
