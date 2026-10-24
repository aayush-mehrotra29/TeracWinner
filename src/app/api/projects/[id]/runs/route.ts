import { createAdminClient } from "@/lib/db/admin";
import { apiErrorResponse, privateJson, readJson, requireUser } from "@/lib/api/http";
import { createRun, idempotencyKey, ownedProject } from "@/lib/api/research";
import { parseResearchInput } from "@/lib/api/validation";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    const body = await readJson(request);
    const db = createAdminClient();
    const project = await ownedProject(db, id, user.id);
    const input = parseResearchInput(body, project.idea);
    const run = await createRun(db, user.id, id, input, idempotencyKey(request, body));
    return privateJson({ run }, 201);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
