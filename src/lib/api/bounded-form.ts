import { ApiError } from "./http";

export async function readBoundedFormData(request: Request, maxBytes: number): Promise<FormData> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;") || !request.body) {
    throw new ApiError(400, "Expected a multipart form.");
  }
  const statedLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(statedLength) && statedLength > maxBytes) {
    throw new ApiError(413, "Request is too large.");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new ApiError(413, "Request is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return await new Request(request.url, {
      method: "POST", headers: { "content-type": contentType }, body: bytes,
    }).formData();
  } catch {
    throw new ApiError(400, "The multipart form could not be read.");
  }
}
