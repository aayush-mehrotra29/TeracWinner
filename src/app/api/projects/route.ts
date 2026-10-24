import { createAdminClient } from "@/lib/db/admin";
import { apiErrorResponse, privateJson, readJson, requireUser } from "@/lib/api/http";
import { createProjectAndRun, idempotencyKey } from "@/lib/api/research";
import { parseResearchInput } from "@/lib/api/validation";

export async function GET() {
  try {
    const user = await requireUser();
    const db = createAdminClient();
    const pageSize = 500;
    const projects: Array<{ id: string; [key: string]: unknown }> = [];
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await db.from("projects").select("*")
        .eq("owner_id", user.id).order("updated_at", { ascending: false })
        .order("id", { ascending: true }).range(offset, offset + pageSize - 1);
      if (error) throw error;
      projects.push(...(data ?? []));
      if (!data || data.length < pageSize) break;
    }
    if (!projects.length) return privateJson({ projects: [] });

    const latest = new Map<string, { id: string; mode: string; status: string; stage: string }>();
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await db.from("runs")
        .select("id,project_id,mode,status,stage,version")
        .eq("owner_id", user.id).order("version", { ascending: false })
        .order("id", { ascending: true }).range(offset, offset + pageSize - 1);
      if (error) throw error;
      for (const run of data ?? []) if (!latest.has(run.project_id)) latest.set(run.project_id, run);
      if (!data || data.length < pageSize) break;
    }
    return privateJson({ projects: projects.map((project) => ({
      ...project,
      latest_run_id: latest.get(project.id)?.id ?? null,
      mode: latest.get(project.id)?.mode ?? null,
      status: latest.get(project.id)?.status ?? null,
      stage: latest.get(project.id)?.stage ?? null,
    })) });
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
