import { createAdminClient } from "@/lib/db/admin";
import { apiErrorResponse, privateJson, requireUser } from "@/lib/api/http";
import { ownedProject } from "@/lib/api/research";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    const db = createAdminClient();
    const project = await ownedProject(db, id, user.id);
    const [messagesResult, runsResult] = await Promise.all([
      db.from("messages").select("*").eq("project_id", id).eq("owner_id", user.id)
        .order("created_at", { ascending: true }),
      db.from("runs").select("*").eq("project_id", id).eq("owner_id", user.id)
        .order("version", { ascending: false }),
    ]);
    if (messagesResult.error) throw messagesResult.error;
    if (runsResult.error) throw runsResult.error;
    return privateJson({ project, messages: messagesResult.data, runs: runsResult.data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
