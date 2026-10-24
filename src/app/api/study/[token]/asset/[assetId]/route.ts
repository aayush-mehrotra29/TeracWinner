import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/db/admin";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string; assetId: string }> },
) {
  const { token, assetId } = await params;
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token) || !/^[0-9a-f-]{36}$/i.test(assetId)) {
    return new Response(null, { status: 404 });
  }
  const admin = createAdminClient();
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const { data: study } = await admin.from("human_studies")
    .select("owner_id,status,materials")
    .eq("response_token_hash", tokenHash)
    .maybeSingle();
  if (!study || !["launched", "collecting", "recruiting"].includes(study.status)) {
    return new Response(null, { status: 404 });
  }
  const materials = (study.materials ?? {}) as { assetIds?: string[] };
  if (!materials.assetIds?.includes(assetId)) return new Response(null, { status: 404 });
  const { data: asset } = await admin.from("assets")
    .select("path,mime_type")
    .eq("id", assetId)
    .eq("owner_id", study.owner_id)
    .maybeSingle();
  if (!asset) return new Response(null, { status: 404 });
  const { data: object, error } = await admin.storage.from("research-images").download(asset.path);
  if (error || !object) return new Response(null, { status: 404 });
  return new Response(await object.arrayBuffer(), {
    headers: {
      "content-type": asset.mime_type,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
