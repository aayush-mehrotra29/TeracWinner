import { createAdminClient } from "@/lib/db/admin";
import { apiErrorResponse, privateJson, requireUser } from "@/lib/api/http";
import { ownedRun } from "@/lib/api/research";
import { approvalFingerprint } from "@/lib/api/study";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    const db = createAdminClient();
    const run = await ownedRun(db, id, user.id);
    const [projectResult, messagesResult, eventsResult, artifactsResult, reportsResult, studyResult, inputVersionsResult] =
      await Promise.all([
        db.from("projects").select("*").eq("id", run.project_id).eq("owner_id", user.id).single(),
        db.from("messages").select("*").eq("project_id", run.project_id).eq("run_id", id).eq("owner_id", user.id)
          .order("created_at", { ascending: true }),
        db.from("run_events").select("*").eq("run_id", id).eq("owner_id", user.id)
          .order("seq", { ascending: false }).limit(500),
        db.from("run_artifacts").select("*").eq("run_id", id).eq("owner_id", user.id)
          .order("created_at", { ascending: true }),
        db.from("report_versions").select("*").eq("run_id", id).eq("owner_id", user.id)
          .order("version", { ascending: false }),
        db.from("human_studies").select("id,run_id,owner_id,status,target_count,quote,materials,provider_id,approved_fingerprint,approval_at,launched_at,created_at,updated_at")
          .eq("run_id", id).eq("owner_id", user.id).maybeSingle(),
        db.from("run_input_versions").select("revision,input,created_at")
          .eq("run_id", id).eq("owner_id", user.id).order("revision", { ascending: true }),
      ]);
    for (const result of [projectResult, messagesResult, eventsResult, artifactsResult, reportsResult, studyResult, inputVersionsResult]) {
      if (result.error) throw result.error;
    }
    const artifacts = artifactsResult.data ?? [];
    const graphArtifact = [...artifacts].reverse().find((artifact) => artifact.kind === "graph");
    const graph = graphArtifact?.data && typeof graphArtifact.data === "object"
      ? graphArtifact.data : { nodes: [], edges: [] };
    return privateJson({
      run,
      project: projectResult.data,
      messages: messagesResult.data ?? [],
      events: [...(eventsResult.data ?? [])].reverse(),
      artifacts,
      inputVersions: inputVersionsResult.data ?? [],
      graph,
      report: reportsResult.data?.[0] ?? null,
      reports: reportsResult.data ?? [],
      study: studyResult.data ? {
        ...studyResult.data,
        approvalFingerprint: studyResult.data.quote
          ? approvalFingerprint(studyResult.data.quote, studyResult.data.materials) : null,
      } : null,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
