"use client";

import { useMemo, useState } from "react";
import { ArrowUpRight, ChevronDown, ExternalLink } from "lucide-react";
import type { Graph, MapNode } from "./types";

type Source = { id: string; title?: string; url?: string };
export type AgentDiscussion = {
  objection: string;
  perspectives: Array<{ contextId: string; position: string }>;
  conclusion: string;
  independentChoicesUnchanged?: boolean;
};
export type SavedAgentEvaluation = {
  id: string;
  contextId: string;
  choice: string;
  rationale: string;
  objections: string[];
  evidenceIds: string[];
  uncertainty?: string;
};
type Agent = {
  context: MapNode;
  evaluation: MapNode | null;
  hasGraphEvaluation: boolean;
  objections: MapNode[];
  choice: string | null;
};

const choiceNames: Record<string, string> = {
  concept_a: "Concept A",
  concept_b: "Concept B",
  status_quo: "Current solution",
  neither: "Neither option",
  insufficient_information: "More information needed",
};

// Small abstract pixel portraits distinguish contexts without suggesting real people.
const pixelPatterns = [
  ["00100", "01110", "11011", "11111", "10101"].join(""),
  ["01110", "11011", "11111", "01110", "10101"].join(""),
  ["00100", "01110", "11111", "10101", "10101"].join(""),
  ["01110", "11111", "10101", "11111", "01010"].join(""),
];

function PixelMark({ index }: { index: number }) {
  return <span className="orit-agent-pixels" aria-hidden="true">{[...pixelPatterns[index % pixelPatterns.length]].map((pixel, cell) =>
    <span key={cell} className={pixel === "1" ? "is-filled" : ""} />)}</span>;
}

function choiceName(choice: string | null) {
  return choice ? choiceNames[choice] ?? choice.replaceAll("_", " ") : "Waiting";
}

function choiceTone(choice: string | null) {
  if (choice === "concept_a") return "a";
  if (choice === "concept_b") return "b";
  if (choice === "status_quo") return "alternative";
  if (choice === "neither") return "neither";
  return "pending";
}

function contextParts(summary: string | undefined) {
  const text = summary?.trim() ?? "";
  const separator = ". Current alternative: ";
  const index = text.indexOf(separator);
  if (index < 0) return { job: text, alternative: "" };
  return { job: text.slice(0, index).trim(), alternative: text.slice(index + separator.length).trim() };
}

function numericAgentId(id: string) {
  const match = /(?:buyer|context):([0-9]+)$/.exec(id);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function cleanDisplayText(text: string) {
  return text.replace(/\s*\[src:[^\]]+\]/gi, "").replace(/\s{2,}/g, " ").trim();
}

export default function AgentSimulationView({
  graph,
  sources = [],
  savedEvaluations = [],
  discussion = null,
  onInspectEvidence,
}: {
  graph: Graph;
  sources?: Source[];
  savedEvaluations?: SavedAgentEvaluation[];
  discussion?: AgentDiscussion | null;
  onInspectEvidence?: (nodeId: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const agents = useMemo<Agent[]>(() => {
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const evaluations = graph.nodes.filter((node) => node.kind === "outcome" && typeof node.metadata?.contextId === "string");
    return graph.nodes.filter((node) => /^(context|persona|buyer)$/.test(node.kind.toLowerCase()))
      .sort((a, b) => numericAgentId(a.id) - numericAgentId(b.id) || a.label.localeCompare(b.label))
      .map((context) => {
        const linkedEvaluation = graph.edges
          .filter((edge) => edge.source === context.id && edge.kind === "evaluates")
          .map((edge) => nodes.get(edge.target))
          .find((node) => node?.kind === "outcome" && node.metadata?.contextId === context.id);
        const graphEvaluation = linkedEvaluation ?? evaluations.find((node) => node.metadata?.contextId === context.id) ?? null;
        const savedEvaluation = savedEvaluations.find((item) => item.contextId === context.id);
        const evaluation: MapNode | null = graphEvaluation ?? (savedEvaluation ? {
          id: savedEvaluation.id,
          kind: "outcome",
          label: savedEvaluation.choice.replaceAll("_", " "),
          summary: savedEvaluation.rationale,
          sourceIds: savedEvaluation.evidenceIds,
          metadata: { contextId: context.id, choice: savedEvaluation.choice, uncertainty: savedEvaluation.uncertainty },
        } : null);
        const objections = graphEvaluation ? graph.edges
          .filter((edge) => edge.source === graphEvaluation.id)
          .map((edge) => nodes.get(edge.target))
          .filter((node): node is MapNode => node?.kind === "objection") : savedEvaluation?.objections.map((objection, index) => ({
          id: `objection:${context.id}:${index}`,
          kind: "objection",
          label: objection.slice(0, 80),
          summary: objection,
          sourceIds: savedEvaluation.evidenceIds,
          metadata: {},
        })) ?? [];
        const choice = typeof evaluation?.metadata?.choice === "string" ? evaluation.metadata.choice : null;
        return { context, evaluation, hasGraphEvaluation: Boolean(graphEvaluation), objections, choice };
      });
  }, [graph, savedEvaluations]);
  const selected = agents.find((agent) => agent.context.id === selectedId) ?? agents[0] ?? null;
  const selectedIndex = selected ? agents.indexOf(selected) : -1;
  const evaluated = agents.filter((agent) => agent.evaluation).length;
  const discussionParticipants = new Set(discussion?.perspectives.map((item) => item.contextId) ?? []);
  const sourceById = useMemo(() => new Map(sources.map((source) => [source.id, source])), [sources]);

  if (!agents.length) {
    return <div className="orit-agent-empty"><div className="orit-agent-empty-pixels" aria-hidden="true" /><h3>No agents saved yet</h3><p>Buyer contexts appear after the simulation creates them.</p></div>;
  }

  const selectedParts = contextParts(selected?.context.summary);
  const budget = typeof selected?.context.metadata?.budget === "string" || typeof selected?.context.metadata?.budget === "number"
    ? String(selected.context.metadata.budget) : null;
  const uncertainty = typeof selected?.evaluation?.metadata?.uncertainty === "string"
    ? selected.evaluation.metadata.uncertainty : null;
  const sourceIds = [...new Set([...(selected?.evaluation?.sourceIds ?? []), ...(selected?.objections.flatMap((node) => node.sourceIds ?? []) ?? [])])];
  const linkedSources = sourceIds.map((id) => sourceById.get(id)).filter((source): source is Source => Boolean(source));
  const perspectives = discussion?.perspectives.flatMap((perspective) => {
    const agent = agents.find((item) => item.context.id === perspective.contextId);
    return agent ? [{ ...perspective, label: agent.context.label, index: agents.indexOf(agent), choice: agent.choice }] : [];
  }) ?? [];

  return <section className="orit-agent-simulation" aria-label="Saved hypothetical agent simulation"><div className="orit-agent-layout">
    <div className="orit-agent-field">
      <div className="orit-agent-field-head"><span>Hypothetical agents</span><strong>{evaluated}/{agents.length} saved</strong></div>
      <div className="orit-agent-pixel-field" role="group" aria-label="Select an agent">
        {agents.map((agent, index) => <button
          type="button"
          key={agent.context.id}
          className={`orit-agent-tile ${selected?.context.id === agent.context.id ? "is-selected" : ""} ${discussionParticipants.has(agent.context.id) ? "is-discussion-participant" : ""}`}
          data-tone={choiceTone(agent.choice)}
          onClick={() => setSelectedId(agent.context.id)}
          aria-pressed={selected?.context.id === agent.context.id}
          aria-label={`${agent.context.label}, ${choiceName(agent.choice)}`}
        >
          <span className="orit-agent-tile-top"><PixelMark index={index} /></span>
          <strong>{agent.context.label}</strong>
          <small><span className="orit-agent-choice-dot" />{choiceName(agent.choice)}</small>
        </button>)}
      </div>
      {perspectives.length > 0 && <div className={`orit-agent-discussion-link ${perspectives.length > 1 ? "has-multiple" : ""}`}><span>Saved discussion</span><div role="group" aria-label="Agents with saved discussion perspectives">{perspectives.map((perspective) => <button
        type="button"
        key={perspective.contextId}
        className={selected?.context.id === perspective.contextId ? "is-selected" : ""}
        data-tone={choiceTone(perspective.choice)}
        onClick={() => setSelectedId(perspective.contextId)}
        aria-pressed={selected?.context.id === perspective.contextId}
        aria-label={`Select ${cleanDisplayText(perspective.label)} from saved discussion`}
      ><PixelMark index={perspective.index} /></button>)}</div></div>}
    </div>
    <aside className="orit-agent-inspector" aria-live="polite">
      {selected && <>
        <div className="orit-agent-inspector-head"><span>Selected agent</span><span>{String(selectedIndex + 1).padStart(2, "0")} / {String(agents.length).padStart(2, "0")}</span></div>
        <div className="orit-agent-selected-title"><span className="orit-agent-selected-mark" data-tone={choiceTone(selected.choice)}><PixelMark index={selectedIndex} /></span><h3>{selected.context.label}</h3></div>
        <div className="orit-agent-selected-choice" data-tone={choiceTone(selected.choice)}><span className="orit-agent-choice-dot" />{choiceName(selected.choice)}</div>
        <p className="orit-agent-preview">{selected.evaluation?.summary ? cleanDisplayText(selected.evaluation.summary) : "Evaluation waiting to be saved."}</p>
        <details className="orit-agent-details">
          <summary>Context and reasoning <ChevronDown size={14} /></summary>
          <div className="orit-agent-details-body">
            {selectedParts.job && <div><span>Buyer context</span><p>{cleanDisplayText(selectedParts.job)}</p></div>}
            {selectedParts.alternative && <div><span>Current alternative</span><p>{cleanDisplayText(selectedParts.alternative)}</p></div>}
            {budget && <div><span>Budget</span><p>{budget}</p></div>}
            {selected.evaluation && <div><span>Decision rationale</span><p>{cleanDisplayText(selected.evaluation.summary ?? "")}</p></div>}
            {uncertainty && <div><span>Uncertainty</span><p>{cleanDisplayText(uncertainty)}</p></div>}
            {selected.objections.length > 0 && <div><span>Objections</span><ul>{selected.objections.map((objection) => <li key={objection.id}>{cleanDisplayText(objection.summary || objection.label)}</li>)}</ul></div>}
            {linkedSources.length > 0 && <div><span>Linked evidence</span><div className="orit-agent-sources">{linkedSources.map((source) => source.url
              ? <a key={source.id} href={source.url} target="_blank" rel="noopener noreferrer">{source.title || source.url}<ExternalLink size={13} /></a>
              : <p key={source.id}>{source.title || "Saved source"}</p>)}</div></div>}
          </div>
        </details>
        {discussion && <details className="orit-agent-discussion">
          <summary>Saved discussion <span>{perspectives.length} perspectives</span><ChevronDown size={14} /></summary>
          <div className="orit-agent-discussion-body"><p>{cleanDisplayText(discussion.objection)}</p><div>{perspectives.map((perspective) => <button type="button" key={perspective.contextId} onClick={() => setSelectedId(perspective.contextId)}><strong>{perspective.label}</strong><span>{cleanDisplayText(perspective.position)}</span></button>)}</div><p>{cleanDisplayText(discussion.conclusion)}</p><small>Model-written perspectives. Independent decisions are unchanged.</small></div>
        </details>}
        {onInspectEvidence && <button type="button" className="orit-agent-inspect-button" onClick={() => onInspectEvidence(selected.hasGraphEvaluation ? selected.evaluation!.id : selected.context.id)}>View on map <ArrowUpRight size={15} /></button>}
      </>}
    </aside>
  </div></section>;
}
