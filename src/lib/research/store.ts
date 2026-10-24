import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { IntegrationBlockedError } from "../providers/errors";
import type { GraphArtifact, ResearchStage, RunRow, RunStatus } from "./types";

export class ResearchStore {
  readonly db: SupabaseClient;
  private leaseGuard: (() => void) | null = null;

  setLeaseGuard(guard: (() => void) | null): void { this.leaseGuard = guard; }
  assertLease(): void { this.leaseGuard?.(); }

  constructor(db?: SupabaseClient) {
    if (db) {
      this.db = db;
      return;
    }
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new IntegrationBlockedError("Worker requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY", "supabase");
    if (key.startsWith("sb_publishable_")) {
      throw new IntegrationBlockedError("Worker needs an OritApp server secret (sb_secret_...) or legacy service_role key", "supabase");
    }
    this.db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async getRun(runId: string): Promise<RunRow> {
    const { data, error } = await this.db.from("runs").select("*").eq("id", runId).single();
    if (error || !data) throw new Error(`Unable to read run ${runId}: ${error?.message ?? "missing"}`);
    return data as RunRow;
  }

  async setRun(run: RunRow, values: Partial<Pick<RunRow, "status" | "stage" | "spent_usd" | "input">> & { error?: unknown; completed_at?: string | null }): Promise<void> {
    if (values.status !== undefined || values.stage !== undefined) this.assertLease();
    const { error } = await this.db.from("runs").update(values).eq("id", run.id);
    if (error) throw new Error(`Unable to update run: ${error.message}`);
    Object.assign(run, values);
  }

  async reconcileSpent(run: RunRow): Promise<number> {
    const [models, providers] = await Promise.all([
      this.db.from("model_calls").select("cost_usd").eq("run_id", run.id),
      this.db.from("provider_calls").select("cost_usd").eq("run_id", run.id),
    ]);
    if (models.error || providers.error) throw new Error(`Unable to reconcile run costs: ${models.error?.message ?? providers.error?.message}`);
    const audited = [...(models.data ?? []), ...(providers.data ?? [])]
      .reduce((sum, row) => sum + Math.max(0, Number(row.cost_usd) || 0), 0);
    const spent = Math.max(Number(run.spent_usd) || 0, Math.round(audited * 1_000_000) / 1_000_000);
    if (Math.abs(spent - Number(run.spent_usd)) > 0.0000001) await this.setRun(run, { spent_usd: spent });
    return spent;
  }

  async artifact<T>(runId: string, kind: string, key = "main"): Promise<T | null> {
    const { data, error } = await this.db.from("run_artifacts").select("data")
      .eq("run_id", runId).eq("kind", kind).eq("key", key).maybeSingle();
    if (error) throw new Error(`Unable to read artifact ${kind}/${key}: ${error.message}`);
    return data ? data.data as T : null;
  }

  async saveArtifact(run: RunRow, kind: string, key: string, data: unknown): Promise<void> {
    const { error } = await this.db.from("run_artifacts").upsert({
      run_id: run.id, owner_id: run.owner_id, kind, key, data,
    }, { onConflict: "run_id,kind,key" });
    if (error) throw new Error(`Unable to save artifact ${kind}/${key}: ${error.message}`);
  }

  async event(run: RunRow, kind: string, stage: ResearchStage, payload: Record<string, unknown>): Promise<void> {
    const { error } = await this.db.from("run_events").insert({
      run_id: run.id, owner_id: run.owner_id, kind, stage, payload,
    });
    if (error) throw new Error(`Unable to save run event ${kind}: ${error.message}`);
  }

  async eventOnce(run: RunRow, kind: string, stage: ResearchStage, payload: Record<string, unknown>): Promise<void> {
    const { data, error } = await this.db.from("run_events").select("seq")
      .eq("run_id", run.id).eq("kind", kind).eq("stage", stage).limit(1);
    if (error) throw new Error(`Unable to inspect run events: ${error.message}`);
    if (!data?.length) await this.event(run, kind, stage, payload);
  }

  async eventOnceKey(run: RunRow, kind: string, stage: ResearchStage, eventKey: string, payload: Record<string, unknown>): Promise<void> {
    const { data, error } = await this.db.from("run_events").select("seq")
      .eq("run_id", run.id).eq("kind", kind).eq("stage", stage)
      .contains("payload", { eventKey }).limit(1);
    if (error) throw new Error(`Unable to inspect run event ${kind}/${eventKey}: ${error.message}`);
    if (!data?.length) await this.event(run, kind, stage, { ...payload, eventKey });
  }

  async stage<T>(run: RunRow, stage: ResearchStage, kind: string, work: () => Promise<T>, input?: unknown): Promise<T> {
    this.assertLease();
    const prior = await this.artifact<T>(run.id, kind);
    if (prior) {
      await this.eventOnce(run, "stage_completed", stage, { artifactKind: kind });
      return prior;
    }
    await this.setRun(run, { status: "running", stage });
    await this.eventOnce(run, "stage_started", stage, {});
    const stageInput = input ?? run.input;
    const hash = createHash("sha256").update(JSON.stringify({ stage, kind, input: stageInput })).digest("hex");
    const { data: priorAttempts, error: attemptError } = await this.db.from("stage_attempts")
      .select("attempt").eq("run_id", run.id).eq("stage", stage).order("attempt", { ascending: false }).limit(1);
    if (attemptError) throw new Error(`Unable to inspect stage attempts: ${attemptError.message}`);
    const attempt = Number(priorAttempts?.[0]?.attempt ?? 0) + 1;
    await this.saveArtifact(run, "stage_input", `${stage}:${attempt}`, stageInput);
    const { data: attemptRow, error: startError } = await this.db.from("stage_attempts").insert({
      run_id: run.id, owner_id: run.owner_id, stage, input_hash: hash,
      version: "2026-10-24-v1", attempt, status: "running",
    }).select("id").single();
    if (startError || !attemptRow) throw new Error(`Unable to start stage attempt: ${startError?.message ?? "missing"}`);
    try {
      const value = await work();
      this.assertLease();
      await this.saveArtifact(run, kind, "main", value);
      const { error: finishError } = await this.db.from("stage_attempts")
        .update({ status: "completed", finished_at: new Date().toISOString() }).eq("id", attemptRow.id);
      if (finishError) throw new Error(`Unable to finish stage attempt: ${finishError.message}`);
      await this.eventOnce(run, "stage_completed", stage, { artifactKind: kind });
      return value;
    } catch (error) {
      await this.db.from("stage_attempts").update({
        status: "failed", finished_at: new Date().toISOString(),
        error: { message: error instanceof Error ? error.message.slice(0, 1000) : String(error) },
      }).eq("id", attemptRow.id);
      throw error;
    }
  }

  async transition<T>(run: RunRow, stage: ResearchStage, operation: string, input: unknown, work: () => Promise<T>): Promise<T> {
    this.assertLease();
    const hash = createHash("sha256").update(JSON.stringify({ stage, operation, input })).digest("hex");
    const { data: priorAttempts, error: attemptError } = await this.db.from("stage_attempts")
      .select("attempt").eq("run_id", run.id).eq("stage", stage).order("attempt", { ascending: false }).limit(1);
    if (attemptError) throw new Error(`Unable to inspect ${stage} attempts: ${attemptError.message}`);
    const attempt = Number(priorAttempts?.[0]?.attempt ?? 0) + 1;
    await this.saveArtifact(run, "stage_input", `${stage}:${attempt}`, { operation, input });
    const { data: row, error: startError } = await this.db.from("stage_attempts").insert({
      run_id: run.id, owner_id: run.owner_id, stage, input_hash: hash,
      version: `2026-10-24-v1:${operation}`, attempt, status: "running",
    }).select("id").single();
    if (startError || !row) throw new Error(`Unable to start ${stage} attempt: ${startError?.message ?? "missing"}`);
    try {
      const value = await work();
      this.assertLease();
      const { error } = await this.db.from("stage_attempts").update({ status: "completed", finished_at: new Date().toISOString() }).eq("id", row.id);
      if (error) throw new Error(`Unable to complete ${stage} attempt: ${error.message}`);
      return value;
    } catch (error) {
      await this.db.from("stage_attempts").update({
        status: "failed", finished_at: new Date().toISOString(),
        error: { message: error instanceof Error ? error.message.slice(0, 1000) : String(error) },
      }).eq("id", row.id);
      throw error;
    }
  }

  async paidCall<T extends { costUsd: number | null; requestId: string | null }>(args: {
    run: RunRow;
    stage: ResearchStage;
    provider: "exa" | "solari";
    operation: string;
    key: string;
    reserveUsd: number;
    work: () => Promise<T>;
    save: (value: T) => Promise<void>;
  }): Promise<T> {
    this.assertLease();
    const { run, stage, provider, operation, key, reserveUsd } = args;
    if (Number(run.budget_usd) > 0 && Number(run.spent_usd) + reserveUsd > Number(run.budget_usd)) {
      throw new IntegrationBlockedError(`Research budget exhausted before ${provider} ${operation}`, "budget");
    }
    const { data: existing, error: checkError } = await this.db.from("provider_calls")
      .select("status").eq("run_id", run.id).eq("provider", provider)
      .eq("operation", operation).eq("request_key", key).maybeSingle();
    if (checkError) throw new Error(`Unable to inspect provider call: ${checkError.message}`);
    if (existing) throw new IntegrationBlockedError(`${provider} ${operation} request ${key} may have already been charged; manual reconciliation is required`, provider);
    const { data: call, error: startError } = await this.db.from("provider_calls").insert({
      run_id: run.id, owner_id: run.owner_id, stage, provider, operation,
      request_key: key, status: "pending", cost_usd: 0, estimated: false,
    }).select("id").single();
    if (startError || !call) throw new Error(`Unable to record provider call: ${startError?.message ?? "missing"}`);
    let returned: { costUsd: number; requestId: string | null; estimated: boolean } | null = null;
    let completed = false;
    try {
      const value = await args.work();
      const measuredCost = value.costUsd;
      const costUsd = measuredCost !== null && Number.isFinite(measuredCost) && measuredCost >= 0 ? measuredCost : reserveUsd;
      returned = { costUsd, requestId: value.requestId, estimated: costUsd !== measuredCost };
      const { error: returnError } = await this.db.from("provider_calls").update({
        status: "returned", request_id: value.requestId, cost_usd: costUsd,
        estimated: returned.estimated,
      }).eq("id", call.id);
      if (returnError) throw new Error(`Unable to audit returned provider call: ${returnError.message}`);
      const spentAfter = Number(run.spent_usd) + costUsd;
      await this.setRun(run, { spent_usd: spentAfter });
      await args.save(value);
      const { error: finishError } = await this.db.from("provider_calls").update({
        status: "completed", request_id: value.requestId, cost_usd: costUsd,
        estimated: returned.estimated,
      }).eq("id", call.id);
      if (finishError) throw new Error(`Unable to complete provider audit: ${finishError.message}`);
      completed = true;
      if (Number(run.budget_usd) > 0 && spentAfter > Number(run.budget_usd)) {
        throw new IntegrationBlockedError(`${provider} ${operation} exceeded the remaining research budget; the actual charge and result were saved`, "budget");
      }
      this.assertLease();
      return value;
    } catch (error) {
      if (!completed) {
        await this.db.from("provider_calls").update({
          status: "failed", request_id: returned?.requestId ?? null,
          cost_usd: returned?.costUsd ?? 0, estimated: returned?.estimated ?? false,
          error: { message: error instanceof Error ? error.message.slice(0, 1000) : String(error) },
        }).eq("id", call.id);
      }
      throw error;
    }
  }

  async saveGraph(run: RunRow, stage: ResearchStage, graph: GraphArtifact): Promise<void> {
    const prior = await this.artifact<GraphArtifact>(run.id, "graph", stage);
    if (!prior) {
      await this.saveArtifact(run, "graph", stage, graph);
      await this.event(run, "artifact", stage, { kind: "graph", key: stage, nodes: graph.nodes.length, edges: graph.edges.length });
    }
  }

  async finish(run: RunRow, status: RunStatus, stage: ResearchStage, error: unknown = null): Promise<void> {
    await this.setRun(run, {
      status,
      stage,
      error,
      completed_at: status === "completed" || status === "failed" || status === "integration_blocked" ? new Date().toISOString() : null,
    });
  }
}
