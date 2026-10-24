import { createAdminClient } from "@/lib/db/admin";
import { ApiError, apiErrorResponse, privateJson, readJson, requireUser } from "@/lib/api/http";
import { canReviewStudyResponse } from "@/lib/study/review";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; responseId: string }> },
) {
  try {
    const user = await requireUser();
    const { id, responseId } = await context.params;
    const body = await readJson(request, 1024);
    const status = body && typeof body === "object" && !Array.isArray(body)
      ? (body as { reviewStatus?: unknown }).reviewStatus : undefined;
    if (status !== "accepted" && status !== "rejected") {
      throw new ApiError(400, "Choose accepted or rejected.");
    }
    const db = createAdminClient();
    const { data: study, error: studyError } = await db.from("human_studies").select("id,run_id,status")
      .eq("id", id).eq("owner_id", user.id).maybeSingle();
    if (studyError) throw studyError;
    if (!study) throw new ApiError(404, "Study not found.");
    if (!canReviewStudyResponse(study.status)) {
      throw new ApiError(409, "Responses are not ready for review.");
    }
    const { data: current, error: currentError } = await db.from("human_responses")
      .select("*").eq("id", responseId).eq("study_id", id).eq("owner_id", user.id)
      .maybeSingle();
    if (currentError) throw currentError;
    if (!current) throw new ApiError(404, "Response not found.");
    if (status === "accepted" && current.provider_status !== "confirmed") {
      throw new ApiError(409, "Wait for the Terac submission to be matched before accepting this response.");
    }
    if (current.review_status === status) return privateJson({ response: current, resumed: false });
    const { data: response, error } = await db.from("human_responses")
      .update({ review_status: status })
      .eq("id", responseId).eq("study_id", id).eq("owner_id", user.id)
      .select("*").maybeSingle();
    if (error) throw error;
    if (!response) throw new ApiError(404, "Response not found.");
    const { data: resumed, error: runError } = await db.from("runs")
      .update({ status: "queued" }).eq("id", study.run_id).eq("owner_id", user.id)
      .in("status", ["awaiting_humans", "completed"]).select("id").maybeSingle();
    if (runError) throw runError;
    const { error: eventError } = await db.from("run_events").insert({
      run_id: study.run_id, owner_id: user.id, kind: "human_response_reviewed",
      stage: "human_addendum", payload: { responseId, reviewStatus: status },
    });
    if (eventError) throw eventError;
    return privateJson({ response, resumed: Boolean(resumed) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
