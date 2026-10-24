import { createAdminClient } from "@/lib/db/admin";
import { apiErrorResponse, privateJson, readJson, requireUser } from "@/lib/api/http";
import { createProjectAndRun, idempotencyKey } from "@/lib/api/research";
import { parseResearchInput } from "@/lib/api/validation";

export async function GET() {
  try {
    const user = await requireUser();
    const db = createAdminClient();
    const { data: projects, error } = await db.from("projects").select("*")
      .eq("owner_id", user.id).order("updated_at", { ascending: false }).limit(100);
    if (error) throw error;
    const ids = projects?.map((project) => project.id) ?? [];
    if (!ids.length) return privateJson({ projects: [] });
    const { data: runs, error: runsError } = await db.from("runs")
      .select("id,project_id,mode,status,stage,created_at,version")
      .eq("owner_id", user.id).in("project_id", ids)
      .order("version", { ascending: false });
    if (runsError) throw runsError;
    const latest = new Map<string, NonNullable<typeof runs>[number]>();
    for (const run of runs ?? []) if (!latest.has(run.project_id)) latest.set(run.project_id, run);
    return privateJson({ projects: projects?.map((project) => ({
      ...project,
      latest_run_id: latest.get(project.id)?.id ?? null,
      mode: latest.get(project.id)?.mode ?? null,
      status: latest.get(project.id)?.status ?? null,
      stage: latest.get(project.id)?.stage ?? null,
    })) ?? [] });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = await readJson(request);
    const input = parseResearchInput(body);
    const result = await createProjectAndRun(createAdminClient(), user.id, input,
      idempotencyKey(request, body));
    return privateJson(result, 201);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
