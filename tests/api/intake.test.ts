import assert from "node:assert/strict";
import test from "node:test";
import { parseResearchInput } from "../../src/lib/api/validation";

const base = { idea: "An AI-assisted inventory tool for small shops", mode: "light_research" };

test("intake accepts public HTTPS URLs and keeps unit economics for pricing", () => {
  const input = parseResearchInput({
    ...base,
    urls: ["https://example.com/pricing#plans"],
    economics: { unitCost: 12, minGrossMargin: 0.4, priceUnit: "per item" },
  });
  assert.deepEqual(input.urls, ["https://example.com/pricing"]);
  assert.equal(input.priceUnit, "per item");
  assert.equal(input.economics?.unitCost, 12);
});

test("intake rejects HTTP and IPv4-mapped IPv6 URLs", () => {
  assert.throws(() => parseResearchInput({ ...base, urls: ["http://example.com"] }), /HTTPS/);
  assert.throws(() => parseResearchInput({ ...base, urls: ["https://[::ffff:127.0.0.1]/"] }), /HTTPS/);
});

test("intake enforces the image and concept caps", () => {
  assert.throws(() => parseResearchInput({ ...base, concepts: ["a", "b", "c"] }), /concepts/);
  assert.throws(() => parseResearchInput({ ...base, imageAssetIds: [
    "6b57880c-1fa2-4f91-b7db-609a9be85181", "6b57880c-1fa2-4f91-b7db-609a9be85182",
    "6b57880c-1fa2-4f91-b7db-609a9be85183", "6b57880c-1fa2-4f91-b7db-609a9be85184",
    "6b57880c-1fa2-4f91-b7db-609a9be85185",
  ] }), /image assets/);
});
