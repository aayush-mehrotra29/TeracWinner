import { createAdminClient } from "@/lib/db/admin";
import { ApiError, apiErrorResponse, privateJson, requireUser } from "@/lib/api/http";
import { ownedRun } from "@/lib/api/research";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    const rawAfter = new URL(request.url).searchParams.get("after") ?? "0";
    if (!/^\d+$/.test(rawAfter) || !Number.isSafeInteger(Number(rawAfter))) {
      throw new ApiError(400, "Invalid event sequence.");
    }
    const after = Number(rawAfter);
    const db = createAdminClient();
    const run = await ownedRun(db, id, user.id);
    const { data, error } = await db.from("run_events").select("*")
      .eq("run_id", run.id).eq("owner_id", user.id).gt("seq", after)
      .order("seq", { ascending: true }).limit(200);
    if (error) throw error;
    const events = data ?? [];
    return privateJson({ events, lastSequence: events.at(-1)?.seq ?? after, status: run.status });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
