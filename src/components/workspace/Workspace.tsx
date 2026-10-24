"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Activity, ArrowRight, ChevronLeft, FileText, House, Inbox, Mail, Menu, Network, RotateCw, X } from "lucide-react";
import { DEEP_PARTICIPANT_TARGET } from "@/lib/research/deep-config";
import ExploreMap from "./ExploreMap";
import ResearchProgress from "./ResearchProgress";
import ReportView, { asReportContent } from "./ReportView";
import StudyReview from "./StudyReview";
import type { Graph, Project, ResearchMode, RunEvent, RunSnapshot, Study, WorkspaceView } from "./types";

type ProjectRun = { id: string; version: number; status?: string; mode?: ResearchMode; created_at?: string };
type InboxEmail = {
  id: string;
  receivedAt: string;
  from: string;
  subject: string;
  preview: string;
  direction: string;
  classification: string;
  orderReference: string | null;
  runId: string | null;
  status: string;
};
type InboxFilter = "all" | "incoming" | "outgoing" | "needs_review";
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
  report: "Publish the report", terac_opportunity: "Prepare Terac opportunity", terac_feasibility: "Quote human study", terac_fieldwork: "Terac opportunity live", human_addendum: "Compare human feedback",
};

const modeLabels: Record<ResearchMode, string> = {
  light_research: "Light research", light_simulation: "Light simulation", deep_simulation: "Deep simulation",
};

const statusLabels: Record<string, string> = {
  queued: "Queued", running: "In progress", needs_input: "Needs your input", awaiting_approval: "Opportunity confirmation needed",
  awaiting_humans: "Awaiting participant submission", completed: "Completed", failed: "Run failed", integration_blocked: "Integration blocked",
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
  const title = (project?.title?.trim() || project?.idea?.trim() || "Untitled analysis")
    .replace(/^#{1,6}\s+/, "").replaceAll("**", "").replace(/\s+/g, " ").trim();
  if (title.length <= 52) return title;
  const prefix = title.slice(0, 52);
  const wordEnd = prefix.lastIndexOf(" ");
  return `${prefix.slice(0, wordEnd > 30 ? wordEnd : 52).trimEnd()}…`;
}

function displayIdea(value: string | null | undefined): string {
  return (value || "Idea saved with this project.")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "").replaceAll("**", "").trim();
}

function runError(error: unknown): string | null {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return null;
}

function humanize(value: string): string {
  return value.replaceAll(/[_-]+/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}

function inboxDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "Date unavailable";
}

function isIncoming(email: InboxEmail): boolean {
  return ["incoming", "inbound", "received"].includes(email.direction.toLowerCase());
}

function needsReview(email: InboxEmail): boolean {
  return /needs|review|blocked|failed|unmatched/i.test(email.status);
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

function teracDraftEditorUrl(study: Study): string | null {
  const value = study.materials?.draftEditorUrl;
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && (url.hostname === "terac.com" || url.hostname.endsWith(".terac.com"))) return url.href;
  } catch { /* An invalid provider URL is not shown as a link. */ }
  return null;
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
    case "terac_draft_created": return "A Terac opportunity draft is ready for price and materials review";
    case "terac_quote": return event.payload?.status === "pending" ? "Terac feasibility quote requested" : "A Terac study quote is ready for approval";
    case "terac_approved": return "The live Terac opportunity and survey materials were confirmed";
    case "tally_form_created": return "A product-specific Tally survey was created";
    case "terac_launched": return "Orit began monitoring the launched Terac opportunity";
    case "first_human_response": return "First completed submission matched to Terac. Agent simulation can begin";
    case "addendum_ready": return "A human feedback addendum is ready";
    default: return event.kind.replaceAll("_", " ");
  }
}

type SurveyPhase = "preparing" | "approval" | "waiting" | "started";

function SurveyGateCard({ study, phase, assetIds }: { study: Study | null; phase: SurveyPhase; assetIds: string[] }) {
  const url = tallyFormUrl(study);
  const materials = study?.materials && typeof study.materials === "object" ? study.materials : null;
  const title = phase === "preparing" ? url ? "Survey ready, Terac opportunity in progress" : "Preparing the opportunity" : phase === "approval" ? "Opportunity confirmation needed" : phase === "waiting" ? "Waiting for the first submission" : "First submission received";
  const detail = phase === "preparing"
    ? url ? `The Tally survey is created. Orit is preparing a ${DEEP_PARTICIPANT_TARGET}-person Terac opportunity and its price for your review. Agent research has not started.` : "Orit is preparing a Tally survey from your product description and images, then creating a Terac opportunity. Agent research has not started."
    : phase === "approval" ? "Review the current Terac total and survey materials, then approve the opportunity in Chat."
      : phase === "waiting" ? "The Tally form is live through Terac. Agent research begins after one completed submission is matched to this opportunity."
        : "The first Terac submission has arrived. Orit is now running research and synthetic buyer simulation.";
  return <section className="studio-survey-gate" aria-label="Deep simulation study status">
    <div className="studio-survey-gate-heading"><span className="studio-caps">Human-first deep simulation · {DEEP_PARTICIPANT_TARGET}-person cap</span><span className={`studio-survey-gate-signal is-${phase}`}><span />{phase === "preparing" ? "Setting up" : phase === "approval" ? "Your approval" : phase === "waiting" ? "Awaiting submission" : "Research running"}</span></div>
    <h3>{title}</h3><p>{detail}</p>
    {url && <a className="studio-survey-gate-link" href={url} target="_blank" rel="noopener noreferrer">Open Tally survey <ArrowRight size={16} /></a>}
    {phase === "waiting" && !url && <p className="studio-survey-gate-note">The opportunity is waiting for a submission. Its Tally link will appear here when the saved form is available.</p>}
    <ol className="studio-survey-gate-steps" aria-label="Deep simulation sequence"><li className={url ? "is-done" : "is-current"}>Create survey</li><li className={phase === "preparing" || phase === "approval" ? "is-current" : "is-done"}>Review and launch opportunity</li><li className={phase === "waiting" ? "is-current" : phase === "started" ? "is-done" : ""}>First submission</li><li className={phase === "started" ? "is-current" : ""}>Agent simulation</li></ol>
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

function OpportunityApprovalPanel({ study, assetIds, busy, refreshing, onApprove, onRefresh }: { study: Study; assetIds: string[]; busy: boolean; refreshing: boolean; onApprove: (quoteId: string, amountUsd: number, fingerprint: string) => Promise<void>; onRefresh: () => Promise<void> }) {
  const [shareApproved, setShareApproved] = useState(false);
  const quote = study.quote && typeof study.quote === "object" ? study.quote : null;
  const materials = study.materials && typeof study.materials === "object" ? study.materials : null;
  const isOpportunity = study.target_count === DEEP_PARTICIPANT_TARGET || Boolean(teracDraftEditorUrl(study));
  const editorUrl = teracDraftEditorUrl(study);
  const targetCount = typeof study.target_count === "number" ? study.target_count : DEEP_PARTICIPANT_TARGET;
  const ready = Boolean(quote?.id && typeof quote?.amountUsd === "number" && Number.isFinite(quote.amountUsd) && quote.amountUsd > 0 && study.approvalFingerprint && materials);
  const displayedTotal = typeof quote?.amountUsd === "number" && Number.isFinite(quote.amountUsd) ? `$${quote.amountUsd.toFixed(2)}` : "Pending";
  return <div className="studio-study-card"><div className="studio-study-card-top"><span className="studio-caps">Human-first deep study</span><strong>Up to {targetCount} qualified US participants</strong></div>
    <p>{isOpportunity ? "Review Terac's current all-in price and the survey materials. Approve the five-person opportunity before it launches; agent research starts after the first completed submission is matched to it." : "Review the existing Terac quote and Tally survey before approving a paid launch."}</p>
    {isOpportunity && editorUrl && <p><a href={editorUrl} target="_blank" rel="noopener noreferrer">Open Terac opportunity ↗</a></p>}
    {quote && <div className="studio-study-amount"><span>{isOpportunity ? "Current Terac opportunity total" : "Confirmed study quote"} · {quote.currency || "USD"}</span><strong>{displayedTotal}</strong></div>}
    {isOpportunity && <button type="button" className="studio-study-refresh" onClick={() => { setShareApproved(false); void onRefresh(); }} disabled={busy || refreshing}><RotateCw size={15} className={refreshing ? "studio-spin" : undefined} />{refreshing ? "Refreshing Terac price…" : "Refresh Terac price"}</button>}
    {materials && <StudyMaterialsView materials={materials} assetIds={assetIds} />}
    {quote && <details><summary>{isOpportunity ? "View draft price details" : "View quote details"}</summary><pre>{JSON.stringify(redactedMaterial(quote, typeof materials?.taskUrl === "string" ? materials.taskUrl : undefined), null, 2)}</pre></details>}
    <label className="studio-share-approval"><input type="checkbox" checked={shareApproved} onChange={(event) => setShareApproved(event.target.checked)} /><span>I approve the current Terac total and sharing the materials shown above with participants.</span></label>
    <button type="button" className="studio-study-approve" onClick={() => quote && study.approvalFingerprint && onApprove(quote.id, quote.amountUsd, study.approvalFingerprint)} disabled={busy || refreshing || !ready || !shareApproved}>{busy ? "Approving…" : isOpportunity ? `Approve ${displayedTotal} total and launch` : "Approve and launch paid study"}<ArrowRight size={16} /></button></div>;
}

function HomeDashboard({ emails, loading, refreshing, error, onRefresh, onOpenAnalysis }: {
  emails: InboxEmail[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
  onOpenAnalysis: (runId: string) => Promise<void>;
}) {
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const incomingCount = emails.filter(isIncoming).length;
  const analysisCount = emails.filter((email) => Boolean(email.runId)).length;
  const reviewCount = emails.filter(needsReview).length;
  const selected = emails.find((email) => email.id === selectedId);
  const visible = emails.filter((email) => filter === "all" ||
    (filter === "incoming" && isIncoming(email)) ||
    (filter === "outgoing" && !isIncoming(email)) ||
    (filter === "needs_review" && needsReview(email)));
  const filters: Array<{ id: InboxFilter; label: string; count: number }> = [
    { id: "all", label: "All email", count: emails.length },
    { id: "incoming", label: "Incoming", count: incomingCount },
    { id: "outgoing", label: "Outreach", count: emails.length - incomingCount },
    { id: "needs_review", label: "Needs review", count: reviewCount },
  ];

  return <div className="studio-home-page">
    <header className="studio-home-header">
      <div><span className="studio-caps">ORIT / HOME</span><h1>Every email, one place.</h1><p>Incoming product ideas and outreach history flow into the same research workspace. A matched submission starts a saved analysis automatically.</p></div>
      <button type="button" className="studio-home-refresh" onClick={() => void onRefresh()} disabled={refreshing} aria-label="Refresh email list"><RotateCw size={16} className={refreshing ? "studio-spin" : undefined} />{refreshing ? "Refreshing" : "Refresh"}</button>
    </header>
    <div className="studio-home-stat-row" aria-label="Email overview">
      <div className="studio-home-stat"><span>Collected email</span><strong>{emails.length}</strong><small>Inbound and outreach</small></div>
      <div className="studio-home-stat"><span>Incoming</span><strong>{incomingCount}</strong><small>Replies and submissions</small></div>
      <div className="studio-home-stat"><span>Analyses started</span><strong>{analysisCount}</strong><small>Linked to saved runs</small></div>
    </div>
    <section className="studio-home-inbox" aria-label="Collected email">
      <div className="studio-home-toolbar"><div><span className="studio-caps">INBOX</span><h2>Collected email</h2></div><span>{emails.length} saved</span></div>
      <div className="studio-home-filters" aria-label="Filter email">{filters.map((option) => <button key={option.id} type="button" className={filter === option.id ? "is-active" : ""} aria-pressed={filter === option.id} onClick={() => setFilter(option.id)}>{option.label}<span>{option.count}</span></button>)}</div>
      {error && <div className="studio-home-error" role="alert">Email could not be loaded: {error} <button type="button" onClick={() => void onRefresh()}>Try again</button></div>}
      {loading && <div className="studio-home-empty" role="status"><RotateCw size={18} className="studio-spin" /><p>Loading saved email…</p></div>}
      {!loading && !error && visible.length === 0 && <div className="studio-home-empty"><Inbox size={25} /><h3>{emails.length ? "No email in this view" : "Waiting for the first email"}</h3><p>{emails.length ? "Choose another filter to see the collected messages." : "Incoming submissions and outreach messages will appear here as they are collected."}</p></div>}
      {!loading && visible.length > 0 && <div className="studio-home-table-wrap"><table className="studio-home-table"><caption className="sr-only">Collected inbound and outreach email</caption><thead><tr><th scope="col">Received</th><th scope="col">From</th><th scope="col">Email</th><th scope="col">Order</th><th scope="col">Status</th><th scope="col">Analysis</th></tr></thead><tbody>{visible.map((email) => <tr key={email.id} className={selectedId === email.id ? "is-selected" : ""}>
        <td data-label="Received"><time dateTime={email.receivedAt}>{inboxDate(email.receivedAt)}</time></td>
        <td data-label="From"><span className="studio-home-from">{email.from || "Unknown sender"}</span><span className="studio-home-direction">{isIncoming(email) ? "Incoming" : "Outreach"}</span></td>
        <td data-label="Email"><button type="button" className="studio-home-subject" onClick={() => setSelectedId(selectedId === email.id ? null : email.id)} aria-expanded={selectedId === email.id}>{email.subject || "(No subject)"}</button><span className="studio-home-preview">{email.preview || humanize(email.classification || "Email saved")}</span></td>
        <td data-label="Order">{email.orderReference ? <span className="studio-home-order">{email.orderReference}<small>Unverified</small></span> : <span className="studio-home-muted">—</span>}</td>
        <td data-label="Status"><span className={`studio-home-status ${needsReview(email) ? "is-review" : email.runId ? "is-running" : ""}`}>{humanize(email.status || email.classification || "Saved")}</span></td>
        <td data-label="Analysis">{email.runId ? <button type="button" className="studio-home-analysis-link" onClick={() => void onOpenAnalysis(email.runId!)}>Open analysis <ArrowRight size={14} /></button> : <span className="studio-home-muted">{email.status === "pending" || email.status === "processing" ? "Checking email" : "—"}</span>}</td>
      </tr>)}</tbody></table></div>}
      {selected && <div className="studio-home-detail" aria-label="Selected email details"><div className="studio-home-detail-head"><div><span className="studio-caps">EMAIL DETAILS</span><h3>{selected.subject || "(No subject)"}</h3></div><button type="button" onClick={() => setSelectedId(null)} aria-label="Close email details"><X size={17} /></button></div><div className="studio-home-detail-grid"><div><span>From</span><strong>{selected.from || "Unknown sender"}</strong></div><div><span>Received</span><strong>{inboxDate(selected.receivedAt)}</strong></div><div><span>Classification</span><strong>{humanize(selected.classification || "Unclassified")}</strong></div><div><span>Order reference</span><strong>{selected.orderReference || "None saved"}</strong></div></div><p>{selected.preview || "No email preview was saved."}</p>{selected.runId && <button type="button" className="studio-home-analysis-link" onClick={() => void onOpenAnalysis(selected.runId!)}>Open linked analysis <ArrowRight size={15} /></button>}</div>}
    </section>
  </div>;
}

export default function Workspace() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [emails, setEmails] = useState<InboxEmail[]>([]);
  const [inboxLoading, setInboxLoading] = useState(true);
  const [inboxRefreshing, setInboxRefreshing] = useState(false);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [projectRuns, setProjectRuns] = useState<ProjectRun[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [view, setView] = useState<WorkspaceView>("home");
  const [researchView, setResearchView] = useState<"explore" | "report">("explore");
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [selectedReportVersion, setSelectedReportVersion] = useState<number | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [approving, setApproving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const lastSeqRef = useRef(0);
  const runIdRef = useRef<string | null>(null);
  const activeProjectIdRef = useRef<string | null>(null);
  const latestRunIdRef = useRef<string | null>(null);
  const refreshSequenceRef = useRef(0);
  const projectSelectionRef = useRef(0);

  function showView(next: WorkspaceView) {
    if (next === "home") { goHome(); return; }
    setView(next);
    if (next === "explore" || next === "report") setResearchView(next);
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

  const refreshInbox = useCallback(async () => {
    try {
      const result = await api<{ emails: InboxEmail[] }>("/api/inbox");
      setEmails(Array.isArray(result.emails) ? result.emails : []);
      setInboxError(null);
    } catch (cause) {
      setInboxError(cause instanceof Error ? cause.message : "Could not load collected email.");
    } finally {
      setInboxLoading(false);
    }
  }, []);

  async function manualInboxRefresh() {
    setInboxRefreshing(true);
    try { await refreshInbox(); } finally { setInboxRefreshing(false); }
  }

  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") void refreshInbox(); };
    const onStorage = (event: StorageEvent) => { if (event.key === WORKSPACE_UPDATE_KEY) refresh(); };
    const initial = window.setTimeout(refresh, 0);
    const timer = window.setInterval(refresh, 12_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("storage", onStorage);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, [refreshInbox]);

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
    }, 2000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [activeRunId, loadRun]);

  async function openProject(project: Project) {
    const selection = ++projectSelectionRef.current;
    runIdRef.current = null;
    setSidebarOpen(false);
    setError(null);
    setSelectedSeq(null);
    setSelectedReportVersion(null);
    setView("activity");
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

  function goHome() {
    projectSelectionRef.current += 1;
    runIdRef.current = null;
    setActiveProjectId(null);
    setProjectRuns([]);
    setActiveRunId(null);
    setSnapshot(null);
    setSelectedSeq(null);
    setSelectedReportVersion(null);
    setView("home");
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
    setError(null);
    setView("activity");
    setResearchView("explore");
  }

  async function openInboxAnalysis(runId: string) {
    setError(null);
    try {
      const linked = await api<RunSnapshot>(`/api/runs/${runId}`);
      const project = linked.project ?? projects.find((item) => item.id === linked.run.project_id);
      if (!project) throw new Error("The linked analysis project is unavailable.");
      await openProject(project);
      runIdRef.current = runId;
      setActiveRunId(runId);
      setSnapshot(linked);
      setView("activity");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open the linked analysis.");
    }
  }

  async function approveStudy(studyId: string, quoteId: string, amountUsd: number, approvalFingerprint: string) {
    setApproving(true);
    setError(null);
    try {
      await api(`/api/studies/${studyId}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approve: true, shareApproved: true, quoteId, amountUsd, approvalFingerprint }) });
      announceWorkspaceUpdate();
      if (activeRunId) await loadRun(activeRunId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not confirm the Terac opportunity.");
    } finally { setApproving(false); }
  }

  async function refreshStudyPrice(studyId: string) {
    setRefreshing(true);
    setError(null);
    try {
      await api(`/api/studies/${studyId}/refresh`, { method: "POST" });
      if (activeRunId) await loadRun(activeRunId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not refresh the Terac price.");
    } finally { setRefreshing(false); }
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
      ? snapshot.study?.status === "feasibility_pending" ? "Terac quote pending" : "Preparing Terac opportunity"
      : surveyPhase === "waiting" ? "Waiting for first submission" : statusLabels.awaiting_humans
    : statusLabels[snapshot?.run.status ?? "queued"];
  const studySetupStage = activeEvents.some((event) => event.stage === "terac_feasibility") &&
    !activeEvents.some((event) => event.stage === "terac_opportunity") ? "terac_feasibility" : "terac_opportunity";
  const humanFirstDeep = isDeep && (!reportReady || Boolean(tallyFormUrl(snapshot?.study ?? null)) || firstHumanResponse);
  const simulationStages = ["intake", "evidence", "world", "contexts", "evaluations", "sensitivities", "discussion", "synthesis", "review", "report"];
  const stages = snapshot?.run.mode === "light_research"
    ? ["intake", "evidence", "world", "synthesis", "review", "report"]
    : humanFirstDeep
      ? [studySetupStage, "terac_fieldwork", ...simulationStages, "human_addendum"]
      : [...simulationStages, ...(snapshot?.study ? [studySetupStage, "terac_fieldwork", "human_addendum"] : [])];
  const completedStages = new Set(activeEvents.filter((event) => event.kind === "stage_completed")
    .map((event) => event.stage).filter((stage): stage is string => Boolean(stage)));
  if (firstHumanResponse) completedStages.add("terac_fieldwork");
  if (isDeep && (snapshot?.run.stage === "terac_fieldwork" || activeEvents.some((event) => event.stage === "terac_fieldwork"))) completedStages.add(studySetupStage);
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
        <button className="studio-brand" type="button" onClick={goHome} aria-label="Orit home">orit<b>.</b></button>
        <button className="studio-mobile-close" type="button" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar"><X size={18} /></button>
      </div>
      <nav className="studio-view-tabs" aria-label="Workspace views">
        <button type="button" className={view === "home" ? "is-active" : ""} onClick={() => showView("home")}><House size={17} /> Home</button>
        <button type="button" className={view === "activity" ? "is-active" : ""} onClick={() => showView("activity")} disabled={!activeProjectId}><Activity size={17} /> Activity</button>
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
        <span className="studio-topbar-label">Orit / {activeProjectId ? projectTitle(activeProject) : "Home"}</span>
        <div className="studio-topbar-right"><span className="studio-topbar-live"><span /> Email-led research</span></div>
      </header>
      {error && <div className="studio-global-error" role="alert"><strong>Action needed</strong><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="Dismiss error"><X size={16} /></button></div>}
      {activeProjectId && <nav className="studio-mobile-view-tabs" aria-label="Workspace views">
        <button type="button" className={view === "activity" ? "is-active" : ""} onClick={() => showView("activity")}><Activity size={16} /> Activity</button>
        <button type="button" className={view === "explore" ? "is-active" : ""} onClick={() => showView("explore")}><Network size={16} /> Explore</button>
        <button type="button" className={view === "report" ? "is-active" : ""} onClick={() => showView("report")}><FileText size={16} /> Report</button>
      </nav>}
      <div className="studio-workspace-body" data-home={!activeProjectId ? "true" : undefined} data-mobile-view={view}>
        <section className="studio-conversation-pane" aria-label={activeProjectId ? "Analysis activity" : "Email home"}>
          {!activeProjectId ? <HomeDashboard emails={emails} loading={inboxLoading} refreshing={inboxRefreshing} error={inboxError} onRefresh={manualInboxRefresh} onOpenAnalysis={openInboxAnalysis} /> : <div className="studio-run-page">
            <div className="studio-run-header">
              <div className="studio-run-breadcrumb"><button type="button" onClick={goHome}><ChevronLeft size={15} /> Home</button><span>/</span><span>{modeLabels[snapshot?.run.mode ?? activeProject?.mode ?? "light_research"]}</span></div>
              <div className="studio-run-title-row"><div><span className="studio-caps">Project analysis</span><h1>{projectTitle(activeProject)}</h1></div><span className={`studio-status is-${snapshot?.run.status ?? "queued"}`}><span />{activeStatusLabel}</span></div>
            </div>
            {projectRuns.length > 1 && <div className="studio-run-history"><label htmlFor="studio-run-version">Research run</label><select id="studio-run-version" value={activeRunId ?? ""} onChange={(event) => openRun(event.target.value)}>{projectRuns.map((run) => <option key={run.id} value={run.id}>Run v{run.version} · {run.id === activeRunId && snapshot ? activeStatusLabel : statusLabels[run.status ?? ""] ?? run.status ?? "Saved"}{run.id === projectRuns[0].id ? " · Latest" : ""}</option>)}</select>{viewingOlderRun && <button type="button" onClick={() => openRun(projectRuns[0].id)}>Latest <ArrowRight size={14} /></button>}</div>}
            {activeRunId && !snapshot ? <div className="studio-run-loading" role="status"><RotateCw size={20} className="studio-spin" /> Loading saved analysis…</div> : !snapshot ? <div className="studio-run-loading">No run found for this project.</div> : <>
              {pollError && <div className="studio-poll-warning" role="status">Updates paused: {pollError}. Retrying automatically.</div>}
              <div className="studio-chat-layout"><div className="studio-chat-main"><div className="studio-conversation">
                <div className="studio-activity-intro"><span className="studio-caps">ACTIVITY / SAVED RUN</span><h2>How the research is progressing</h2><p>{snapshot.run.status === "integration_blocked" ? "The analysis needs a configured provider before it can continue." : reportReady ? "The report is ready. Open a saved stage to inspect the evidence behind it." : surveyPhase === "waiting" ? "The Tally survey is live. Agent research begins after the first matched Terac submission." : snapshot.run.status === "queued" ? "Research is queued. Each step appears here after it is saved." : "Each step below comes from a committed research event."}</p></div>
                {snapshot.run.status === "integration_blocked" && <div className="studio-state-banner is-blocked"><strong>Integration blocked</strong><p>{runError(snapshot.run.error) || activeEvents.findLast((event) => event.kind === "integration_blocked")?.payload?.message?.toString() || "A required provider credential or budget is unavailable. Configure it and start a new analysis."}</p></div>}
                {snapshot.run.status === "failed" && <div className="studio-state-banner is-failed"><strong>Run failed</strong><p>{runError(snapshot.run.error) || "The worker stopped before completing this run."}</p></div>}
                {snapshot.run.status === "needs_input" && <div className="studio-state-banner is-input"><strong>More detail needed</strong>{clarificationQuestions.length > 0 ? <ul>{clarificationQuestions.map((question, index) => <li key={`${index}-${question}`}>{question}</li>)}</ul> : <p>{clarification?.payload?.message?.toString() || "Add the missing detail to continue."}</p>}</div>}
                <ResearchProgress key={`${snapshot.run.id}-${snapshot.run.status === "completed" ? "done" : "live"}`} run={snapshot.run} stages={stages} completedStages={completedStages} events={activeEvents} labels={stageLabels} describeEvent={eventText} onInspect={(sequence) => { setSelectedSeq(sequence); showView("explore"); }} />
                <div className="studio-activity-rail" aria-label="Saved analysis activity">
                  <div className="studio-activity-entry is-complete"><span className="studio-activity-marker" /><div className="studio-activity-card"><div className="studio-activity-card-top"><strong><Mail size={14} /> Product idea received</strong><small>{snapshot.run.created_at ? inboxDate(snapshot.run.created_at) : "Saved"}</small></div><p>{displayIdea(activeProject?.idea)}</p>{(runInputUrls.length > 0 || runInputImageIds.length > 0) && <div className="studio-activity-actions">{runInputUrls.map((url) => <a href={url} target="_blank" rel="noopener noreferrer" key={url}>Source: {new URL(url).hostname}</a>)}{runInputImageIds.map((id, index) => <a href={`/api/assets/${id}`} target="_blank" rel="noopener noreferrer" key={id}>Image {index + 1}</a>)}</div>}</div></div>
                  {activeEvents.map((event) => <div className={`studio-activity-entry ${event.kind === "stage_completed" ? "is-complete" : ""}`} key={event.seq}><span className="studio-activity-marker" /><button type="button" className="studio-activity-card" onClick={() => { setSelectedSeq(event.seq); showView("explore"); }}><span className="studio-activity-card-top"><strong>{event.stage ? stageLabels[event.stage] ?? humanize(event.stage) : "Research update"}</strong><small>{new Date(event.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</small></span><p>{eventText(event)}</p><span className="studio-activity-source">Open saved evidence <ArrowRight size={13} /></span></button></div>)}
                </div>
                {snapshot.run.status === "awaiting_approval" && snapshot.study && <OpportunityApprovalPanel key={snapshot.study.approvalFingerprint ?? snapshot.study.id} study={snapshot.study} assetIds={Array.isArray((snapshot.run.input as { assetIds?: unknown } | undefined)?.assetIds) ? (snapshot.run.input as { assetIds: string[] }).assetIds : []} busy={approving} refreshing={refreshing} onApprove={(quoteId, amountUsd, fingerprint) => approveStudy(snapshot.study!.id, quoteId, amountUsd, fingerprint)} onRefresh={() => refreshStudyPrice(snapshot.study!.id)} />}
                {surveyPhase && surveyPhase !== "approval" && <SurveyGateCard study={snapshot.study} phase={surveyPhase} assetIds={runInputImageIds} />}
                {snapshot.run.status === "awaiting_humans" && reportReady && <div className="studio-state-banner is-waiting"><strong>Human feedback is in progress</strong><p>Your report is available now. A human-feedback addendum will appear after the remaining responses are reviewed.</p></div>}
                {snapshot.run.mode === "deep_simulation" && reportContent?.metadata.humanStatus === "unavailable" && <div className="studio-state-banner is-waiting"><strong>Synthetic report complete</strong><p>Human feedback is unavailable in this local version. The Report tab shows the saved evidence and synthetic buyer results.</p></div>}
                {reportReady && <button type="button" className="studio-report-teaser" onClick={() => showView("report")}><span><span className="studio-caps">Report v{snapshot.report?.version}</span><strong>{reportContent?.title}</strong><small>{reportContent?.verdictReason}</small></span><ArrowRight size={20} /></button>}
              </div></div></div>
            </>}
          </div>}
        </section>

        <section className="studio-research-pane" data-research-view={researchView} aria-label="Research artifacts">
          <div className="studio-research-header"><div><span className="studio-caps">RESEARCH</span><h2>{activeProjectId ? projectTitle(activeProject) : "Workspace"}</h2></div>
            {activeProjectId && <nav className="studio-research-tabs" aria-label="Research views"><button type="button" className={researchView === "explore" ? "is-active" : ""} onClick={() => showView("explore")}><Network size={15} /> Explore</button><button type="button" className={researchView === "report" ? "is-active" : ""} onClick={() => showView("report")}><FileText size={15} /> Report</button></nav>}
          </div>
          {!activeProjectId ? <div className="studio-empty-research"><Network size={24} /><h2>Research appears here.</h2><p>When a product email starts an analysis, its saved evidence map, stages, and report appear beside the activity timeline.</p></div>
          : activeRunId && !snapshot ? <div className="studio-run-loading" role="status"><RotateCw size={20} className="studio-spin" /> Loading research artifacts…</div>
          : !snapshot ? <div className="studio-run-loading">No research run found.</div>
          : <>
            <details className="studio-research-progress"><summary>Run progress · {stages.filter((stage) => completedStages.has(stage)).length} of {stages.length} stages <span>{activeStatusLabel}</span></summary><ol className="studio-stage-list">{stages.map((stage, index) => <li key={stage} className={`${completedStages.has(stage) ? "is-done" : snapshot.run.stage === stage ? "is-current" : ""}`}><span className="studio-stage-number">{String(index + 1).padStart(2, "0")}</span><span>{stageLabels[stage]}</span><span className="studio-stage-symbol">{completedStages.has(stage) ? "✓" : snapshot.run.stage === stage ? "↗" : ""}</span></li>)}</ol><p>Progress is reconstructed from saved run events.</p></details>
            {researchView === "explore" ? <div className="studio-explore-page"><div className="studio-explore-toolbar"><div><span className="studio-caps">Inspectable simulation</span><h2>{surveyPhase && surveyPhase !== "started" ? "The map begins after a matched submission." : "See how buyers reached a decision."}</h2><p>{surveyPhase && surveyPhase !== "started" ? "The survey and first matched Terac submission will unlock the research stages." : "Explore saved synthetic evaluations and the evidence behind them."}</p></div>{(!surveyPhase || surveyPhase === "started") && <button type="button" onClick={() => setSelectedSeq(null)} className={selectedSeq === null ? "is-current" : ""}>Latest snapshot <ArrowRight size={15} /></button>}</div>{surveyPhase && <SurveyGateCard study={snapshot.study} phase={surveyPhase} assetIds={runInputImageIds} />}{(!surveyPhase || surveyPhase === "started") && <ExploreMap graph={graph} sources={mapSources} />}{(!surveyPhase || surveyPhase === "started") && <div className="studio-timeline"><div><span className="studio-caps">Run history</span><h3>Replay completed stages</h3></div><div className="studio-timeline-scroll"><button type="button" className={selectedSeq === null ? "is-active" : ""} onClick={() => setSelectedSeq(null)}><span>NOW</span><strong>Latest</strong></button>{timelineEntries.map(({ event, replaySeq }) => <button type="button" key={event.seq} className={selectedSeq === replaySeq ? "is-active" : ""} onClick={() => setSelectedSeq(replaySeq)}><span>{String(event.seq).padStart(2, "0")}</span><strong>{stageLabels[event.stage ?? ""] ?? event.stage}</strong></button>)}</div></div>}</div>
            : <div className="studio-report-page">{(snapshot.reports?.length ?? 0) > 1 && <div className="studio-report-versions"><span className="studio-caps">Report history</span><div>{snapshot.reports!.map((report) => <button type="button" key={report.id} className={(visibleReport?.version ?? 0) === report.version ? "is-active" : ""} onClick={() => setSelectedReportVersion(report.version)}>v{report.version} · {report.kind === "human_addendum" ? "Human addendum" : "Synthetic report"}</button>)}</div></div>}{surveyPhase && <SurveyGateCard study={snapshot.study} phase={surveyPhase} assetIds={runInputImageIds} />}{surveyPhase && surveyPhase !== "started" ? null : <ReportView report={visibleReport} runId={snapshot.run.id} />}{snapshot.study && reportReady && snapshot.run.status !== "awaiting_approval" && <StudyReview studyId={snapshot.study.id} onReview={() => { announceWorkspaceUpdate(); return loadRun(snapshot.run.id); }} />}</div>}
          </>}
        </section>
      </div>
    </main>
    {sidebarOpen && <button type="button" className="studio-sidebar-backdrop" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar" />}
  </div>;
}
