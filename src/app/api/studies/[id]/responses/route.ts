import { createAdminClient } from "@/lib/db/admin";
import { ApiError, apiErrorResponse, privateJson, requireUser } from "@/lib/api/http";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    const db = createAdminClient();
    const { data: study, error: studyError } = await db.from("human_studies")
      .select("id,status,target_count,quote,materials,created_at")
      .eq("id", id).eq("owner_id", user.id).maybeSingle();
    if (studyError) throw studyError;
    if (!study) throw new ApiError(404, "Study not found.");
    const { data: responses, error } = await db.from("human_responses").select("*")
      .eq("study_id", id).eq("owner_id", user.id)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return privateJson({ study, responses: responses ?? [] });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
