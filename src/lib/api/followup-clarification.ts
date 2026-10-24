import type { createAdminClient } from "@/lib/db/admin";
import { ApiError } from "./http";
import { assertMatchingFollowupRequest } from "./followup-input";

type Admin = ReturnType<typeof createAdminClient>;
type SavedMessage = {
  id: string; project_id: string; owner_id: string; run_id: string | null;
  content: string; citations: unknown;
};

export class ClarificationClaimLostError extends ApiError {
  constructor() {
    super(409, "This run is no longer waiting for that clarification.");
  }
}

export const CLARIFICATION_MESSAGE_MARKER = "clarification-request-v1";

export function isClarificationMessage(message: { citations?: unknown }): boolean {
  return Array.isArray(message.citations) && message.citations.includes(CLARIFICATION_MESSAGE_MARKER);
}

export async function saveClarificationMessage(admin: Admin, args: {
  projectId: string; ownerId: string; runId: string; requestKey: string;
  content: string; requestFingerprint: string;
}): Promise<{ message: SavedMessage; created: boolean }> {
  const { data, error } = await admin.from("messages").insert({
    project_id: args.projectId, owner_id: args.ownerId, run_id: args.runId,
    idempotency_key: args.requestKey, role: "user", content: args.content,
    citations: [args.requestFingerprint, CLARIFICATION_MESSAGE_MARKER],
  }).select("*").single();
  if (!error) return { message: data, created: true };
  if (error.code !== "23505") throw error;
  const { data: saved, error: lookupError } = await admin.from("messages").select("*")
    .eq("owner_id", args.ownerId).eq("idempotency_key", args.requestKey)
    .eq("role", "user").maybeSingle();
  if (lookupError) throw lookupError;
  if (!saved || saved.project_id !== args.projectId || saved.run_id !== args.runId ||
    saved.content !== args.content || !isClarificationMessage(saved)) {
    throw new ApiError(409, "Idempotency key belongs to another message.");
  }
  const savedFingerprint = Array.isArray(saved.citations)
    ? saved.citations.find((value: unknown) => typeof value === "string" && value.startsWith("followup-request-sha256:"))
    : undefined;
  assertMatchingFollowupRequest(savedFingerprint, args.requestFingerprint, true);
  return { message: saved, created: false };
}

function hasResumedMessage(input: Record<string, unknown>, messageId: string): boolean {
  return Array.isArray(input.resumedClarificationMessageIds) &&
    input.resumedClarificationMessageIds.includes(messageId);
}

export async function resumeClarification(admin: Admin, args: {
  projectId: string; ownerId: string; runId: string; message: SavedMessage;
}) {
  const { projectId, ownerId, runId, message } = args;
  if (message.project_id !== projectId || message.owner_id !== ownerId || message.run_id !== runId) {
    throw new ApiError(409, "Clarification belongs to another run.");
  }
  const readRun = async () => {
    const { data, error } = await admin.from("runs").select("*")
      .eq("id", runId).eq("project_id", projectId).eq("owner_id", ownerId).maybeSingle();
    if (error) throw error;
    if (!data) throw new ApiError(404, "Run not found.");
    return data;
  };
  let run = await readRun();
  let input = run.input && typeof run.input === "object" && !Array.isArray(run.input)
    ? run.input as Record<string, unknown> : {};
  const legacyAlreadyResumed = !isClarificationMessage(message) && run.status !== "needs_input" &&
    Array.isArray(input.clarifications) && input.clarifications.includes(message.content);
  if (!hasResumedMessage(input, message.id) && !legacyAlreadyResumed) {
    if (run.status !== "needs_input") {
      throw new ClarificationClaimLostError();
    }
    const { data: oldIntake, error: oldIntakeError } = await admin.from("run_artifacts")
      .select("data").eq("run_id", runId).eq("owner_id", ownerId)
      .eq("kind", "intake").eq("key", "main").maybeSingle();
    if (oldIntakeError) throw oldIntakeError;
    if (oldIntake) {
      const { error: archiveError } = await admin.from("run_artifacts").insert({
        run_id: runId, owner_id: ownerId, kind: "intake",
        key: `before-clarification-${message.id}`, data: oldIntake.data,
      });
      if (archiveError && archiveError.code !== "23505") throw archiveError;
    }
    const { error: deleteError } = await admin.from("run_artifacts").delete()
      .eq("run_id", runId).eq("owner_id", ownerId).eq("kind", "intake").eq("key", "main");
    if (deleteError) throw deleteError;
    const clarifications = Array.isArray(input.clarifications)
      ? input.clarifications.filter((value): value is string => typeof value === "string") : [];
    const resumedIds = Array.isArray(input.resumedClarificationMessageIds)
      ? input.resumedClarificationMessageIds.filter((value): value is string => typeof value === "string") : [];
    const { data: updated, error: updateError } = await admin.from("runs")
      .update({
        input: {
          ...input, clarifications: [...clarifications, message.content],
          resumedClarificationMessageIds: [...resumedIds, message.id],
        },
        status: "queued",
      })
      .eq("id", runId).eq("project_id", projectId).eq("owner_id", ownerId)
      .eq("status", "needs_input").select("*").maybeSingle();
    if (updateError) throw updateError;
    run = updated ?? await readRun();
    input = run.input && typeof run.input === "object" && !Array.isArray(run.input)
      ? run.input as Record<string, unknown> : {};
    if (!hasResumedMessage(input, message.id)) {
      throw new ClarificationClaimLostError();
    }
  }
  const { data: priorEvents, error: eventLookupError } = await admin.from("run_events")
    .select("seq,payload").eq("run_id", runId).eq("owner_id", ownerId)
    .eq("kind", "clarification_received").eq("stage", "intake");
  if (eventLookupError) throw eventLookupError;
  if (!priorEvents?.some((event) => event.payload?.messageId === message.id)) {
    const { error: eventError } = await admin.from("run_events").insert({
      run_id: runId, owner_id: ownerId, kind: "clarification_received", stage: "intake",
      payload: { messageId: message.id },
    });
    if (eventError) throw eventError;
  }
  return run;
}

export async function resumeNewClarification(admin: Admin, args: {
  projectId: string; ownerId: string; runId: string; message: SavedMessage; created: boolean;
}) {
  try {
    return await resumeClarification(admin, args);
  } catch (error) {
    if (args.created && error instanceof ClarificationClaimLostError) {
      const { data: run, error: readError } = await admin.from("runs").select("input")
        .eq("id", args.runId).eq("project_id", args.projectId)
        .eq("owner_id", args.ownerId).maybeSingle();
      if (readError) throw readError;
      const input = run?.input && typeof run.input === "object" && !Array.isArray(run.input)
        ? run.input as Record<string, unknown> : {};
      if (!hasResumedMessage(input, args.message.id)) {
        const { error: deleteError } = await admin.from("messages").delete()
          .eq("id", args.message.id).eq("project_id", args.projectId)
          .eq("owner_id", args.ownerId).eq("run_id", args.runId)
          .eq("role", "user");
        if (deleteError) throw deleteError;
      }
    }
    throw error;
  }
}
