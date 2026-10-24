import assert from "node:assert/strict";
import dns from "node:dns/promises";
import test, { mock } from "node:test";
import { contentsExa } from "../../src/lib/providers/exa";
import { ModelOutputError, structuredResponse } from "../../src/lib/providers/openai";
import { privateAddress, validatePublicHttpsUrl } from "../../src/lib/providers/public-url";

test("Responses call requests strict stored-off JSON and records usage", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      id: "resp_1", status: "completed", output_text: JSON.stringify({ answer: "Yes" }),
      usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 10 } },
    }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await structuredResponse<{ answer: string }>({
      model: "gpt-6-luna", effort: "low", schemaName: "test_v1",
      schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
      instructions: "Test", input: "Hello",
    });
    assert.equal(body.store, false);
    assert.equal((body.text as { format: { strict: boolean } }).format.strict, true);
    assert.equal(body.model, "gpt-6-luna");
    assert.equal(result.value.answer, "Yes");
    assert.equal(result.inputTokens, 100);
    assert.ok(result.estimatedCostUsd > 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});

test("malformed model output preserves usage for failed-call accounting", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = (async () => new Response(JSON.stringify({
    id: "resp_2", status: "completed", output_text: "not-json",
    usage: { input_tokens: 100, output_tokens: 30 },
  }), { status: 200 })) as typeof fetch;
  try {
    await assert.rejects(structuredResponse({
      model: "gpt-6.1-sol", effort: "medium", schemaName: "test_v1",
      schema: { type: "object", properties: {}, required: [], additionalProperties: false },
      instructions: "Test", input: "Hello",
    }), (error: unknown) => error instanceof ModelOutputError && error.inputTokens === 100 && error.estimatedCostUsd > 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});

test("private URLs and local hostnames cannot be sent for extraction", async () => {
  await assert.rejects(validatePublicHttpsUrl("https://127.0.0.1/secret"));
  await assert.rejects(validatePublicHttpsUrl("https://localhost/secret"));
  await assert.rejects(validatePublicHttpsUrl("http://example.com"));
  await assert.rejects(validatePublicHttpsUrl("https://user:password@example.com"));
  assert.equal(privateAddress("::ffff:172.16.0.1"), true);
  assert.equal(privateAddress("::ffff:169.254.1.1"), true);
  assert.equal(privateAddress("::ffff:8.8.8.8"), false);
});

test("Exa Contents sends validated URLs in the documented ids field", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.EXA_API_KEY;
  process.env.EXA_API_KEY = "test-key";
  const lookup = mock.method(dns, "lookup", async () => [{ address: "8.8.8.8", family: 4 }]);
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      results: [{ id: "source-1", url: "https://source.invalid/page", title: "Source", highlights: ["Useful evidence"] }],
      costDollars: { total: 0.002 }, requestId: "exa-1",
    }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await contentsExa(["https://source.invalid/page"]);
    assert.deepEqual(body.ids, ["https://source.invalid/page"]);
    assert.equal("urls" in body, false);
    assert.equal(result.results[0].excerpt, "Useful evidence");
    assert.equal(result.costUsd, 0.002);
  } finally {
    lookup.mock.restore();
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = originalKey;
  }
});
