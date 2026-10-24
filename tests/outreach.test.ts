import test from "node:test";
import assert from "node:assert/strict";
import { boundedText, validBearer } from "../src/lib/outreach/http";
import { getKnowledge } from "../src/lib/outreach/knowledge";
import { IntakeSchema, normalizeIntake, type Intake, type IncomingEmail } from "../src/lib/outreach/intake";
import { processEmail, type IntakeRepository } from "../src/lib/outreach/mailbox";
import { emailStartDate, gmailOptions, gmailMailboxKey, gmailMessageKey, pendingUids, parseGmailMessage } from "../src/lib/outreach/gmail";
import { GET as inboxRoute } from "../src/app/api/cron/inbox/route";
const complete: Intake = { category: "product_submission", summary: "Test coffee packaging", product_name: "Coffee", product_description: "Compostable coffee packaging", product_url: "https://example.com/product", target_audience: "Coffee drinkers", research_question: "Is the label clear?", order_reference: null, missing_information: [], next_action: "research_intake" };
const email: IncomingEmail = { key: "account:message", sender: "customer@example.com", subject: "Product", text: "Our new coffee packaging", receivedAt: "2026-10-24T12:00:00Z", attachmentNames: [] };
test("cron authorization fails closed, including missing or weak secrets", () => {
  assert.equal(validBearer(null, undefined), false);
  assert.equal(validBearer("Bearer undefined", undefined), false);
  assert.equal(validBearer("Bearer short", "short"), false);
  const secret = "a".repeat(32);
  assert.equal(validBearer(`Bearer ${secret}`, secret), true);
  assert.equal(validBearer(`Bearer ${"b".repeat(32)}`, secret), false);
});
test("protected endpoint rejects unauthenticated requests before any provider calls", async () => {
  const response = await inboxRoute(new Request("https://backend.example/api/cron/inbox"));
  assert.equal(response.status, 401);
});
test("payload bounds are enforced by bytes, including chunked bodies", async () => {
  assert.equal(await boundedText(new Response("hello"), 5), "hello");
  await assert.rejects(() => boundedText(new Response("ééé"), 5), /too large/);
});
test("unavailable website produces a price-free fallback", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  const knowledge = await getKnowledge();
  assert.equal(knowledge.live, false);
  assert.doesNotMatch(knowledge.text, /\$59|\$99/);
});
test("live website extraction removes script instructions", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response(`<html><body><script>LEAK_SECRET</script><main>Orit ${"Public research information. ".repeat(25)}</main></body></html>`, { headers: { "content-type": "text/html" } }));
  const knowledge = await getKnowledge();
  assert.equal(knowledge.live, true);
  assert.doesNotMatch(knowledge.text, /LEAK_SECRET/);
});
test("routing does not trust model claims that an incomplete brief is ready", () => {
  assert.equal(normalizeIntake({ ...complete, target_audience: null }).next_action, "needs_details");
  assert.equal(normalizeIntake(complete, true).next_action, "needs_details");
  assert.equal(normalizeIntake({ ...complete, category: "spam" }).next_action, "no_action");
  assert.equal(normalizeIntake({ ...complete, category: "existing_customer" }).next_action, "human_review");
  assert.equal(normalizeIntake(complete).next_action, "research_intake");
  assert.equal(normalizeIntake({ ...complete, missing_information: ["Optional deadline"] }).next_action, "research_intake");
  assert.equal(normalizeIntake({ ...complete, product_url: "javascript:alert(1)" }).product_url, null);
  assert.equal(IntakeSchema.safeParse({ summary: "Incomplete model response" }).success, false);
});
test("duplicate mailbox deliveries do not call the model again", async () => {
  const records = new Map<string, Intake>(); let analyses = 0;
  const repository: IntakeRepository = { exists: async key => records.has(key), save: async (message, intake) => { records.set(message.key, intake); } };
  const analyze = async () => { analyses++; return complete; };
  assert.equal(await processEmail(email, repository, analyze), true);
  assert.equal(await processEmail(email, repository, analyze), false);
  assert.equal(analyses, 1); assert.equal(records.size, 1);
});
test("failed analysis or persistence leaves a message retryable", async () => {
  let stored = false;
  const repository: IntakeRepository = { exists: async () => stored, save: async () => { stored = true; } };
  await assert.rejects(() => processEmail(email, repository, async () => { throw new Error("model unavailable"); }));
  assert.equal(stored, false);
  await assert.rejects(() => processEmail(email, { ...repository, save: async () => { throw new Error("DB down"); } }, async () => complete));
  assert.equal(stored, false);
  assert.equal(await processEmail(email, repository, async () => complete), true);
});
test("Gmail credentials are sent only to the fixed Google TLS endpoint", () => {
  const options = gmailOptions("abcd efgh ijkl mnop");
  assert.equal(options.host, "imap.gmail.com");
  assert.equal(options.port, 993);
  assert.equal(options.secure, true);
  assert.equal(options.auth.user, "oritsoftware@gmail.com");
  assert.equal(options.auth.pass, "abcdefghijklmnop");
  assert.equal(options.logger, false);
  assert.throws(() => gmailOptions("not-an-app-password"));
});
test("Gmail start date rejects invalid values", () => {
  assert.equal(emailStartDate("2026-10-24").toISOString(), "2026-10-24T00:00:00.000Z");
  assert.throws(() => emailStartDate("2026-02-30"));
  assert.throws(() => emailStartDate("tomorrow"));
});
test("Gmail cursor resets safely while stable message IDs remain deduplicated", () => {
  const start = emailStartDate("2026-10-24");
  const first = gmailMailboxKey("123", start);
  const reset = gmailMailboxKey("456", start);
  const backfill = gmailMailboxKey("123", emailStartDate("2026-10-17"));
  assert.notEqual(first, reset);
  assert.notEqual(first, backfill);
  assert.equal(gmailMessageKey("1709876190693100009", first, 7), gmailMessageKey("1709876190693100009", reset, 1));
  assert.notEqual(gmailMessageKey(undefined, first, 7), gmailMessageKey(undefined, reset, 7));
});
test("Gmail reads bounded, ordered UID batches without replaying old messages", () => {
  assert.deepEqual(pendingUids([20, 2, 7, 5, 9, 7, 12], 4, 15), [5, 7, 9]);
  assert.deepEqual(pendingUids(false, 4, 15), []);
  assert.deepEqual(pendingUids([1, 2, 3], 4, 15), []);
});
test("Gmail MIME parsing extracts product text and flags attachments for review", async () => {
  const source = Buffer.from([
    "From: Customer <customer@example.com>", "Subject: A product", 'Content-Type: multipart/mixed; boundary="sample"', "",
    "--sample", "Content-Type: text/plain; charset=UTF-8", "", "Our product is a reusable coffee cup.",
    "--sample", "Content-Type: application/pdf", 'Content-Disposition: attachment; filename="product.pdf"', "Content-Transfer-Encoding: base64", "", "ZHVtbXk=", "--sample--", "",
  ].join("\r\n"));
  const parsed = await parseGmailMessage(source, { key: "gmail:test:1", sender: "customer@example.com", subject: "A product", receivedAt: "2026-10-24T12:00:00Z" });
  assert.match(parsed.text, /reusable coffee cup/);
  assert.deepEqual(parsed.attachmentNames, ["product.pdf"]);
  assert.doesNotMatch(parsed.text, /dummy/);
  await assert.rejects(() => parseGmailMessage(Buffer.alloc(256001), email), /size limit/);
});

test("standard delivery failure reports identify recipients for suppression", async () => {
  const raw = Buffer.from([
    "From: Mail Delivery <mailer-daemon@gmail.com>", "Subject: Delivery failed", 'Content-Type: multipart/report; report-type=delivery-status; boundary="dsn"', "",
    "--dsn", "Content-Type: text/plain", "", "Delivery failed.",
    "--dsn", "Content-Type: message/delivery-status", "", "Reporting-MTA: dns; gmail.com", "", "Final-Recipient: rfc822; hello@cupbrand.com", "Action: failed", "Status: 5.1.1", "", "--dsn--", "",
  ].join("\r\n"));
  const parsed = await parseGmailMessage(raw, { key: "bounce:test", sender: "mailer-daemon@gmail.com", subject: "Delivery failed", receivedAt: "2026-10-24T12:00:00Z" });
  assert.equal(parsed.automatic, true); assert.deepEqual(parsed.failedRecipients, ["hello@cupbrand.com"]);
});
