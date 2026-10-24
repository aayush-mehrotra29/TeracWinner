export type ResearchMode = "light_research" | "light_simulation" | "deep_simulation";
export type WorkspaceView = "home" | "activity" | "explore" | "report";

export type Project = {
  id: string;
  title?: string | null;
  idea?: string | null;
  mode?: ResearchMode | null;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
};

export type Run = {
  id: string;
  project_id: string;
  mode: ResearchMode;
  status: "queued" | "running" | "needs_input" | "awaiting_approval" | "awaiting_humans" | "completed" | "failed" | "integration_blocked";
  stage?: string | null;
  created_at?: string;
  updated_at?: string;
  error?: unknown;
  [key: string]: unknown;
};

export type RunEvent = {
  seq: number;
  run_id: string;
  kind: string;
  stage: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
};

export type Message = {
  id: string;
  project_id: string;
  role: string;
  content: string;
  citations?: string[] | null;
  created_at: string;
  [key: string]: unknown;
};

export type Artifact = {
  id: string;
  run_id: string;
  kind: string;
  key: string;
  data: unknown;
  created_at: string;
};

export type MapNode = {
  id: string;
  kind: string;
  label: string;
  summary?: string;
  sourceIds?: string[];
  metadata?: Record<string, unknown>;
};

export type MapEdge = {
  id: string;
  source: string;
  target: string;
  kind?: string;
  label?: string;
};

export type Graph = { nodes: MapNode[]; edges: MapEdge[] };

export type ReportVersion = {
  id: string;
  run_id: string;
  version: number;
  kind: string;
  content: Record<string, unknown>;
  created_at: string;
};

export type Study = {
  id: string;
  status: string;
  quote?: ({ id: string; amountUsd: number; currency: string } & Record<string, unknown>) | null;
  materials?: Record<string, unknown> | null;
  approvalFingerprint?: string | null;
  [key: string]: unknown;
};

export type RunSnapshot = {
  run: Run;
  project?: Project;
  messages?: Message[];
  events: RunEvent[];
  artifacts: Artifact[];
  graph?: Graph;
  report: ReportVersion | null;
  reports?: ReportVersion[];
  study: Study | null;
};
