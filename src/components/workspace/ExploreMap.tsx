"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, Background, Controls, Handle, MarkerType, MiniMap, Position, type Edge, type Node, type NodeProps, type Viewport } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ExternalLink, List, Network, Users, X } from "lucide-react";
import AgentSimulationView from "./AgentSimulationView";
import type { Graph, MapNode } from "./types";

type ResearchFlowNode = Node<{ kind: string; label: string; summary: string; index: string }, "research">;

const kindName: Record<string, string> = {
  idea: "Idea", decision: "Decision", source: "Source", evidence: "Evidence",
  claim: "Claim", assumption: "Assumption", world: "World model", context: "Buyer context",
  persona: "Buyer context", buyer: "Buyer context", objection: "Objection", scenario: "Scenario",
  evaluation: "Evaluation", result: "Result", outcome: "Outcome", report: "Finding",
};

const orderedKinds = ["idea", "decision", "source", "evidence", "claim", "assumption", "world", "context", "persona", "buyer", "objection", "scenario", "evaluation", "result", "outcome", "report"];

function layerFor(kind: string) {
  const key = kind.toLowerCase();
  if (/idea|decision/.test(key)) return 0;
  if (/source|evidence|competitor/.test(key)) return 1;
  if (/claim|assumption|world|market/.test(key)) return 2;
  if (/context|persona|buyer|segment/.test(key)) return 3;
  if (/objection|scenario|sensitivity|evaluation/.test(key)) return 4;
  return 5;
}

function ResearchNode({ data }: NodeProps<ResearchFlowNode>) {
  return <div className={`studio-graph-node kind-${data.kind.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>
    <Handle type="target" position={Position.Left} />
    <div className="studio-graph-node-top"><span>{data.index}</span><span>{kindName[data.kind.toLowerCase()] ?? data.kind.replaceAll("_", " ")}</span></div>
    <strong>{data.label}</strong>
    {data.summary && <p>{data.summary}</p>}
    <Handle type="source" position={Position.Right} />
  </div>;
}

const nodeTypes = { research: ResearchNode };

function makeFlow(graph: Graph): { nodes: ResearchFlowNode[]; edges: Edge[] } {
  const grouped = new Map<number, MapNode[]>();
  for (const node of graph.nodes) {
    const layer = layerFor(node.kind);
    grouped.set(layer, [...(grouped.get(layer) ?? []), node]);
  }
  const nodes: ResearchFlowNode[] = [];
  for (const [layer, group] of [...grouped.entries()].sort(([a], [b]) => a - b)) {
    group.sort((a, b) => orderedKinds.indexOf(a.kind) - orderedKinds.indexOf(b.kind) || a.id.localeCompare(b.id));
    group.forEach((node, index) => {
      nodes.push({
        id: node.id,
        type: "research",
        position: { x: layer * 310, y: index * 195 },
        measured: { width: 230, height: 140 },
        data: { kind: node.kind, label: node.label, summary: node.summary ?? "", index: String(index + 1).padStart(2, "0") },
      });
    });
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges: Edge[] = graph.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)).map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label ?? edge.kind?.replaceAll("_", " "),
    type: "smoothstep",
    animated: false,
    markerEnd: { type: MarkerType.ArrowClosed, color: "#8f8f8f" },
    style: { stroke: "#8f8f8f", strokeWidth: 1.3 },
    labelStyle: { fill: "#5d5d5d", fontSize: 10, fontWeight: 600 },
    labelBgStyle: { fill: "#f9f9f9", fillOpacity: 0.95 },
  }));
  return { nodes, edges };
}

export default function ExploreMap({ graph, sources = [] }: { graph: Graph | null; sources?: { id: string; title?: string; url?: string }[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [preferredMode, setPreferredMode] = useState<"agents" | "map" | "list">("agents");
  const [isMobile, setIsMobile] = useState(false);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const canvasRef = useRef<HTMLDivElement>(null);
  const focusScrollRef = useRef<string | null>(null);
  const flow = useMemo(() => makeFlow(graph ?? { nodes: [], edges: [] }), [graph]);
  const selected = graph?.nodes.find((node) => node.id === selectedId) ?? null;
  const sourceById = useMemo(() => new Map(sources.map((source) => [source.id, source])), [sources]);
  const agentCount = graph?.nodes.filter((node) => /^(context|persona|buyer)$/.test(node.kind.toLowerCase())).length ?? 0;
  const mode = preferredMode === "agents" && agentCount === 0 ? (isMobile ? "list" : "map") : preferredMode;

  useEffect(() => {
    const media = window.matchMedia("(max-width: 899px)");
    const update = () => setIsMobile(media.matches);
    const frame = requestAnimationFrame(update);
    media.addEventListener("change", update);
    return () => { cancelAnimationFrame(frame); media.removeEventListener("change", update); };
  }, []);

  useEffect(() => {
    const measure = () => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (rect) setCanvasSize({ width: rect.width, height: rect.height });
    };
    const frame = requestAnimationFrame(measure);
    const observer = typeof ResizeObserver !== "undefined" && canvasRef.current ? new ResizeObserver(measure) : null;
    if (observer && canvasRef.current) observer.observe(canvasRef.current);
    window.addEventListener("resize", measure);
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [mode, flow.nodes.length]);

  useEffect(() => {
    if (focusId || !flow.nodes.length || !canvasSize.width || !canvasSize.height) return;
    const minX = Math.min(...flow.nodes.map((node) => node.position.x));
    const minY = Math.min(...flow.nodes.map((node) => node.position.y));
    const maxX = Math.max(...flow.nodes.map((node) => node.position.x + 230));
    const maxY = Math.max(...flow.nodes.map((node) => node.position.y + 140));
    const width = maxX - minX;
    const height = maxY - minY;
    const dense = flow.nodes.length > 12;
    const zoom = dense
      ? Math.min(0.82, Math.max(0.56, (canvasSize.width - 52) / 660))
      : Math.max(0.2, Math.min(1.1, (canvasSize.width - 52) / width, (canvasSize.height - 52) / height));
    // Dense maps open on their first source and claim rows at a readable scale.
    // The minimap, pan controls, Fit View button, and list expose the whole graph.
    const next = dense
      ? { x: canvasSize.width / 2 - 580 * zoom, y: 26, zoom }
      : { x: (canvasSize.width - width * zoom) / 2 - minX * zoom, y: (canvasSize.height - height * zoom) / 2 - minY * zoom, zoom };
    const frame = requestAnimationFrame(() => setViewport(next));
    return () => cancelAnimationFrame(frame);
  }, [flow, canvasSize.width, canvasSize.height, focusId]);

  useEffect(() => {
    if (!focusId) { focusScrollRef.current = null; return; }
    if (mode !== "map" || !canvasSize.width || !canvasSize.height) return;
    const node = flow.nodes.find((item) => item.id === focusId);
    if (!node) return;
    const zoom = 0.9;
    const frame = requestAnimationFrame(() => {
      setViewport({ x: canvasSize.width / 2 - (node.position.x + 115) * zoom, y: canvasSize.height / 2 - (node.position.y + 70) * zoom, zoom });
      if (focusScrollRef.current !== focusId) {
        canvasRef.current?.scrollIntoView({ block: "start" });
        focusScrollRef.current = focusId;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [mode, focusId, canvasSize.width, canvasSize.height, flow.nodes]);

  if (!graph || graph.nodes.length === 0) {
    return <div className="studio-map-empty"><Network size={25} /><h3>The evidence map will appear here</h3><p>Nodes are added only after a research stage saves its findings.</p></div>;
  }

  return <div className={`studio-map-layout ${mode === "agents" ? "is-agents" : ""}`}>
    <div className="studio-map-stage">
      <div className="studio-map-topbar"><div><span className="studio-caps">Inspectable simulation</span><strong>{agentCount > 0 ? `${agentCount} synthetic buyers` : `${graph.nodes.length} nodes`} <span>·</span> {graph.edges.length} connections</strong></div><div className="studio-segmented" role="group" aria-label="Explore visualization"><button type="button" className={mode === "agents" ? "is-active" : ""} onClick={() => { setFocusId(null); setPreferredMode("agents"); }} aria-label="Agent view" disabled={agentCount === 0}><Users size={15} /> Agents</button><button type="button" className={mode === "map" ? "is-active" : ""} onClick={() => { setFocusId(null); setPreferredMode("map"); }} aria-label="Graph view"><Network size={15} /> Map</button><button type="button" className={mode === "list" ? "is-active" : ""} onClick={() => { setFocusId(null); setPreferredMode("list"); }} aria-label="List view"><List size={15} /> List</button></div></div>
      {mode === "agents" ? <AgentSimulationView graph={graph} sources={sources} onInspectEvidence={(nodeId) => { setSelectedId(nodeId); setFocusId(nodeId); setPreferredMode("map"); }} /> : mode === "list" ? <ul className="studio-map-list">
        {[...graph.nodes].sort((a, b) => layerFor(a.kind) - layerFor(b.kind) || a.label.localeCompare(b.label)).map((node) => <li key={node.id}><button type="button" className={`studio-map-list-item ${selectedId === node.id ? "is-selected" : ""}`} onClick={() => setSelectedId(node.id)}><span>{kindName[node.kind.toLowerCase()] ?? node.kind.replaceAll("_", " ")}</span><strong>{node.label}</strong><small>{node.summary}</small></button></li>)}
      </ul> : <div className="studio-flow-canvas" ref={canvasRef} aria-label="Interactive research evidence map"><ReactFlow nodes={flow.nodes} edges={flow.edges} nodeTypes={nodeTypes} viewport={viewport} onViewportChange={setViewport} minZoom={0.2} maxZoom={1.6} nodesDraggable={false} nodesConnectable={false} elementsSelectable onNodeClick={(_event, node) => setSelectedId(node.id)} proOptions={{ hideAttribution: true }}><Background color="#e6e6e6" gap={24} size={1} /><Controls showInteractive={false} /><MiniMap nodeColor="#5d5d5d" zoomable pannable /></ReactFlow></div>}
    </div>
    {mode !== "agents" && <aside className="studio-map-detail" aria-live="polite">
      {selected ? <><div className="studio-map-detail-header"><span className="studio-caps">{kindName[selected.kind.toLowerCase()] ?? selected.kind.replaceAll("_", " ")}</span><button type="button" onClick={() => setSelectedId(null)} aria-label="Close node details"><X size={17} /></button></div><h3>{selected.label}</h3><p>{selected.summary || "No description was saved for this node."}</p>
        {selected.sourceIds && selected.sourceIds.length > 0 && <div className="studio-map-sources"><span className="studio-caps">Linked sources</span>{selected.sourceIds.map((id) => { const source = sourceById.get(id); return source?.url ? <a key={id} href={source.url} target="_blank" rel="noopener noreferrer">{source.title || source.url}<ExternalLink size={13} /></a> : <span key={id}>{source?.title ?? id}</span>; })}</div>}
        {selected.metadata && Object.keys(selected.metadata).length > 0 && <div className="studio-map-metadata"><span className="studio-caps">Saved details</span>{Object.entries(selected.metadata).filter(([, value]) => typeof value === "string" || typeof value === "number").map(([key, value]) => <div key={key}><span>{key.replaceAll("_", " ")}</span><strong>{String(value)}</strong></div>)}</div>}
        <div className="studio-map-connections"><span className="studio-caps">Connections</span>{graph.edges.filter((edge) => edge.source === selected.id || edge.target === selected.id).map((edge) => { const other = graph.nodes.find((node) => node.id === (edge.source === selected.id ? edge.target : edge.source)); return <button type="button" key={edge.id} onClick={() => setSelectedId(other?.id ?? null)}><small>{edge.label || edge.kind || "linked to"}</small><strong>{other?.label || "Unknown node"}</strong></button>; })}</div>
      </> : <div className="studio-map-detail-empty"><div className="studio-orbit-icon" aria-hidden="true"><span /><span /><span /></div><span className="studio-caps">Inspect the model</span><h3>Follow a thread of evidence.</h3><p>Select a node to see its rationale, linked sources, and connections to the result.</p></div>}
    </aside>}
  </div>;
}
