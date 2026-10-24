import { createAdminClient } from "@/lib/db/admin";
import { apiErrorResponse, privateJson, readJson, requireUser } from "@/lib/api/http";
import { createProjectAndRun, idempotencyKey } from "@/lib/api/research";
import { parseResearchInput } from "@/lib/api/validation";

/** Convenience alias for creating a new project and its first run. */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = await readJson(request);
    const input = parseResearchInput(body);
    const { project, run } = await createProjectAndRun(createAdminClient(), user.id,
      input, idempotencyKey(request, body));
    return privateJson({ projectId: project.id, runId: run.id, project, run }, 201);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
