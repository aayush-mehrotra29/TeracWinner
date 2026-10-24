import { createAdminClient } from "@/lib/db/admin";
import { ApiError, apiErrorResponse, privateJson, requireUser } from "@/lib/api/http";
import { readBoundedFormData } from "@/lib/api/bounded-form";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_IMAGE_BYTES + 100_000;

function verifiedMime(bytes: Uint8Array, declared: string): { mime: string; extension: string } {
  const png = bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10]
    .every((value, index) => bytes[index] === value);
  const jpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  if (png && declared === "image/png") return { mime: declared, extension: "png" };
  if (jpeg && declared === "image/jpeg") return { mime: declared, extension: "jpg" };
  if (webp && declared === "image/webp") return { mime: declared, extension: "webp" };
  throw new ApiError(400, "Upload a PNG, JPEG, or WebP image.");
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = await readBoundedFormData(request, MAX_MULTIPART_BYTES);
    const file = body.get("file");
    if (!(file instanceof File) || file.size < 1 || file.size > MAX_IMAGE_BYTES) {
      throw new ApiError(400, "Choose an image smaller than 10 MB.");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { mime, extension } = verifiedMime(bytes, file.type);
    const id = crypto.randomUUID();
    const path = `${user.id}/${id}.${extension}`;
    const db = createAdminClient();
    const { error: uploadError } = await db.storage.from("research-images").upload(path, bytes, {
      contentType: mime, cacheControl: "3600", upsert: false,
    });
    if (uploadError) throw uploadError;
    const { data: asset, error } = await db.from("assets").insert({
      id, owner_id: user.id, path, mime_type: mime, byte_size: bytes.length,
    }).select("*").single();
    if (error) {
      await db.storage.from("research-images").remove([path]);
      if (error.message.includes("asset_quota_exceeded")) {
        throw new ApiError(429, "Image upload limit reached for this workspace.");
      }
      throw error;
    }
    return privateJson({ asset }, 201);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
