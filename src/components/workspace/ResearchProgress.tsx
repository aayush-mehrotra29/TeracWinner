"use client";

import { AlertTriangle, Check, Circle, LoaderCircle, PauseCircle } from "lucide-react";
import {
  ChainOfThought,
  ChainOfThoughtComplete,
  ChainOfThoughtContent,
  ChainOfThoughtStep,
  ChainOfThoughtStepContent,
  ChainOfThoughtStepTitle,
  ChainOfThoughtTrigger,
  type ChainOfThoughtStepStatus,
} from "@/components/ui/chain-of-thought";
import type { Run, RunEvent } from "./types";

type ResearchProgressProps = {
  run: Run;
  stages: string[];
  completedStages: ReadonlySet<string>;
  events: RunEvent[];
  labels: Record<string, string>;
  describeEvent: (event: RunEvent) => string;
  onInspect: (sequence: number) => void;
};

const stoppedStatuses = new Set<Run["status"]>(["completed", "failed", "integration_blocked"]);

function progressLabel(run: Run, currentLabel: string | null): string {
  switch (run.status) {
    case "queued": return "Research queued";
    case "needs_input": return "Paused for more detail";
    case "awaiting_approval": return "Waiting for opportunity approval";
    case "awaiting_humans": return "Waiting for participant feedback";
    case "completed": return "Research complete";
    case "failed": return "Research stopped";
    case "integration_blocked": return "Research blocked";
    default: return currentLabel ? `Researching · ${currentLabel}` : "Researching";
  }
}

function StepIcon({ status, paused }: { status: ChainOfThoughtStepStatus; paused: boolean }) {
  if (status === "completed") return <Check size={15} strokeWidth={2.2} aria-hidden="true" />;
  if (status === "error") return <AlertTriangle size={15} strokeWidth={1.8} aria-hidden="true" />;
  if (status === "active" && paused) return <PauseCircle size={16} strokeWidth={1.8} aria-hidden="true" />;
  if (status === "active") return <LoaderCircle size={16} strokeWidth={1.8} className="studio-progress-spin" aria-hidden="true" />;
  return <Circle size={12} strokeWidth={1.8} aria-hidden="true" />;
}

export default function ResearchProgress({
  run, stages, completedStages, events, labels, describeEvent, onInspect,
}: ResearchProgressProps) {
  const terminal = stoppedStatuses.has(run.status);
  const isError = run.status === "failed" || run.status === "integration_blocked";
  const paused = run.status === "needs_input" || run.status === "awaiting_approval" || run.status === "awaiting_humans";
  const currentLabel = run.stage ? labels[run.stage] ?? run.stage.replaceAll("_", " ") : null;
  const stageEvents = new Map<string, RunEvent[]>();
  for (const event of events) {
    if (!event.stage) continue;
    const existing = stageEvents.get(event.stage) ?? [];
    existing.push(event);
    stageEvents.set(event.stage, existing);
  }

  // Finished runs show the steps they actually reached. A skipped stage is not presented as completed.
  const visibleStages = terminal
    ? stages.filter((stage) => completedStages.has(stage) || stage === run.stage || stageEvents.has(stage))
    : stages;
  const uniqueStages = [...new Set(visibleStages)];
  const finishedCount = uniqueStages.filter((stage) => completedStages.has(stage)).length;
  const active = run.status === "running";
  const pausedSummary = run.status === "needs_input" ? "Waiting for the missing project details."
    : run.status === "awaiting_approval" ? "Waiting for your approval before the opportunity launches."
      : run.status === "awaiting_humans" ? "Waiting for the next matched participant submission." : null;

  return <section className="studio-progress-card" aria-label="Research progress">
    <span className="sr-only" role="status" aria-live="polite">{progressLabel(run, currentLabel)}. {finishedCount} of {uniqueStages.length} stages complete.</span>
    <div className="studio-progress-meta"><span className="studio-caps">ORIT / RESEARCH</span><span>{finishedCount} of {uniqueStages.length} stages complete</span></div>
    <ChainOfThought defaultOpen={run.status !== "completed"} className="studio-progress-chain">
      <ChainOfThoughtTrigger className="studio-progress-trigger" label={progressLabel(run, currentLabel)} active={active} />
      <ChainOfThoughtContent className="studio-progress-content space-y-0">
        {uniqueStages.map((stage) => {
          const saved = stageEvents.get(stage) ?? [];
          const status: ChainOfThoughtStepStatus = isError && run.stage === stage ? "error"
            : completedStages.has(stage) ? "completed"
              : run.stage === stage && (run.status === "running" || paused) ? "active" : "pending";
          const meaningfulEvent = [...saved].reverse().find((event) => !["queued", "stage_started", "stage_completed"].includes(event.kind));
          const inspectEvent = [...saved].reverse().find((event) => event.kind === "artifact" && event.payload?.kind === "graph");
          const hasContent = saved.length > 0 || status === "error";
          const label = labels[stage] ?? stage.replaceAll("_", " ");
          const summary = paused && status === "active" && pausedSummary ? pausedSummary
            : meaningfulEvent ? describeEvent(meaningfulEvent)
            : status === "completed" ? "Stage completed and saved."
              : status === "error" ? "This stage could not finish. See the run message above."
                  : "Stage started. Updates will appear as they are saved.";

          return <ChainOfThoughtStep key={stage} status={status} hasContent={hasContent} defaultOpen={status === "active" || status === "error"} className={`studio-progress-step is-${status}`}>
            <ChainOfThoughtStepTitle icon={<StepIcon status={status} paused={paused} />} active={status === "active" && !paused} className="studio-progress-step-title">
              {label}
            </ChainOfThoughtStepTitle>
            {hasContent && <ChainOfThoughtStepContent className="studio-progress-step-content">
              <p>{summary}</p>
              {inspectEvent && <button type="button" onClick={() => onInspect(inspectEvent.seq)}>Explore saved map <span aria-hidden="true">↗</span></button>}
            </ChainOfThoughtStepContent>}
          </ChainOfThoughtStep>;
        })}
      </ChainOfThoughtContent>
      {run.status === "completed" && <ChainOfThoughtComplete className="studio-progress-complete" icon={<Check size={14} strokeWidth={2.2} aria-hidden="true" />} label="Report ready to review" />}
    </ChainOfThought>
  </section>;
}
