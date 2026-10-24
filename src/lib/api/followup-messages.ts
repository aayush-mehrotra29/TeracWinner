import type { createAdminClient } from "@/lib/db/admin";
import { ApiError } from "./http";
import { assertMatchingFollowupRequest } from "./followup-input";

type Admin = ReturnType<typeof createAdminClient>;

export async function saveFollowupMessages(admin: Admin, args: {
  projectId: string;
  ownerId: string;
  runId: string;
  requestKey: string;
  content: string;
  requestFingerprint: string;
  answer: string;
  answerCitations: string[];
  reportVersion?: number | null;
}) {
  const insertOrRead = async (record: {
    project_id: string; owner_id: string; run_id: string; idempotency_key: string;
    role: "user" | "assistant"; content: string; citations: string[]; report_version?: number | null;
  }) => {
    const { data, error } = await admin.from("messages").insert(record).select("*").single();
    if (!error) return data;
    if (error.code !== "23505") throw error;
    const { data: saved, error: lookupError } = await admin.from("messages").select("*")
      .eq("owner_id", args.ownerId).eq("idempotency_key", args.requestKey)
      .eq("role", record.role).maybeSingle();
    if (lookupError) throw lookupError;
    if (!saved || saved.project_id !== args.projectId || saved.run_id !== args.runId) {
      throw new ApiError(409, "Idempotency key belongs to another message.");
    }
    if (record.role === "user") {
      if (saved.content !== args.content) throw new ApiError(409, "Idempotency key belongs to another message.");
      const savedFingerprint = Array.isArray(saved.citations)
        ? saved.citations.find((value: unknown) => typeof value === "string" && value.startsWith("followup-request-sha256:"))
        : undefined;
      assertMatchingFollowupRequest(savedFingerprint, args.requestFingerprint, true);
    }
    return saved;
  };
  const message = await insertOrRead({
    project_id: args.projectId, owner_id: args.ownerId, run_id: args.runId,
    idempotency_key: args.requestKey, role: "user", content: args.content,
    citations: [args.requestFingerprint],
  });
  const answer = await insertOrRead({
    project_id: args.projectId, owner_id: args.ownerId, run_id: args.runId,
    idempotency_key: args.requestKey, role: "assistant", content: args.answer,
    citations: args.answerCitations, report_version: args.reportVersion ?? null,
  });
  return { message, answer };
}
