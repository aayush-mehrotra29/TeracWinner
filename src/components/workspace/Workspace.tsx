"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Activity, ArrowRight, ChevronLeft, FileText, Link2, Menu, MessageCircle, Network, Plus, RotateCw, X } from "lucide-react";
import Composer, { type FollowupInput, type StartInput } from "./Composer";
import ExploreMap from "./ExploreMap";
import ReportView, { asReportContent } from "./ReportView";
import StudyReview from "./StudyReview";
import type { Graph, Message, Project, ReportVersion, ResearchMode, RunEvent, RunSnapshot, Study, WorkspaceView } from "./types";

type ProjectRun = { id: string; version: number; status?: string; mode?: ResearchMode; created_at?: string };
const WORKSPACE_UPDATE_KEY = "orit:workspace-updated-v1";

function announceWorkspaceUpdate() {
  try {
    // Other tabs receive this event; the marker contains no project data.
    window.localStorage.setItem(WORKSPACE_UPDATE_KEY, crypto.randomUUID());
  } catch {
    // Focus and visibility refresh still work when browser storage is disabled.
  }
}

const stageLabels: Record<string, string> = {
  intake: "Frame the decision", evidence: "Find market evidence", world: "Build the world model",
  contexts: "Create buyer contexts", evaluations: "Test independent decisions", sensitivities: "Change the conditions",
  discussion: "Surface objections", synthesis: "Synthesize findings", review: "Challenge the report",
  report: "Publish the report", terac_feasibility: "Quote human study", terac_fieldwork: "Terac fieldwork", human_addendum: "Compare human feedback",
};

const modeLabels: Record<ResearchMode, string> = {
  light_research: "Light research", light_simulation: "Light simulation", deep_simulation: "Deep simulation",
};

const statusLabels: Record<string, string> = {
  queued: "Queued", running: "In progress", needs_input: "Needs your input", awaiting_approval: "Study approval needed",
  awaiting_humans: "Human study in progress", completed: "Completed", failed: "Run failed", integration_blocked: "Integration blocked",
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store", ...init });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string; message?: string } | null;
    throw new Error(body?.error || body?.message || `Request failed (${response.status}).`);
  }
  return response.json() as Promise<T>;
}

function projectTitle(project: Project | undefined): string {
  const title = project?.title?.trim() || project?.idea?.trim() || "Untitled analysis";
  if (title.length <= 52) return title;
  const prefix = title.slice(0, 52);
  const wordEnd = prefix.lastIndexOf(" ");
  return `${prefix.slice(0, wordEnd > 30 ? wordEnd : 52).trimEnd()}…`;
}

function runError(error: unknown): string | null {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return null;
}

function redactedMaterial(value: unknown, taskUrl?: string): unknown {
  if (typeof value === "string") return taskUrl ? value.replaceAll(taskUrl, "[private study response link]") : value;
  if (Array.isArray(value)) return value.map((item) => redactedMaterial(item, taskUrl));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !/task.?url|token|secret|password|api.?key/i.test(key)).map(([key, item]) => [key, redactedMaterial(item, taskUrl)]));
  }
  return value;
}

type StudyQuestion = { id?: string; prompt?: string; text?: string; type?: string };
type ScreeningQuestion = { key?: string; text?: string; pick?: string; answers?: Array<{ text?: string; qualify_logic?: string }> };

function studyFormLocation(taskUrl: unknown): string {
  if (typeof taskUrl !== "string") return "Private response form in this app";
  try {
    const parsed = new URL(taskUrl);
    return `${parsed.origin}/study/[private study token]`;
  } catch {
    return "Private response form in this app";
  }
}

function tallyFormUrl(study: Study | null): string | null {
  const materials = study?.materials;
  for (const value of [materials?.tallyUrl, materials?.taskUrl, study?.tally_url]) {
    if (typeof value !== "string") continue;
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && (url.hostname === "tally.so" || url.hostname.endsWith(".tally.so"))) return url.href;
    } catch { /* A malformed saved URL is not rendered as a link. */ }
  }
  return null;
}

const reportCitationLabels: Record<string, string> = {
  questionAnswers: "Decision answer", findings: "Key finding", strengths: "Reason to believe",
  weaknesses: "Friction point", recommendations: "Recommendation", humanAddendum: "Human finding",
};

function citedReport(snapshot: RunSnapshot, message: Message): ReportVersion | null {
  const versions = snapshot.reports ?? [];
  const explicitVersion = message.report_version;
  if (typeof explicitVersion === "number" && Number.isInteger(explicitVersion)) {
    return versions.find((version) => version.version === explicitVersion) ?? null;
  }
  const byTimestamp = versions.filter((version) => version.created_at <= message.created_at)
    .sort((a, b) => b.version - a.version)[0];
  return byTimestamp ?? snapshot.report;
}

function MessageCitations({ ids, report, reportVersion, onOpenReport }: {
  ids: string[] | null | undefined;
  report: ReturnType<typeof asReportContent>;
  reportVersion: number | null;
  onOpenReport: (anchor: string, version: number | null) => void;
}) {
  if (!Array.isArray(ids) || ids.length === 0) return null;
  if (!report) return <div className="studio-message-citations"><span>Saved citations</span><span>Referenced report version unavailable</span></div>;
  const sources = report.sources;
  const humanSources = report.humanAddendum?.sources ?? [];
  return <div className="studio-message-citations" aria-label="Answer citations"><span>Saved citations</span>{[...new Set(ids)].map((id) => {
    const source = sources.find((item) => item.id === id);
    if (source) return <a key={id} href={source.url} target="_blank" rel="noopener noreferrer" title={source.title}>{source.title}</a>;
    const human = humanSources.find((item) => item.id === id);
    if (human) return <button type="button" key={id} onClick={() => onOpenReport(`human-source-${human.responseId}`, reportVersion)}>Reviewed response {humanSources.indexOf(human) + 1}</button>;
    const match = /^report:(questionAnswers|findings|strengths|weaknesses|recommendations|humanAddendum):(\d+)$/.exec(id);
    if (match) return <button type="button" key={id} onClick={() => onOpenReport(id, reportVersion)}>{reportCitationLabels[match[1]]} {Number(match[2]) + 1}</button>;
    if (id === "report:nextExperiment:0") return <button type="button" key={id} onClick={() => onOpenReport(id, reportVersion)}>Next experiment</button>;
    if (id === "report:pricing:0") return <button type="button" key={id} onClick={() => onOpenReport(id, reportVersion)}>Pricing analysis</button>;
    return <span className="studio-message-citation-label" key={id}>Saved reference {id}</span>;
  })}</div>;
}

function StudyMaterialsView({ materials, assetIds }: { materials: Record<string, unknown>; assetIds: string[] }) {
  const taskUrl = typeof materials.taskUrl === "string" ? materials.taskUrl : undefined;
  const tallyUrl = tallyFormUrl({ id: "", status: "", materials });
  const questions = Array.isArray(materials.questions) ? materials.questions as StudyQuestion[] : [];
  const screening = Array.isArray(materials.screeningQuestions) ? materials.screeningQuestions as ScreeningQuestion[] : [];
  const concepts = Array.isArray(materials.concepts) ? materials.concepts.filter((item): item is string => typeof item === "string") : [];
  const sharedAssetIds = Array.isArray(materials.assetIds) ? materials.assetIds.filter((item): item is string => typeof item === "string") : assetIds;
  const shownFields: Array<[string, unknown]> = [
    ["Study title", materials.title], ["Study description", materials.description], ["Target audience", materials.audience],
    ["Geography", materials.geography], ["Panel criteria", materials.panelDescription], ["Business type", materials.businessType],
    ["Participant task", materials.taskDescription],
  ];
  return <div className="studio-study-materials"><span className="studio-caps">Materials shared with participants</span>
    {shownFields.filter(([, value]) => typeof value === "string" && Boolean(value.trim())).map(([label, value]) => <div key={label}><strong>{label}</strong><p>{redactedMaterial(value, taskUrl) as string}</p></div>)}
    <div><strong>Response form</strong><p>{tallyUrl ? <a href={tallyUrl} target="_blank" rel="noopener noreferrer">Open the Tally survey ↗</a> : <>{studyFormLocation(taskUrl)}. The private study token is hidden here.</>}</p></div>
    {concepts.length > 0 && <div><strong>Concepts shown</strong><ol>{concepts.map((concept, index) => <li key={index}>{concept}</li>)}</ol></div>}
    {screening.length > 0 && <div><strong>Qualification screening</strong><ol>{screening.map((question, index) => <li key={question.key ?? index}><b>{question.text}</b><small>Selection: {question.pick ?? "one"}</small><ul>{(question.answers ?? []).map((answer, answerIndex) => <li key={answerIndex}>{answer.text} <span>{answer.qualify_logic === "must" ? "Required to qualify" : answer.qualify_logic === "reject" ? "Rejects respondent" : answer.qualify_logic}</span></li>)}</ul></li>)}</ol></div>}
    {questions.length > 0 && <div><strong>Interview questions</strong><ol>{questions.map((question, index) => <li key={question.id ?? index}>{question.prompt ?? question.text}</li>)}</ol></div>}
    {sharedAssetIds.length > 0 && <div><strong>Included images</strong><div className="studio-study-images">{sharedAssetIds.map((id, index) => <a href={`/api/assets/${id}`} target="_blank" rel="noopener noreferrer" key={id}><Image unoptimized src={`/api/assets/${id}`} width={82} height={82} alt={`Study reference image ${index + 1}`} /></a>)}</div></div>}
  </div>;
}

function eventText(event: RunEvent): string {
  const payloadMessage = event.payload?.message;
  if (typeof payloadMessage === "string" && payloadMessage.trim()) return payloadMessage;
  const label = stageLabels[event.stage ?? ""] ?? event.stage?.replaceAll("_", " ") ?? "Research";
  switch (event.kind) {
    case "stage_started": return `${label} started`;
    case "stage_completed": return `${label} completed`;
    case "artifact": return `${label}: saved ${String(event.payload?.kind ?? "an artifact").replaceAll("_", " ")}`;
    case "report_ready": return "A report version is ready to inspect";
    case "needs_input": return "The run needs more information before continuing";
    case "integration_blocked": return "A required integration or budget is unavailable";
    case "error": return "The run encountered an error";
    case "terac_quote": return event.payload?.status === "pending" ? "Terac feasibility quote requested" : "A Terac study quote is ready for approval";
    case "terac_approved": return "The Terac study quote and survey materials were approved";
    case "tally_form_created": return "A product-specific Tally survey was created";
    case "terac_launched": return "The Tally survey was linked to the Terac study";
    case "first_human_response": return "First completed response matched to Terac. Agent simulation can begin";
    case "addendum_ready": return "A human feedback addendum is ready";
    default: return event.kind.replaceAll("_", " ");
  }
}

type SurveyPhase = "preparing" | "approval" | "waiting" | "started";

function SurveyGateCard({ study, phase, assetIds }: { study: Study | null; phase: SurveyPhase; assetIds: string[] }) {
  const url = tallyFormUrl(study);
  const materials = study?.materials && typeof study.materials === "object" ? study.materials : null;
  const title = phase === "preparing" ? url ? "Survey ready, Terac setup in progress" : "Preparing the human study" : phase === "approval" ? "Study approval needed" : phase === "waiting" ? "Waiting for the first response" : "First response received";
  const detail = phase === "preparing"
    ? url ? "The Tally survey is created. Orit is arranging Terac fieldwork; participants have not been invited yet. Agent research has not started." : "Orit is preparing a Tally survey from your product description and any attached images, then connecting it to Terac. Agent research has not started."
    : phase === "approval" ? "Review the confirmed Terac quote and survey materials in Chat. Fieldwork starts after your approval, and agent research waits for the first completed response."
      : phase === "waiting" ? "The Tally form is live through Terac. The agent simulation begins after one completed response is matched to the Terac study."
        : "The first Terac response has arrived. Orit is now running the research and synthetic buyer simulation.";
  return <section className="studio-survey-gate" aria-label="Deep simulation study status">
    <div className="studio-survey-gate-heading"><span className="studio-caps">Human-first deep simulation</span><span className={`studio-survey-gate-signal is-${phase}`}><span />{phase === "preparing" ? "Setting up" : phase === "approval" ? "Your approval" : phase === "waiting" ? "Awaiting response" : "Research running"}</span></div>
    <h3>{title}</h3><p>{detail}</p>
    {url && <a className="studio-survey-gate-link" href={url} target="_blank" rel="noopener noreferrer">Open Tally survey <ArrowRight size={16} /></a>}
    {phase === "waiting" && !url && <p className="studio-survey-gate-note">The study is waiting for a response. Its Tally link will appear here when the saved form is available.</p>}
    <ol className="studio-survey-gate-steps" aria-label="Deep simulation sequence"><li className={url ? "is-done" : "is-current"}>Create survey</li><li className={phase === "preparing" || phase === "approval" ? "is-current" : "is-done"}>Launch Terac</li><li className={phase === "waiting" ? "is-current" : phase === "started" ? "is-done" : ""}>First response</li><li className={phase === "started" ? "is-current" : ""}>Agent simulation</li></ol>
    {materials && <details className="studio-survey-gate-details"><summary>What participants see</summary><StudyMaterialsView materials={materials} assetIds={assetIds} /></details>}
  </section>;
}

function validGraph(data: unknown): data is Graph {
  return Boolean(data && typeof data === "object" && Array.isArray((data as Graph).nodes) && Array.isArray((data as Graph).edges));
}

function selectedGraph(snapshot: RunSnapshot, selectedSeq: number | null): Graph | null {
  if (selectedSeq === null) {
    if (snapshot.graph && validGraph(snapshot.graph)) return snapshot.graph;
    const graphArtifact = [...snapshot.artifacts].reverse().find((artifact) => artifact.kind === "graph" && validGraph(artifact.data));
    return graphArtifact?.data as Graph | undefined ?? null;
  }
  const lastMapEvent = [...snapshot.events].reverse().find((event) => event.seq <= selectedSeq && event.kind === "artifact" && event.payload?.kind === "graph");
  if (!lastMapEvent) return null;
  const key = String(lastMapEvent.payload?.key ?? lastMapEvent.stage ?? "");
  const artifact = [...snapshot.artifacts].reverse().find((item) => item.kind === "graph" && item.key === key && validGraph(item.data));
  return artifact?.data as Graph | undefined ?? null;
}

function QuotePanel({ study, assetIds, busy, onApprove }: { study: Study; assetIds: string[]; busy: boolean; onApprove: (quoteId: string, amountUsd: number, fingerprint: string) => Promise<void> }) {
  const [shareApproved, setShareApproved] = useState(false);
  const quote = study.quote && typeof study.quote === "object" ? study.quote : null;
  const materials = study.materials && typeof study.materials === "object" ? study.materials : null;
  const ready = Boolean(quote?.id && typeof quote?.amountUsd === "number" && Number.isFinite(quote.amountUsd) && study.approvalFingerprint && materials);
  return <div className="studio-study-card"><div className="studio-study-card-top"><span className="studio-caps">Human-first deep study</span><strong>12 qualified US responses</strong></div><p>Review the confirmed Terac quote and Tally survey before approving a paid launch. The agent simulation begins after the first completed response is matched to this Terac study.</p>{quote && <div className="studio-study-amount"><span>Confirmed study quote · {quote.currency || "USD"}</span><strong>{typeof quote.amountUsd === "number" ? `$${quote.amountUsd.toFixed(2)}` : "Pending"}</strong></div>}{materials && <StudyMaterialsView materials={materials} assetIds={assetIds} />}{quote && <details><summary>View quote details</summary><pre>{JSON.stringify(redactedMaterial(quote, typeof materials?.taskUrl === "string" ? materials.taskUrl : undefined), null, 2)}</pre></details>}<label className="studio-share-approval"><input type="checkbox" checked={shareApproved} onChange={(event) => setShareApproved(event.target.checked)} /><span>I approve the quoted spend and sharing the materials shown above with study participants.</span></label><button type="button" className="studio-study-approve" onClick={() => quote && study.approvalFingerprint && onApprove(quote.id, quote.amountUsd, study.approvalFingerprint)} disabled={busy || !ready || !shareApproved}>{busy ? "Approving…" : "Approve and launch paid study"}<ArrowRight size={16} /></button></div>;
}

export default function Workspace() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectRuns, setProjectRuns] = useState<ProjectRun[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [view, setView] = useState<WorkspaceView>("chat");
  const [researchView, setResearchView] = useState<"explore" | "report">("explore");
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [selectedReportVersion, setSelectedReportVersion] = useState<number | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [sending, setSending] = useState(false);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const lastSeqRef = useRef(0);
  const runIdRef = useRef<string | null>(null);
  const activeProjectIdRef = useRef<string | null>(null);
  const latestRunIdRef = useRef<string | null>(null);
  const refreshSequenceRef = useRef(0);
  const projectSelectionRef = useRef(0);
  const submissionRef = useRef<{ fingerprint: string; idempotencyKey: string; imageAssetIds: string[] } | null>(null);
  const messageRequestRef = useRef<{ fingerprint: string; key: string; imageAssetIds: string[] } | null>(null);

  function showView(next: WorkspaceView) {
    setView(next);
    if (next !== "chat") setResearchView(next);
    setSidebarOpen(false);
  }

  const loadRun = useCallback(async (runId: string) => {
    const data = await api<RunSnapshot>(`/api/runs/${runId}`);
    if (runIdRef.current !== runId) return;
    setSnapshot(data);
    setProjectRuns((previous) => previous.map((run) => run.id === runId
      ? { ...run, status: data.run.status, mode: data.run.mode } : run));
    lastSeqRef.current = Math.max(0, ...data.events.map((event) => event.seq));
    setPollError(null);
  }, []);

  useEffect(() => { activeProjectIdRef.current = activeProjectId; }, [activeProjectId]);
  useEffect(() => { latestRunIdRef.current = projectRuns[0]?.id ?? null; }, [projectRuns]);

  const refreshWorkspace = useCallback(async () => {
    const refreshSequence = ++refreshSequenceRef.current;
    const result = await api<{ projects: Project[] }>("/api/projects");
    if (refreshSequence !== refreshSequenceRef.current) return;
    setProjects(result.projects ?? []);

    const projectId = activeProjectIdRef.current;
    if (!projectId) return;
    const selection = projectSelectionRef.current;
    const previousLatestRunId = latestRunIdRef.current;
    const currentRunId = runIdRef.current;
    const detail = await api<{ project: Project; runs: ProjectRun[] }>(`/api/projects/${projectId}`);
    if (refreshSequence !== refreshSequenceRef.current || selection !== projectSelectionRef.current ||
        activeProjectIdRef.current !== projectId) return;
    const runs = [...(detail.runs ?? [])].sort((a, b) => b.version - a.version);
    latestRunIdRef.current = runs[0]?.id ?? null;
    setProjectRuns(runs);
    if (runs[0] && (!currentRunId || (currentRunId === previousLatestRunId && runs[0].id !== currentRunId))) {
      runIdRef.current = runs[0].id;
      setActiveRunId(runs[0].id);
      return;
    }
    if (currentRunId) await loadRun(currentRunId);
  }, [loadRun]);

  useEffect(() => {
    let active = true;
    const refresh = () => { void refreshWorkspace().catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : "Could not load projects.");
    }).finally(() => { if (active) setHistoryLoading(false); });
    };
    const onVisibility = () => { if (document.visibilityState === "visible") refresh(); };
    const onStorage = (event: StorageEvent) => { if (event.key === WORKSPACE_UPDATE_KEY) refresh(); };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("storage", onStorage);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("storage", onStorage);
    };
  }, [refreshWorkspace]);

  useEffect(() => {
    if (!activeRunId) return;
    runIdRef.current = activeRunId;
    let alive = true;
    let inFlight = false;
    let polls = 0;
    loadRun(activeRunId).catch((cause: unknown) => {
      if (alive) setError(cause instanceof Error ? cause.message : "Could not open the run.");
    });
    const timer = window.setInterval(async () => {
      if (!alive || inFlight) return;
      inFlight = true;
      try {
        const result = await api<{ events: RunEvent[]; lastSequence: number }>(`/api/runs/${activeRunId}/events?after=${lastSeqRef.current}`);
        if (!alive) return;
        polls += 1;
        if (result.events?.length || polls % 3 === 0) await loadRun(activeRunId);
        setPollError(null);
      } catch (cause) {
        if (alive) setPollError(cause instanceof Error ? cause.message : "Connection interrupted.");
      } finally { inFlight = false; }
    }, 4000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [activeRunId, loadRun]);

  async function openProject(project: Project) {
    const selection = ++projectSelectionRef.current;
    runIdRef.current = null;
    setSidebarOpen(false);
    setError(null);
    setSelectedSeq(null);
    setSelectedReportVersion(null);
    setView("chat");
    setResearchView("explore");
    setActiveProjectId(project.id);
    setProjectRuns([]);
    setSnapshot(null);
    setActiveRunId(null);
    try {
      const data = await api<{ project: Project; runs: ProjectRun[] }>(`/api/projects/${project.id}`);
      if (selection !== projectSelectionRef.current) return;
      const runs = [...(data.runs ?? [])].sort((a, b) => b.version - a.version);
      setProjectRuns(runs);
      if (runs[0]) { runIdRef.current = runs[0].id; setActiveRunId(runs[0].id); }
    } catch (cause) {
      if (selection === projectSelectionRef.current) setError(cause instanceof Error ? cause.message : "Could not open the project.");
    }
  }

  function newAnalysis() {
    projectSelectionRef.current += 1;
    runIdRef.current = null;
    setActiveProjectId(null);
    setProjectRuns([]);
    setActiveRunId(null);
    setSnapshot(null);
    setSelectedSeq(null);
    setSelectedReportVersion(null);
    setView("chat");
    setResearchView("explore");
    setError(null);
    setSidebarOpen(false);
  }

  function openRun(runId: string) {
    if (runId === activeRunId) return;
    runIdRef.current = runId;
    setActiveRunId(runId);
    setSnapshot(null);
    setSelectedSeq(null);
    setSelectedReportVersion(null);
    messageRequestRef.current = null;
    setError(null);
    setView("chat");
    setResearchView("explore");
  }

  async function start(input: StartInput) {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      const fingerprint = JSON.stringify({ ...input, files: input.files.map((file) => [file.name, file.size, file.lastModified, file.type]) });
      if (!submissionRef.current || submissionRef.current.fingerprint !== fingerprint) {
        submissionRef.current = { fingerprint, idempotencyKey: crypto.randomUUID(), imageAssetIds: [] };
      }
      const submission = submissionRef.current;
      for (const file of input.files.slice(submission.imageAssetIds.length)) {
        const form = new FormData();
        form.set("file", file);
        const result = await api<{ asset: { id: string } }>("/api/assets", { method: "POST", body: form });
        submission.imageAssetIds.push(result.asset.id);
      }
      const payload = { idea: input.idea, mode: input.mode, concepts: input.concepts, urls: input.urls, imageAssetIds: submission.imageAssetIds, audience: input.audience, economics: input.economics };
      const result = await api<{ project: Project; run: ProjectRun }>("/api/projects", {
        method: "POST", headers: { "content-type": "application/json", "idempotency-key": submission.idempotencyKey }, body: JSON.stringify(payload),
      });
      refreshSequenceRef.current += 1;
      announceWorkspaceUpdate();
      submissionRef.current = null;
      projectSelectionRef.current += 1;
      runIdRef.current = result.run.id;
      setProjects((previous) => [{ ...result.project, mode: input.mode }, ...previous.filter((item) => item.id !== result.project.id)]);
      setProjectRuns([result.run]);
      setActiveProjectId(result.project.id);
      setSnapshot(null);
      setSelectedSeq(null);
      setSelectedReportVersion(null);
      setView("chat");
      setResearchView("explore");
      setActiveRunId(result.run.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the analysis.");
    } finally { setStarting(false); }
  }

  async function sendMessage(input: FollowupInput): Promise<boolean> {
    if (!activeProjectId || !input.content.trim() || sending || activeRunId !== projectRuns[0]?.id ||
      (!reportReady && snapshot?.run.status !== "needs_input")) return false;
    setSending(true);
    setError(null);
    const content = input.content.trim();
    const fingerprint = JSON.stringify({ projectId: activeProjectId, runId: activeRunId, content, mode: input.mode,
      urls: input.urls, files: input.files.map((file) => [file.name, file.size, file.lastModified, file.type]) });
    if (!messageRequestRef.current || messageRequestRef.current.fingerprint !== fingerprint) {
      messageRequestRef.current = { fingerprint, key: crypto.randomUUID(), imageAssetIds: [] };
    }
    try {
      const submission = messageRequestRef.current;
      for (const file of input.files.slice(submission.imageAssetIds.length)) {
        const form = new FormData();
        form.set("file", file);
        const result = await api<{ asset: { id: string } }>("/api/assets", { method: "POST", body: form });
        submission.imageAssetIds.push(result.asset.id);
      }
      const payload = { content, ...(input.urls.length ? { urls: input.urls } : {}),
        ...(submission.imageAssetIds.length ? { imageAssetIds: submission.imageAssetIds } : {}),
        ...(input.mode !== snapshot?.run.mode ? { mode: input.mode } : {}) };
      const result = await api<{ message: Message; answer?: Message | string; run?: ProjectRun }>(`/api/projects/${activeProjectId}/messages`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": submission.key }, body: JSON.stringify(payload) });
      announceWorkspaceUpdate();
      messageRequestRef.current = null;
      if (result.run?.id && result.run.id !== activeRunId) {
        setProjectRuns((previous) => [result.run!, ...previous.filter((run) => run.id !== result.run!.id)].sort((a, b) => b.version - a.version));
        openRun(result.run.id);
      }
      else if (activeRunId) await loadRun(activeRunId);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send your message.");
      return false;
    } finally { setSending(false); }
  }

  async function approveStudy(studyId: string, quoteId: string, amountUsd: number, approvalFingerprint: string) {
    setApproving(true);
    setError(null);
    try {
      await api(`/api/studies/${studyId}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approve: true, shareApproved: true, quoteId, amountUsd, approvalFingerprint }) });
      announceWorkspaceUpdate();
      if (activeRunId) await loadRun(activeRunId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not approve the study.");
    } finally { setApproving(false); }
  }

  function openReportCitation(anchor: string, version: number | null) {
    setSelectedReportVersion(version);
    showView("report");
    window.setTimeout(() => {
      const target = document.getElementById(anchor);
      if (target instanceof HTMLDetailsElement) target.open = true;
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
  }

  const activeProject = snapshot?.project ?? projects.find((project) => project.id === activeProjectId);
  const activeEvents = snapshot?.events ?? [];
  const graph = snapshot ? selectedGraph(snapshot, selectedSeq) : null;
  const reportContent = asReportContent(snapshot?.report ?? null);
  const savedRunInput = snapshot?.run.input && typeof snapshot.run.input === "object"
    ? snapshot.run.input as Record<string, unknown> : {};
  const runInputUrls = Array.isArray(savedRunInput.urls)
    ? savedRunInput.urls.filter((url): url is string => typeof url === "string" && url.startsWith("https://")) : [];
  const rawImageIds = savedRunInput.imageAssetIds ?? savedRunInput.assetIds;
  const runInputImageIds = Array.isArray(rawImageIds)
    ? rawImageIds.filter((id): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)) : [];
  const evidenceData = snapshot?.artifacts.find((artifact) => artifact.kind === "evidence" && artifact.key === "main")?.data as { sources?: unknown } | undefined;
  const mapSources = reportContent?.sources ?? (Array.isArray(evidenceData?.sources)
    ? evidenceData.sources.filter((source): source is { id: string; title: string; url: string } =>
      Boolean(source && typeof source.id === "string" && typeof source.title === "string" && typeof source.url === "string")) : []);
  const visibleReport = selectedReportVersion === null ? snapshot?.report ?? null : snapshot?.reports?.find((report) => report.version === selectedReportVersion) ?? snapshot?.report ?? null;
  const reportReady = Boolean(reportContent);
  const isDeep = snapshot?.run.mode === "deep_simulation";
  const firstHumanResponse = activeEvents.some((event) => event.kind === "first_human_response");
  const surveyPhase: SurveyPhase | null = isDeep && !reportReady &&
    !["failed", "integration_blocked", "needs_input"].includes(snapshot?.run.status ?? "")
    ? firstHumanResponse ? "started"
      : snapshot?.run.status === "awaiting_approval" ? "approval"
        : snapshot?.run.status === "awaiting_humans" && snapshot?.run.stage === "terac_fieldwork" && Boolean(snapshot?.study?.launched_at) ? "waiting"
          : "preparing"
    : null;
  const activeStatusLabel = snapshot?.run.status === "awaiting_humans"
    ? surveyPhase === "preparing"
      ? snapshot.study?.status === "feasibility_pending" ? "Terac quote pending" : "Preparing human study"
      : surveyPhase === "waiting" ? "Waiting for a human response" : statusLabels.awaiting_humans
    : statusLabels[snapshot?.run.status ?? "queued"];
  const hasFeasibility = activeEvents.some((event) => event.stage === "terac_feasibility");
  const humanFirstDeep = isDeep && (!reportReady || Boolean(tallyFormUrl(snapshot?.study ?? null)) || firstHumanResponse);
  const simulationStages = ["intake", "evidence", "world", "contexts", "evaluations", "sensitivities", "discussion", "synthesis", "review", "report"];
  const stages = snapshot?.run.mode === "light_research"
    ? ["intake", "evidence", "world", "synthesis", "review", "report"]
    : humanFirstDeep
      ? [...(hasFeasibility ? ["terac_feasibility"] : []), "terac_fieldwork", ...simulationStages, "human_addendum"]
      : [...simulationStages, ...(snapshot?.study ? ["terac_feasibility", "terac_fieldwork", "human_addendum"] : [])];
  const completedStages = new Set(activeEvents.filter((event) => event.kind === "stage_completed").map((event) => event.stage));
  if (firstHumanResponse) completedStages.add("terac_fieldwork");
  const messages = (snapshot?.messages ?? []).filter((message) => message.run_id === snapshot?.run.id);
  const viewingOlderRun = Boolean(activeRunId && projectRuns.length && activeRunId !== projectRuns[0].id);
  const clarification = activeEvents.findLast((event) => event.kind === "needs_input");
  const clarificationQuestions = Array.isArray(clarification?.payload?.questions)
    ? clarification.payload.questions.filter((question): question is string => typeof question === "string" && Boolean(question.trim())) : [];
  const timelineEntries = activeEvents.filter((event) => event.kind === "stage_completed").map((event) => {
    const graphEvent = activeEvents.find((candidate) => candidate.kind === "artifact" && candidate.payload?.kind === "graph" && candidate.stage === event.stage && candidate.seq > event.seq);
    return { event, replaySeq: graphEvent?.seq ?? event.seq };
  });

  return <div className="studio-shell" id="top">
    <aside className={`studio-sidebar ${sidebarOpen ? "is-open" : ""}`}>
      <div className="studio-sidebar-head">
        <button className="studio-brand" type="button" onClick={newAnalysis} aria-label="Orit home">orit<b>.</b></button>
        <button className="studio-mobile-close" type="button" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar"><X size={18} /></button>
      </div>
      <button type="button" className="studio-new-button" onClick={newAnalysis}><Plus size={17} /> New analysis</button>
      <nav className="studio-view-tabs" aria-label="Workspace views">
        <button type="button" className={view === "chat" ? "is-active" : ""} onClick={() => showView("chat")}><MessageCircle size={17} /> Chat</button>
        <button type="button" className={view === "explore" ? "is-active" : ""} onClick={() => showView("explore")} disabled={!activeProjectId}><Network size={17} /> Explore {activeProjectId && <span>{graph?.nodes.length ?? snapshot?.graph?.nodes.length ?? 0}</span>}</button>
        <button type="button" className={view === "report" ? "is-active" : ""} onClick={() => showView("report")} disabled={!activeProjectId}><FileText size={17} /> Report {reportReady && <span className="studio-tab-dot" />}</button>
      </nav>
      <div className="studio-sidebar-section">
        <div className="studio-sidebar-section-title"><span>Recent analyses</span><span>{projects.length}</span></div>
        {historyLoading ? <p className="studio-sidebar-help">Loading projects…</p> : projects.length === 0 ? <p className="studio-sidebar-help">Your analyses will appear here.</p> : <div className="studio-project-list">{projects.map((project) =>
          <button key={project.id} type="button" className={`studio-project-item ${activeProjectId === project.id ? "is-active" : ""}`} onClick={() => openProject(project)}>
            <span className="studio-project-icon"><FileText size={15} /></span><span><strong>{projectTitle(project)}</strong><small>{project.mode ? modeLabels[project.mode] : "Research project"}</small></span>
          </button>)}</div>}
      </div>
      <div className="studio-sidebar-bottom"><div className="studio-sidebar-signal"><span className="studio-signal-dot" /> Local research workspace <span>·</span> US market</div></div>
    </aside>

    <main className="studio-main">
      <header className="studio-topbar">
        <button type="button" className="studio-menu-button" onClick={() => setSidebarOpen(true)} aria-label="Open sidebar"><Menu size={20} /></button>
        <span className="studio-topbar-label">Orit / Research studio</span>
        <div className="studio-topbar-right"><span className="studio-topbar-live"><span /> Evidence-led analysis</span></div>
      </header>
      {error && <div className="studio-global-error" role="alert"><strong>Action needed</strong><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="Dismiss error"><X size={16} /></button></div>}
      {activeProjectId && <nav className="studio-mobile-view-tabs" aria-label="Workspace views">
        <button type="button" className={view === "chat" ? "is-active" : ""} onClick={() => showView("chat")}><MessageCircle size={16} /> Chat</button>
        <button type="button" className={view === "explore" ? "is-active" : ""} onClick={() => showView("explore")}><Network size={16} /> Explore</button>
        <button type="button" className={view === "report" ? "is-active" : ""} onClick={() => showView("report")}><FileText size={16} /> Report</button>
      </nav>}
      <div className="studio-workspace-body" data-mobile-view={view}>
        <section className="studio-conversation-pane" aria-label="Research chat">
          {!activeProjectId ? <div className="studio-start-page">
            <div className="studio-start-content">
              <div className="studio-start-intro"><span className="studio-caps">NEW ANALYSIS</span><h2>What would you like to research?</h2><p>Describe the product decision. Orit will gather evidence, run the selected analysis, and build a report you can inspect.</p></div>
              <Composer onStart={start} busy={starting} />
            </div>
          </div> : <div className="studio-run-page">
            <div className="studio-run-header">
              <div className="studio-run-breadcrumb"><button type="button" onClick={newAnalysis}><ChevronLeft size={15} /> All analyses</button><span>/</span><span>{modeLabels[snapshot?.run.mode ?? activeProject?.mode ?? "light_research"]}</span></div>
              <div className="studio-run-title-row"><div><span className="studio-caps">Project analysis</span><h1>{projectTitle(activeProject)}</h1></div><span className={`studio-status is-${snapshot?.run.status ?? "queued"}`}><span />{activeStatusLabel}</span></div>
            </div>
            {projectRuns.length > 1 && <div className="studio-run-history"><label htmlFor="studio-run-version">Research run</label><select id="studio-run-version" value={activeRunId ?? ""} onChange={(event) => openRun(event.target.value)} disabled={sending}>{projectRuns.map((run) => <option key={run.id} value={run.id}>Run v{run.version} · {run.id === activeRunId && snapshot ? activeStatusLabel : statusLabels[run.status ?? ""] ?? run.status ?? "Saved"}{run.id === projectRuns[0].id ? " · Latest" : ""}</option>)}</select>{viewingOlderRun && <button type="button" onClick={() => openRun(projectRuns[0].id)}>Latest <ArrowRight size={14} /></button>}</div>}
            {activeRunId && !snapshot ? <div className="studio-run-loading" role="status"><RotateCw size={20} className="studio-spin" /> Loading saved analysis…</div> : !snapshot ? <div className="studio-run-loading">No run found for this project.</div> : <>
              {pollError && <div className="studio-poll-warning" role="status">Updates paused: {pollError}. Retrying automatically.</div>}
              <div className="studio-chat-layout"><div className="studio-chat-main"><div className="studio-conversation">
                <div className="studio-chat-date"><span />Analysis conversation<span /></div>
                <div className="studio-chat-user"><span className="studio-chat-avatar">YOU</span><div><span className="studio-caps">Your idea</span><p>{activeProject?.idea || "Idea saved with this project."}</p></div></div>
                <div className="studio-chat-system"><span className="studio-system-avatar"><Activity size={18} /></span><div><span className="studio-caps">Research system</span><p>{snapshot.run.status === "integration_blocked" ? "The analysis cannot continue until a required provider or budget is configured." : reportReady ? "A report version is ready. Inspect the map and report, or ask a question grounded in the saved findings." : surveyPhase === "preparing" ? "Orit is preparing the participant survey and Terac study. Agent research waits for the first response." : surveyPhase === "approval" ? "Your Terac quote is ready for approval. The agent simulation will wait for the first completed response." : surveyPhase === "waiting" ? "The Tally survey is live through Terac. Agent research begins after the first completed response arrives." : surveyPhase === "started" ? "The first Terac response has arrived. Agent research is underway." : snapshot.run.status === "queued" ? "Your run is queued. Stages will appear here as they are saved." : "The analysis is underway. Every update below comes from a saved run event."}</p></div></div>
                {snapshot.run.status === "integration_blocked" && <div className="studio-state-banner is-blocked"><strong>Integration blocked</strong><p>{runError(snapshot.run.error) || activeEvents.findLast((event) => event.kind === "integration_blocked")?.payload?.message?.toString() || "A required provider credential or budget is unavailable. Configure it and start a new analysis."}</p></div>}
                {snapshot.run.status === "failed" && <div className="studio-state-banner is-failed"><strong>Run failed</strong><p>{runError(snapshot.run.error) || "The worker stopped before completing this run."}</p></div>}
                {snapshot.run.status === "needs_input" && <div className="studio-state-banner is-input"><strong>More detail needed</strong>{clarificationQuestions.length > 0 ? <ul>{clarificationQuestions.map((question, index) => <li key={`${index}-${question}`}>{question}</li>)}</ul> : <p>{clarification?.payload?.message?.toString() || "Add the missing detail to continue."}</p>}</div>}
                {activeEvents.length > 0 && <div className="studio-event-feed" aria-label="Saved run events">{activeEvents.map((event) => <button type="button" key={event.seq} className="studio-event" onClick={() => { setSelectedSeq(event.seq); showView("explore"); }}><span className={`studio-event-marker kind-${event.kind}`} /><span><small>{event.stage ? stageLabels[event.stage] ?? event.stage.replaceAll("_", " ") : "Run event"} · {new Date(event.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</small><strong>{eventText(event)}</strong></span><ArrowRight size={15} /></button>)}</div>}
                {snapshot.run.status === "awaiting_approval" && snapshot.study && <QuotePanel key={snapshot.study.approvalFingerprint ?? snapshot.study.id} study={snapshot.study} assetIds={Array.isArray((snapshot.run.input as { assetIds?: unknown } | undefined)?.assetIds) ? (snapshot.run.input as { assetIds: string[] }).assetIds : []} busy={approving} onApprove={(quoteId, amountUsd, fingerprint) => approveStudy(snapshot.study!.id, quoteId, amountUsd, fingerprint)} />}
                {surveyPhase && surveyPhase !== "approval" && <SurveyGateCard study={snapshot.study} phase={surveyPhase} assetIds={runInputImageIds} />}
                {snapshot.run.status === "awaiting_humans" && reportReady && <div className="studio-state-banner is-waiting"><strong>Human feedback is in progress</strong><p>Your report is available now. A human-feedback addendum will appear after the remaining responses are reviewed.</p></div>}
                {snapshot.run.mode === "deep_simulation" && reportContent?.metadata.humanStatus === "unavailable" && <div className="studio-state-banner is-waiting"><strong>Synthetic report complete</strong><p>Human feedback is unavailable in this local version. The Report tab shows the saved evidence and synthetic buyer results.</p></div>}
                {reportReady && <button type="button" className="studio-report-teaser" onClick={() => showView("report")}><span><span className="studio-caps">Report v{snapshot.report?.version}</span><strong>{reportContent?.title}</strong><small>{reportContent?.verdictReason}</small></span><ArrowRight size={20} /></button>}
                {messages.filter((message) => message.content !== activeProject?.idea).map((message) => {
                  const version = citedReport(snapshot, message);
                  return <div key={message.id} className={`studio-chat-message is-${message.role}`}><span className="studio-caps">{message.role === "user" ? "You" : "Report answer"}</span><p>{message.content}</p>{message.role === "user" && message.idempotency_key === snapshot.run.idempotency_key && (runInputUrls.length > 0 || runInputImageIds.length > 0) && <div className="studio-chat-materials"><span>Research inputs for this run</span><div>{runInputUrls.map((url) => <a href={url} target="_blank" rel="noopener noreferrer" key={url}><Link2 size={13} />{new URL(url).hostname}</a>)}{runInputImageIds.map((id, index) => <a href={`/api/assets/${id}`} target="_blank" rel="noopener noreferrer" className="is-image" key={id}><Image unoptimized src={`/api/assets/${id}`} width={22} height={22} alt="" />Image {index + 1}</a>)}</div></div>}{message.role === "assistant" && <MessageCitations ids={message.citations} report={asReportContent(version)} reportVersion={version?.version ?? null} onOpenReport={openReportCitation} />}</div>;
                })}
              </div>{viewingOlderRun ? <div className="studio-followup studio-followup-archived"><p>This is a saved earlier run. Its answers and citations refer to the report shown here.</p><button type="button" onClick={() => openRun(projectRuns[0].id)}>Go to the latest run to ask a question <ArrowRight size={15} /></button></div> : !reportReady && snapshot.run.status !== "needs_input" ? <div className="studio-followup studio-followup-archived"><p>{snapshot.run.status === "integration_blocked" ? "Questions will be available after the required integration or budget is configured and a report is complete." : snapshot.run.status === "failed" ? "This run did not produce a report. Start a new analysis to try again." : surveyPhase === "waiting" ? "The chat opens for report questions after the first Terac response starts the agent simulation and the report is saved." : "Questions will be available as soon as the saved report is ready."}</p></div> : <Composer key={snapshot.run.id} kind="followup" onFollowup={sendMessage} busy={sending} initialMode={snapshot.run.mode} canAddResearch={reportReady} existingUrls={runInputUrls} existingImageCount={runInputImageIds.length} />}</div></div>
            </>}
          </div>}
        </section>

        <section className="studio-research-pane" data-research-view={researchView} aria-label="Research artifacts">
          <div className="studio-research-header"><div><span className="studio-caps">RESEARCH</span><h2>{activeProjectId ? projectTitle(activeProject) : "Workspace"}</h2></div>
            {activeProjectId && <nav className="studio-research-tabs" aria-label="Research views"><button type="button" className={researchView === "explore" ? "is-active" : ""} onClick={() => showView("explore")}><Network size={15} /> Explore</button><button type="button" className={researchView === "report" ? "is-active" : ""} onClick={() => showView("report")}><FileText size={15} /> Report</button></nav>}
          </div>
          {!activeProjectId ? <div className="studio-empty-research"><Network size={24} /><h2>Research appears here.</h2><p>After you start an analysis, explore the saved evidence map, inspect each decision stage, and read the report beside your chat.</p></div>
          : activeRunId && !snapshot ? <div className="studio-run-loading" role="status"><RotateCw size={20} className="studio-spin" /> Loading research artifacts…</div>
          : !snapshot ? <div className="studio-run-loading">No research run found.</div>
          : <>
            <details className="studio-research-progress"><summary>Run progress · {stages.filter((stage) => completedStages.has(stage)).length} of {stages.length} stages <span>{activeStatusLabel}</span></summary><ol className="studio-stage-list">{stages.map((stage, index) => <li key={stage} className={`${completedStages.has(stage) ? "is-done" : snapshot.run.stage === stage ? "is-current" : ""}`}><span className="studio-stage-number">{String(index + 1).padStart(2, "0")}</span><span>{stageLabels[stage]}</span><span className="studio-stage-symbol">{completedStages.has(stage) ? "✓" : snapshot.run.stage === stage ? "↗" : ""}</span></li>)}</ol><p>Progress is reconstructed from saved run events.</p></details>
            {researchView === "explore" ? <div className="studio-explore-page"><div className="studio-explore-toolbar"><div><span className="studio-caps">Inspectable simulation</span><h2>{surveyPhase && surveyPhase !== "started" ? "The map begins after a human response." : "See how the conclusion formed."}</h2><p>{surveyPhase && surveyPhase !== "started" ? "The survey and first Terac response will unlock the research stages." : "Every node and connection comes from a saved research artifact."}</p></div>{(!surveyPhase || surveyPhase === "started") && <button type="button" onClick={() => setSelectedSeq(null)} className={selectedSeq === null ? "is-current" : ""}>Latest map <ArrowRight size={15} /></button>}</div>{surveyPhase && <SurveyGateCard study={snapshot.study} phase={surveyPhase} assetIds={runInputImageIds} />}{(!surveyPhase || surveyPhase === "started") && <ExploreMap graph={graph} sources={mapSources} />}{(!surveyPhase || surveyPhase === "started") && <div className="studio-timeline"><div><span className="studio-caps">Run history</span><h3>Replay completed stages</h3></div><div className="studio-timeline-scroll"><button type="button" className={selectedSeq === null ? "is-active" : ""} onClick={() => setSelectedSeq(null)}><span>NOW</span><strong>Latest</strong></button>{timelineEntries.map(({ event, replaySeq }) => <button type="button" key={event.seq} className={selectedSeq === replaySeq ? "is-active" : ""} onClick={() => setSelectedSeq(replaySeq)}><span>{String(event.seq).padStart(2, "0")}</span><strong>{stageLabels[event.stage ?? ""] ?? event.stage}</strong></button>)}</div></div>}</div>
            : <div className="studio-report-page">{(snapshot.reports?.length ?? 0) > 1 && <div className="studio-report-versions"><span className="studio-caps">Report history</span><div>{snapshot.reports!.map((report) => <button type="button" key={report.id} className={(visibleReport?.version ?? 0) === report.version ? "is-active" : ""} onClick={() => setSelectedReportVersion(report.version)}>v{report.version} · {report.kind === "human_addendum" ? "Human addendum" : "Synthetic report"}</button>)}</div></div>}{surveyPhase && <SurveyGateCard study={snapshot.study} phase={surveyPhase} assetIds={runInputImageIds} />}{surveyPhase && surveyPhase !== "started" ? null : <ReportView report={visibleReport} runId={snapshot.run.id} />}{snapshot.study && reportReady && snapshot.run.status !== "awaiting_approval" && <StudyReview studyId={snapshot.study.id} onReview={() => { announceWorkspaceUpdate(); return loadRun(snapshot.run.id); }} />}</div>}
          </>}
        </section>
      </div>
    </main>
    {sidebarOpen && <button type="button" className="studio-sidebar-backdrop" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar" />}
  </div>;
}
