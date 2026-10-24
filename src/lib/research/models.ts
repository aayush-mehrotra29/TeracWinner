import { verifyPayment } from "../outreach/whop";
import { createHash, randomUUID } from "node:crypto";
import { IntegrationBlockedError } from "../providers/errors";
import { estimateOpenAiCost, ModelOutputError, structuredResponse, type JsonSchema, type ReasoningEffort, type ResearchModel } from "../providers/openai";
import type { ResearchStage, RunRow } from "./types";
import { ResearchStore } from "./store";

interface ModelCheckpoint<T> {
  value: T;
  responseId: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export class ResearchModels {
  constructor(private readonly store: ResearchStore, private readonly run: RunRow) {}

  async ask<T>(args: {
    stage: ResearchStage;
    schemaName: string;
    schema: JsonSchema;
    model: ResearchModel;
    effort?: ReasoningEffort;
    instructions: string;
    input: string;
    maxOutputTokens?: number;
    imageDataUrls?: string[];
    promptVersion?: string;
  }): Promise<T> {
    this.store.assertLease();
    if (this.run.input.paymentId) {
      const paid = await verifyPayment(this.run.input.paymentId);
      if (paid.mode !== this.run.mode) throw new IntegrationBlockedError("Payment does not authorize this research mode", "whop");
    }
    const maxOutputTokens = args.maxOutputTokens ?? 2400;
    const effort = args.effort ?? (args.model === "gpt-6-luna" ? "low" : "medium");
    const promptVersion = args.promptVersion ?? "2026-10-24-v1";
    const imageHashes = (args.imageDataUrls ?? []).map((image) => createHash("sha256").update(image).digest("hex"));
    const requestKey = createHash("sha256").update(JSON.stringify({
      stage: args.stage, model: args.model, effort, schemaName: args.schemaName, promptVersion,
      schema: args.schema, instructions: args.instructions, input: args.input,
      maxOutputTokens, imageHashes,
    })).digest("hex");
    const { data: prior, error: priorError } = await this.store.db.from("model_calls")
      .select("id,status").eq("run_id", this.run.id).eq("request_key", requestKey).maybeSingle();
    if (priorError) throw new Error(`Unable to inspect model-call journal: ${priorError.message}`);
    const checkpoint = await this.store.artifact<ModelCheckpoint<T>>(this.run.id, "model_output", requestKey);
    if (prior || checkpoint) {
      if (!checkpoint || !prior || !["returned", "completed"].includes(String(prior.status))) {
        throw new IntegrationBlockedError(`OpenAI request ${requestKey.slice(0, 12)} may have been charged without a saved result; manual reconciliation is required`, "openai");
      }
      if (prior.status !== "completed") {
        const { error } = await this.store.db.from("model_calls").update({ status: "completed" }).eq("id", prior.id);
        if (error) throw new Error(`Unable to finish cached model-call audit: ${error.message}`);
      }
      const spent = await this.store.reconcileSpent(this.run);
      if (Number(this.run.budget_usd) > 0 && spent > Number(this.run.budget_usd)) {
        throw new IntegrationBlockedError("Research budget exhausted after the saved model call", "budget");
      }
      this.store.assertLease();
      return checkpoint.value;
    }
    if (!process.env.OPENAI_API_KEY) throw new IntegrationBlockedError("OPENAI_API_KEY is required for live research", "openai");
    const budget = Number(this.run.budget_usd);
    const spentBefore = await this.store.reconcileSpent(this.run);
    if (!Number.isFinite(budget) || budget < 0 || !Number.isFinite(spentBefore)) {
      throw new IntegrationBlockedError("Research cost accounting is invalid", "budget");
    }
    const expectedInputTokens = Math.ceil(args.input.length / 3) + 500 + (args.imageDataUrls?.length ?? 0) * 3000;
    const reserve = estimateOpenAiCost(args.model, expectedInputTokens, maxOutputTokens) * 1.25;
    if (budget > 0 && spentBefore + reserve > budget) {
      throw new IntegrationBlockedError(`Research budget exhausted before ${args.stage}`, "budget");
    }
    const requestId = randomUUID();
    const { data: call, error: startError } = await this.store.db.from("model_calls").insert({
      run_id: this.run.id, owner_id: this.run.owner_id,
      request_key: requestKey, request_id: requestId, response_id: null,
      stage: args.stage, model: args.model, reasoning_effort: effort,
      prompt_version: promptVersion, schema_version: args.schemaName,
      input_tokens: 0, output_tokens: 0, cost_usd: 0, status: "pending", error: null,
    }).select("id").single();
    if (startError || !call) throw new Error(`Unable to journal model call before request: ${startError?.message ?? "missing"}`);
    let response;
    try {
      response = await structuredResponse<T>({
        model: args.model, effort, schemaName: args.schemaName, schema: args.schema,
        instructions: args.instructions, input: args.input, imageDataUrls: args.imageDataUrls,
        maxOutputTokens, requestId,
      });
    } catch (error) {
      const outputError = error instanceof ModelOutputError ? error : null;
      const { error: auditError } = await this.store.db.from("model_calls").update({
        status: outputError ? "failed" : "uncertain",
        response_id: outputError?.responseId ?? null,
        input_tokens: outputError?.inputTokens ?? 0,
        output_tokens: outputError?.outputTokens ?? 0,
        cost_usd: outputError?.estimatedCostUsd ?? 0,
        error: { message: error instanceof Error ? error.message.slice(0, 500) : String(error) },
      }).eq("id", call.id);
      if (auditError) throw new Error(`Unable to audit failed model call: ${auditError.message}`, { cause: error });
      await this.store.reconcileSpent(this.run);
      throw error;
    }
    const { error: returnedError } = await this.store.db.from("model_calls").update({
      status: "returned", response_id: response.responseId,
      input_tokens: response.inputTokens, output_tokens: response.outputTokens,
      cost_usd: response.estimatedCostUsd,
    }).eq("id", call.id);
    if (returnedError) throw new Error(`Unable to audit returned model output: ${returnedError.message}`);
    const spentAfter = await this.store.reconcileSpent(this.run);
    await this.store.saveArtifact(this.run, "model_output", requestKey, {
      value: response.value, responseId: response.responseId,
      inputTokens: response.inputTokens, outputTokens: response.outputTokens,
      costUsd: response.estimatedCostUsd,
    } satisfies ModelCheckpoint<T>);
    const { error: finishError } = await this.store.db.from("model_calls").update({ status: "completed" }).eq("id", call.id);
    if (finishError) throw new Error(`Unable to complete model-call audit: ${finishError.message}`);
    if (budget > 0 && spentAfter > budget) {
      throw new IntegrationBlockedError("Model call exceeded the remaining research budget; actual usage was recorded", "budget");
    }
    this.store.assertLease();
    return response.value;
  }
}
