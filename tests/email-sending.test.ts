import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutreachStore, type NewLead } from "../src/lib/outreach/sqlite-store";
import { smtpOptions } from "../src/lib/outreach/smtp";
import { dailyLimit, isOptOut, postalAddress, renderDraft, withFooter, sendNextDraft } from "../src/lib/outreach/campaign";
import { publicIPv4, publicUrl, publishedEmails, contactLinks, type PublicPage } from "../src/lib/outreach/public-web";
import { evidenced } from "../src/lib/outreach/prospects";

const lead: NewLead = { ecommerce_verified:true, product_url:"https://cupbrand.com/products/cup", ecommerce_evidence:"Add to cart; $20", domain: "cupbrand.com", business: "Cup Brand", website: "https://cupbrand.com/", email: "hello@cupbrand.com", contact_source: "https://cupbrand.com/contact", fact: "reusable coffee cups", fact_quote: "Our reusable coffee cups", country_evidence: "Based in Austin, Texas, USA", sources: '["https://cupbrand.com/"]', verified_at: new Date().toISOString() };
const nextLead: NewLead = { ...lead, domain: "otherbrand.com", email: "hello@otherbrand.com" };

test("lead uniqueness and suppression survive restart without a hosted database", () => {
  const directory = mkdtempSync(join(tmpdir(), "orit-db-test-")); const path = join(directory, "state.sqlite");
  try {
    const first = new OutreachStore(path);
    assert.equal(first.addLead(lead), true);
    assert.equal(first.addLead({ ...lead, email: "another@cupbrand.com" }), false);
    first.suppress(lead.email, "Opt-out"); first.close();
    const second = new OutreachStore(path);
    assert.equal(second.leads()[0].status, "suppressed"); assert.equal(second.isSuppressed(lead.email.toUpperCase()), true);
    assert.equal(second.addLead({ ...nextLead, email: lead.email }), false);
    assert.equal(statSync(path).mode & 0o777, 0o600); second.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("locks require the owning token and allow recovery after expiry", () => {
  const db = new OutreachStore(":memory:"); db.setSetting("delivery_enabled","true");
  try {
    const owner = db.claim("inbox"); assert.ok(owner);
    assert.equal(db.claim("inbox"), null); db.release("inbox", "wrong-owner"); assert.equal(db.claim("inbox"), null);
    db.db.prepare("UPDATE locks SET expires=0 WHERE key='inbox'").run(); assert.ok(db.claim("inbox"));
  } finally { db.close(); }
});
test("atomic reservations prevent duplicate sends and pause after uncertain delivery", () => {
  const db = new OutreachStore(":memory:"); db.setSetting("delivery_enabled","true");
  try {
    db.addLead(lead); db.addLead(nextLead); const [a,b] = db.leads("queued");
    db.draft(a.id, "A research question", "Body"); db.draft(b.id, "Another question", "Body");
    assert.equal(db.reserve(a.id, "<one@gmail.com>", 5, 0), true);
    assert.equal(db.reserve(a.id, "<two@gmail.com>", 5, 0), false);
    assert.equal(db.reserve(b.id, "<three@gmail.com>", 5, 0), false);
    db.finish(a.id, "uncertain"); assert.equal(db.reserve(b.id, "<four@gmail.com>", 5, 0), false);
    db.db.prepare("UPDATE leads SET status='sent' WHERE id=?").run(a.id);
    assert.equal(db.reserve(b.id, "<five@gmail.com>", 1, 0), false);
    assert.equal(db.reserve(b.id, "<six@gmail.com>", 5, 300000), false);
    assert.equal(db.reserve(b.id, "<seven@gmail.com>", 5, 0), true);
  } finally { db.close(); }
});
test("reply and opt-out handling prevent queued drafts from sending", () => {
  const db = new OutreachStore(":memory:"); db.setSetting("delivery_enabled","true");
  try {
    db.addLead(lead); const row = db.leads()[0]; db.draft(row.id, "Test", "Body"); db.recordReply(lead.email);
    assert.equal(db.isSuppressed(lead.email), true); assert.equal(db.reserve(row.id, "<blocked@gmail.com>", 5, 0), false);
    assert.equal(db.leads()[0].status, "replied");
  } finally { db.close(); }
});
test("Gmail checkpoints only move forward and intake persists once", () => {
  const db = new OutreachStore(":memory:"); db.setSetting("delivery_enabled","true");
  try { db.advance("box", 20); db.advance("box", 12); assert.equal(db.checkpoint("box"), 20); } finally { db.close(); }
});
test("commercial copy uses Gmail, a postal footer and reply opt-out", () => {
  const body = withFooter(renderDraft(lead, "Which lid design do commuters prefer?"), "123 Main Street, Austin, TX 78701, USA");
  assert.match(body, /reusable coffee cups/); assert.match(body, /oritsoftware@gmail.com/); assert.match(body, /Commercial introduction/); assert.match(body, /123 Main Street/); assert.match(body, /reply "stop"/);
  assert.doesNotMatch(body, /admin@orit.dev|guarantee|Re:/);
});
test("sending without a real postal field never calls SMTP", async () => {
  const previous = process.env.OUTREACH_POSTAL_ADDRESS;
  try {
    process.env.OUTREACH_POSTAL_ADDRESS = "oritsoftware@gmail.com"; assert.equal(postalAddress(), null);
    let called = false;
    const result = await sendNextDraft(async () => { called = true; return { messageId: "test" }; });
    assert.equal(result.sent, 0); assert.equal(called, false);
    process.env.OUTREACH_POSTAL_ADDRESS = "123 Main Street, Austin, TX 78701"; assert.ok(postalAddress());
  } finally { if (previous === undefined) delete process.env.OUTREACH_POSTAL_ADDRESS; else process.env.OUTREACH_POSTAL_ADDRESS = previous; }
  assert.equal(dailyLimit("5"), 5); assert.throws(() => dailyLimit("500")); assert.throws(() => dailyLimit("NaN"));
});
test("opt-out detector ignores quoted unsubscribe footer in an ordinary reply", () => {
  assert.equal(isOptOut("Unsubscribe", "Please remove me."), true); assert.equal(isOptOut("Re: question", "stop"), true);
  assert.equal(isOptOut("Re: question", "Interested!\nOn Saturday, Orit wrote:\nReply unsubscribe to stop."), false);
});
test("public website fetch rejects private, metadata and non-HTTPS targets", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1", "198.18.1.1", "::1", "0.0.0.0"]) assert.equal(publicIPv4(ip), false);
  assert.equal(publicIPv4("8.8.8.8"), true);
  for (const url of ["http://shop.com", "https://127.0.0.1", "https://shop.local", "https://user:pass@shop.com", "https://shop.com:8443", "file:///etc/passwd"]) assert.throws(() => publicUrl(url));
});
test("contacts must appear visibly or in mailto links, not scripts or model guesses", () => {
  const page: PublicPage = { url: "https://cupbrand.com/", text: "Contact hello@cupbrand.com", html: '<script>"hidden@tracker.com"</script><a href="mailto:info@cupbrand.com?subject=Hello">Email</a><a href="/contact">Contact</a><a href="https://attacker.com/contact">Other</a><a href="mailto:privacy@cupbrand.com">Privacy</a>' };
  assert.deepEqual(publishedEmails(page), ["hello@cupbrand.com", "info@cupbrand.com"]);
  assert.deepEqual(contactLinks(page), ["https://cupbrand.com/contact"]);
  assert.equal(evidenced("Our reusable coffee cups", "Our reusable\ncoffee cups are available."), true);
  assert.equal(evidenced("Invented best-selling brand", page.text), false);
});
test("SMTP sends credentials only to Google's encrypted endpoint", () => {
  const previous = process.env.GMAIL_APP_PASSWORD; process.env.GMAIL_APP_PASSWORD = "abcdefghijklmnop";
  try { const options = smtpOptions(); assert.equal(options.host, "smtp.gmail.com"); assert.equal(options.port, 465); assert.equal(options.secure, true); assert.equal(options.auth.user, "oritsoftware@gmail.com"); assert.equal(options.disableFileAccess, true); assert.equal(options.disableUrlAccess, true); }
  finally { if (previous === undefined) delete process.env.GMAIL_APP_PASSWORD; else process.env.GMAIL_APP_PASSWORD = previous; }
});

test("delivery sends a saved draft once and records Gmail acceptance", async () => {
  const previous = process.env.OUTREACH_POSTAL_ADDRESS; process.env.OUTREACH_POSTAL_ADDRESS = "123 Main Street, Austin, TX 78701";
  const db = new OutreachStore(":memory:"); db.setSetting("delivery_enabled","true");
  try {
    db.addLead(lead); const row = db.leads()[0]; db.draft(row.id, "A product research question", "Personalized body");
    let sent = 0;
    const send = async (to: string, subject: string, body: string, id?: string) => { sent++; assert.equal(to, lead.email); assert.match(body, /123 Main Street/); assert.ok(id); return { messageId: id! }; };
    const fetchContact = async () => ({ url: lead.contact_source, text: `Contact ${lead.email}`, html: "" });
    assert.equal((await sendNextDraft(send, { db, fetchContact })).sent, 1);
    assert.equal(db.leads()[0].status, "sent");
    assert.equal((await sendNextDraft(send, { db, fetchContact })).sent, 0); assert.equal(sent, 1);
  } finally { db.close(); if (previous === undefined) delete process.env.OUTREACH_POSTAL_ADDRESS; else process.env.OUTREACH_POSTAL_ADDRESS = previous; }
});
test("ambiguous SMTP failure pauses delivery and never resends the draft", async () => {
  const previous = process.env.OUTREACH_POSTAL_ADDRESS; process.env.OUTREACH_POSTAL_ADDRESS = "123 Main Street, Austin, TX 78701";
  const db = new OutreachStore(":memory:"); db.setSetting("delivery_enabled","true");
  try {
    db.addLead(lead); const row = db.leads()[0]; db.draft(row.id, "Research", "Personalized body");
    let attempts = 0; const send = async () => { attempts++; throw new Error("connection dropped after DATA"); };
    const fetchContact = async () => ({ url: lead.contact_source, text: lead.email, html: "" });
    await assert.rejects(() => sendNextDraft(send, { db, fetchContact }), /Delivery uncertain/);
    assert.equal(db.leads()[0].status, "uncertain");
    assert.equal((await sendNextDraft(send, { db, fetchContact })).sent, 0); assert.equal(attempts, 1);
  } finally { db.close(); if (previous === undefined) delete process.env.OUTREACH_POSTAL_ADDRESS; else process.env.OUTREACH_POSTAL_ADDRESS = previous; }
});
test("contact verification failure suppresses the draft before SMTP", async () => {
  const previous = process.env.OUTREACH_POSTAL_ADDRESS; process.env.OUTREACH_POSTAL_ADDRESS = "123 Main Street, Austin, TX 78701";
  const db = new OutreachStore(":memory:"); db.setSetting("delivery_enabled","true");
  try {
    db.addLead(lead); db.draft(db.leads()[0].id, "Research", "Body");
    let called = false;
    const result = await sendNextDraft(async () => { called = true; return { messageId: "unused" }; }, { db, fetchContact: async () => ({ url: lead.contact_source, text: "No email here", html: "" }) });
    assert.equal(result.sent, 0); assert.equal(called, false); assert.equal(db.isSuppressed(lead.email), true);
  } finally { db.close(); if (previous === undefined) delete process.env.OUTREACH_POSTAL_ADDRESS; else process.env.OUTREACH_POSTAL_ADDRESS = previous; }
});

test("an expired draft cannot block a fresh ecommerce introduction",async()=>{
  const previous=process.env.OUTREACH_POSTAL_ADDRESS;process.env.OUTREACH_POSTAL_ADDRESS="123 Main Street, Austin, TX 78701";
  const db=new OutreachStore(":memory:");db.setSetting("delivery_enabled","true");
  try {
    db.addLead({...lead,verified_at:new Date(Date.now()-8*86400000).toISOString()});db.addLead(nextLead);
    for(const row of db.leads("queued"))db.draft(row.id,"Product research","Personalized body");
    let recipient="";
    const result=await sendNextDraft(async(to,_subject,_body,id)=>{recipient=to;return {messageId:id!};},{db,fetchContact:async()=>({url:nextLead.contact_source,text:nextLead.email,html:""})});
    assert.equal(result.sent,1);assert.equal(recipient,nextLead.email);assert.equal(db.isSuppressed(lead.email),true);
  }finally{db.close();if(previous===undefined)delete process.env.OUTREACH_POSTAL_ADDRESS;else process.env.OUTREACH_POSTAL_ADDRESS=previous;}
});
