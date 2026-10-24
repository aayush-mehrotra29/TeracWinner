import assert from "node:assert/strict";
import test from "node:test";
import { readBoundedFormData } from "../../src/lib/api/bounded-form";
import { ApiError } from "../../src/lib/api/http";

test("multipart form parsing preserves fields within the configured limit", async () => {
  const form = new FormData();
  form.set("answer", "A saved response");
  const request = new Request("https://example.com/submit", { method: "POST", body: form });
  const parsed = await readBoundedFormData(request, 1024);
  assert.equal(parsed.get("answer"), "A saved response");
});

test("chunked multipart body is rejected before unbounded parsing", async () => {
  const boundary = "research-test-boundary";
  const bytes = new TextEncoder().encode(`--${boundary}\r\nContent-Disposition: form-data; name="answer"\r\n\r\n${"x".repeat(4096)}\r\n--${boundary}--\r\n`);
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + 512));
      offset += 512;
    },
  });
  const request = new Request("https://example.com/submit", {
    method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: stream, duplex: "half",
  } as RequestInit & { duplex: "half" });
  await assert.rejects(() => readBoundedFormData(request, 1024), (error: unknown) =>
    error instanceof ApiError && error.status === 413);
});
