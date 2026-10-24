import { createAdminClient } from "@/lib/db/admin";
import { ApiError, apiErrorResponse, privateJson, readJson, requireUser } from "@/lib/api/http";
import { approvalFingerprint, isLaunchedApprovalRetry } from "@/lib/api/study";
import { TERAC_FIELDWORK_AVAILABLE, TERAC_FIELDWORK_UNAVAILABLE_REASON } from "@/lib/research/fieldwork";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (!TERAC_FIELDWORK_AVAILABLE) throw new ApiError(409, TERAC_FIELDWORK_UNAVAILABLE_REASON);
    const user = await requireUser();
    const { id } = await context.params;
    const body = await readJson(request, 1024);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError(400, "Explicit study approval is required.");
    }
    const approval = body as Record<string, unknown>;
    if (approval.approve !== true || approval.shareApproved !== true ||
      typeof approval.quoteId !== "string" || typeof approval.amountUsd !== "number" ||
      typeof approval.approvalFingerprint !== "string") {
      throw new ApiError(400, "Confirm the exact study cost and shared materials.");
    }
    const db = createAdminClient();
    const { data: study, error } = await db.from("human_studies").select("*")
      .eq("id", id).eq("owner_id", user.id).maybeSingle();
    if (error) throw error;
    if (!study) throw new ApiError(404, "Study not found.");
    if (!study.quote) {
      throw new ApiError(409, "A confirmed quote is required before launch approval.");
    }
    const quote = study.quote as Record<string, unknown>;
    if (typeof quote.id !== "string" || typeof quote.amountUsd !== "number" ||
      quote.currency !== "USD" || !Number.isFinite(quote.amountUsd) || quote.amountUsd <= 0 ||
      !study.materials || typeof study.materials !== "object" ||
      Object.keys(study.materials as Record<string, unknown>).length === 0) {
      throw new ApiError(409, "Study quote or shared materials are incomplete.");
    }
    const currentFingerprint = approvalFingerprint(study.quote, study.materials);
    if (approval.quoteId !== quote.id || approval.amountUsd !== quote.amountUsd ||
      approval.approvalFingerprint !== currentFingerprint) {
      throw new ApiError(409, "Study quote or shared materials changed. Review them again.");
    }
    if (isLaunchedApprovalRetry(study, currentFingerprint)) return privateJson({ study });
    if (study.status !== "needs_approval" && study.status !== "approved") {
      throw new ApiError(409, "This study is not awaiting approval.");
    }
    const { data: run, error: runError } = await db.from("runs").select("id,status")
      .eq("id", study.run_id).eq("owner_id", user.id).maybeSingle();
    if (runError) throw runError;
    if (!run || (run.status !== "awaiting_approval" && run.status !== "queued")) {
      throw new ApiError(409, "This study is not awaiting approval.");
    }
    let approved = study;
    if (study.status === "needs_approval") {
      const result = await db.from("human_studies")
        .update({ status: "approved", approval_at: new Date().toISOString(),
          approved_fingerprint: currentFingerprint })
        .eq("id", id).eq("owner_id", user.id).eq("status", "needs_approval")
        .select("*").maybeSingle();
      if (result.error) throw result.error;
      if (!result.data) throw new ApiError(409, "Study approval changed; refresh and try again.");
      approved = result.data;
    }
    if (run.status === "awaiting_approval") {
      const { error: queueError } = await db.from("runs").update({ status: "queued" })
        .eq("id", run.id).eq("owner_id", user.id).eq("status", "awaiting_approval");
      if (queueError) throw queueError;
      const { error: eventError } = await db.from("run_events").insert({
        run_id: run.id, owner_id: user.id, kind: "terac_approved", stage: "terac_feasibility",
        payload: { studyId: study.id, quoteId: quote.id, amountUsd: quote.amountUsd },
      });
      if (eventError) throw eventError;
    }
    return privateJson({ study: approved });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
