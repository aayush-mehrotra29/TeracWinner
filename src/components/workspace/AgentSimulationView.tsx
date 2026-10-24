"use client";

import { useMemo, useState } from "react";
import { ArrowUpRight, CircleHelp, ExternalLink, Network } from "lucide-react";
import type { Graph, MapNode } from "./types";

type Source = { id: string; title?: string; url?: string };
type Agent = {
  context: MapNode;
  evaluation: MapNode | null;
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

function choiceName(choice: string | null) {
  return choice ? choiceNames[choice] ?? choice.replaceAll("_", " ") : "Awaiting evaluation";
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

function agentPositions(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / count;
    return { x: 50 + 37 * Math.cos(angle), y: 50 + 36 * Math.sin(angle) };
  });
}

export default function AgentSimulationView({
  graph,
  sources = [],
  onInspectEvidence,
}: {
  graph: Graph;
  sources?: Source[];
  onInspectEvidence?: (nodeId: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const agents = useMemo<Agent[]>(() => {
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const evaluations = graph.nodes.filter((node) =>
      node.kind === "outcome" && typeof node.metadata?.contextId === "string");
    return graph.nodes.filter((node) => /^(context|persona|buyer)$/.test(node.kind.toLowerCase()))
      .sort((a, b) => numericAgentId(a.id) - numericAgentId(b.id) || a.label.localeCompare(b.label))
      .map((context) => {
        const linkedEvaluation = graph.edges
          .filter((edge) => edge.source === context.id && edge.kind === "evaluates")
          .map((edge) => nodes.get(edge.target))
          .find((node) => node?.kind === "outcome" && node.metadata?.contextId === context.id);
        const evaluation = linkedEvaluation ?? evaluations.find((node) => node.metadata?.contextId === context.id) ?? null;
        const objections = evaluation ? graph.edges
          .filter((edge) => edge.source === evaluation.id)
          .map((edge) => nodes.get(edge.target))
          .filter((node): node is MapNode => node?.kind === "objection") : [];
        const choice = typeof evaluation?.metadata?.choice === "string" ? evaluation.metadata.choice : null;
        return { context, evaluation, objections, choice };
      });
  }, [graph]);
  const positions = useMemo(() => agentPositions(agents.length), [agents.length]);
  const idea = graph.nodes.find((node) => node.id === "idea") ?? null;
  const selected = agents.find((agent) => agent.context.id === selectedId) ?? agents[0] ?? null;
  const selectedIndex = selected ? agents.indexOf(selected) : -1;
  const evaluated = agents.filter((agent) => agent.evaluation).length;
  const sourceById = useMemo(() => new Map(sources.map((source) => [source.id, source])), [sources]);

  if (!agents.length) {
    return <div className="orit-agent-empty"><Network size={24} /><span>Agent simulation</span><h3>Buyer contexts will appear here.</h3><p>Open the saved buyer-context stage or a later stage to inspect the hypothetical agents.</p></div>;
  }

  const selectedParts = contextParts(selected?.context.summary);
  const sourceIds = [...new Set([...(selected?.evaluation?.sourceIds ?? []), ...(selected?.objections.flatMap((node) => node.sourceIds ?? []) ?? [])])];
  const budget = typeof selected?.context.metadata?.budget === "string" || typeof selected?.context.metadata?.budget === "number"
    ? String(selected.context.metadata.budget) : null;
  const uncertainty = typeof selected?.evaluation?.metadata?.uncertainty === "string"
    ? selected.evaluation.metadata.uncertainty : null;

  return <section className="orit-agent-simulation" aria-label="Saved synthetic agent simulation">
    <div className="orit-agent-field">
      <div className="orit-agent-field-head">
        <div><span className="orit-agent-eyebrow"><span className="orit-agent-eyebrow-mark" /> Saved simulation snapshot</span><h3>Agent field</h3></div>
        <div className="orit-agent-count"><strong>{String(evaluated).padStart(2, "0")}</strong><span>/ {String(agents.length).padStart(2, "0")} decisions</span></div>
      </div>
      <div className={`orit-agent-canvas ${agents.length > 8 ? "is-dense" : ""}`}>
        {idea && <svg className="orit-agent-links" viewBox="0 0 1000 620" preserveAspectRatio="none" aria-hidden="true">
          {agents.map((agent, index) => graph.edges.some((edge) => edge.source === agent.context.id && edge.target === idea.id)
            ? <g key={agent.context.id} className={selected?.context.id === agent.context.id ? "is-selected" : ""}>
              <line x1="500" y1="310" x2={positions[index].x * 10} y2={positions[index].y * 6.2} />
              <circle cx={positions[index].x * 10} cy={positions[index].y * 6.2} r="3" />
            </g> : null)}
        </svg>}
        <div className="orit-agent-core" aria-label="Research idea">
          <div className="orit-agent-core-icon"><Network size={21} strokeWidth={1.7} /></div>
          <span>Research question</span>
          <strong>{idea?.summary || idea?.label || "The idea"}</strong>
        </div>
        {agents.map((agent, index) => <button
          type="button"
          key={agent.context.id}
          className={`orit-agent-node ${selected?.context.id === agent.context.id ? "is-selected" : ""}`}
          data-tone={choiceTone(agent.choice)}
          style={{ left: `${positions[index].x}%`, top: `${positions[index].y}%` }}
          onClick={() => setSelectedId(agent.context.id)}
          aria-pressed={selected?.context.id === agent.context.id}
          aria-label={`${agent.context.label}, ${choiceName(agent.choice)}`}
        >
          <span className="orit-agent-node-top"><span className="orit-agent-avatar">{String(index + 1).padStart(2, "0")}</span><span className="orit-agent-node-status" /></span>
          <strong>{agent.context.label}</strong>
          <small>{choiceName(agent.choice)}</small>
        </button>)}
      </div>
      <div className="orit-agent-field-foot"><span><span className="orit-agent-foot-dot" /> {agents.length} hypothetical buyer contexts</span><span>Independent evaluations from saved research</span></div>
      <div className="orit-agent-feed">
        <div className="orit-agent-feed-head"><span>Saved decision feed</span><strong>{evaluated} entries</strong></div>
        {evaluated ? <div className="orit-agent-feed-list">{agents.filter((agent) => agent.evaluation).map((agent) => {
          const index = agents.indexOf(agent);
          return <button type="button" key={agent.context.id} className={selected?.context.id === agent.context.id ? "is-selected" : ""} onClick={() => setSelectedId(agent.context.id)}>
            <span className="orit-agent-feed-index">{String(index + 1).padStart(2, "0")}</span>
            <span className="orit-agent-feed-copy"><strong>{agent.context.label}</strong><small>{agent.evaluation?.summary || "Decision saved"}</small></span>
            <span className="orit-agent-feed-choice" data-tone={choiceTone(agent.choice)}>{choiceName(agent.choice)}</span>
          </button>;
        })}</div> : <p>Individual decisions appear here after the evaluation stage is saved.</p>}
      </div>
    </div>
    <aside className="orit-agent-inspector" aria-live="polite">
      {selected && <>
        <div className="orit-agent-inspector-head"><span>Agent profile</span><span>{String(selectedIndex + 1).padStart(2, "0")} / {String(agents.length).padStart(2, "0")}</span></div>
        <div className="orit-agent-profile-title"><div className="orit-agent-profile-avatar">{String(selectedIndex + 1).padStart(2, "0")}</div><div><span>Hypothetical buyer</span><h3>{selected.context.label}</h3></div></div>
        <div className="orit-agent-profile-context">
          {selectedParts.job && <p>{selectedParts.job}</p>}
          {selectedParts.alternative && <div><span>Current alternative</span><strong>{selectedParts.alternative}</strong></div>}
          {budget && <div><span>Budget</span><strong>{budget}</strong></div>}
        </div>
        <div className="orit-agent-decision" data-tone={choiceTone(selected.choice)}>
          <span className="orit-agent-section-label">Recorded decision</span>
          <div className="orit-agent-decision-value"><span className="orit-agent-decision-glyph" /><strong>{choiceName(selected.choice)}</strong></div>
          <p>{selected.evaluation?.summary || "This buyer context has been saved. Its independent evaluation has not been saved yet."}</p>
          {uncertainty && <div className="orit-agent-uncertainty"><CircleHelp size={13} /><span>Uncertainty: {uncertainty}</span></div>}
        </div>
        <div className="orit-agent-trace">
          <div className="orit-agent-trace-head"><span className="orit-agent-section-label">Decision trace</span><span>Saved relationships</span></div>
          <ol>
            <li><span>01</span><div><strong>Buyer context</strong><p>{selectedParts.job || selected.context.label}</p></div></li>
            <li><span>02</span><div><strong>Independent evaluation</strong><p>{selected.evaluation ? choiceName(selected.choice) : "Awaiting saved evaluation"}</p></div></li>
            <li><span>03</span><div><strong>Objections</strong>{selected.objections.length ? <ul>{selected.objections.map((objection) => <li key={objection.id}>{objection.summary || objection.label}</li>)}</ul> : <p>{selected.evaluation ? "No objections were saved for this decision." : "Available after evaluation."}</p>}</div></li>
          </ol>
        </div>
        {sourceIds.length > 0 && <div className="orit-agent-sources"><span className="orit-agent-section-label">Linked evidence</span>{sourceIds.map((id) => {
          const source = sourceById.get(id);
          return source?.url ? <a key={id} href={source.url} target="_blank" rel="noopener noreferrer"><span>{source.title || source.url}</span><ExternalLink size={13} /></a> : <span key={id}>{source?.title || id}</span>;
        })}</div>}
        {onInspectEvidence && <button type="button" className="orit-agent-inspect-button" onClick={() => onInspectEvidence(selected.evaluation?.id ?? selected.context.id)}>Inspect on evidence map <ArrowUpRight size={15} /></button>}
      </>}
    </aside>
  </section>;
}
