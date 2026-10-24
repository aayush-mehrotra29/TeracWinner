import { createAdminClient } from "@/lib/db/admin";
import { ApiError, apiErrorResponse, requireUser } from "@/lib/api/http";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    const db = createAdminClient();
    const { data: asset, error } = await db.from("assets").select("*")
      .eq("id", id).eq("owner_id", user.id).maybeSingle();
    if (error) throw error;
    if (!asset) throw new ApiError(404, "Image not found.");
    const { data, error: downloadError } = await db.storage.from("research-images").download(asset.path);
    if (downloadError || !data) throw new ApiError(404, "Image file not found.");
    return new Response(data, {
      headers: {
        "Content-Type": asset.mime_type,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
