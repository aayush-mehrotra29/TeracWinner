import assert from "node:assert/strict";
import test from "node:test";
import { emailRunKey, handoffOneEmail, incomingEmailRunKey, inputFromEmail, inputFromResearchEmail, linkedIntakeFields, type ClaimedIntake } from "../../src/lib/outreach/research-handoff";
import { intakeToken, paidBriefTemplate, parsePaidBrief, verifyIntakeToken } from "../../src/lib/outreach/paid-brief";
import { paidOrder, type WhopPayment } from "../../src/lib/outreach/whop";
import { gmailAuthenticatedSender } from "../../src/lib/outreach/gmail";
import type { ResearchInput } from "../../src/lib/api/validation";
process.env.WHOP_INTAKE_SIGNING_SECRET = "test-only-signing-key-012345678901234567890";
const money = (amount: string) => ({ amount, currency: "usd" });
const payment: WhopPayment = {
  id: "pay_test12345678", account_id: "biz_MexO0HEQnzwpZI", plan_id: "plan_EuakJxGnPAziQ",
  product_id: "prod_ndQbpKRvLZmZo", customer_email: "buyer@example.com", payment_method_type: "card", status: "paid", substatus: "succeeded",
  currency: "usd", paid_at: "2026-10-24T15:00:00Z", refunded_at: null, auto_refunded: false,
  dispute_created_at: null, dispute_alerted_at: null, subtotal: money("59.00"), total: money("63.00"),
  refunded_amount: money("0.00"), presentment_refunded_amount: money("0.00"),
};
function rowFor(input = payment): ClaimedIntake {
  const order = paidOrder(input);
  const body = paidBriefTemplate(order, intakeToken(order))
    .replace("[your product name]", "Seoul Street")
    .replace("[describe your product on one line]", "A crunchy seaweed and rice snack inspired by Seoul street food.")
    .replace("[your target customers]", "US snack buyers")
    .replace("[what you want to learn]", "Which packaging do buyers prefer?");
  return { message_key: "gmail:42", sender: "buyer@example.com", subject: "Paid brief", body_text: body,
    body_incomplete: false, attachment_names: [], sender_authenticated: true,
    received_at: "2026-10-24T15:00:00Z", research_attempts: 1,
    research_claim_token: "3fb50536-b324-4da4-b25a-c0f84e4ea3c9", analysis: {} };
}
test("only the paid Whop plan chooses the research level", () => {
  const light = inputFromEmail(rowFor(), paidOrder(payment));
  assert.equal(light.status, "ready");
  if (light.status === "ready") { assert.equal(light.input.mode, "light_simulation"); assert.equal(light.input.paymentId, payment.id); }
  const deep = { ...payment, plan_id: "plan_egia8RPEVQxvz", product_id: "prod_hhi9xTjUQpmGD", subtotal: money("99.00"), total: money("99.00") };
  const result = inputFromEmail(rowFor(deep), paidOrder(deep));
  assert.equal(result.status, "ready");
  if (result.status === "ready") assert.equal(result.input.mode, "deep_simulation");
});
test("unpaid, unknown merchant/plan/product, insufficient amounts, refunds and disputes fail closed", () => {
  const attacks = [ {payment_method_type:"demo_pay"}, {payment_method_type:"custom"}, {status:"pending"}, {status:"authorized"}, {status:"open"}, {substatus:"refunded"},
    {account_id:"biz_attacker"}, {plan_id:"plan_fake"}, {product_id:"prod_fake"}, {currency:"eur"},
    {subtotal:money("0.00")}, {total:money("1.00")}, {refunded_amount:money("0.01")},
    {refunded_at:"2026-10-24T17:00:00Z"}, {auto_refunded:true}, {dispute_created_at:"2026-10-24T17:00:00Z"},
    {dispute_alerted_at:"2026-10-24T17:00:00Z"}, {customer_email:null}, {paid_at:null},
  ];
  for (const patch of attacks) assert.throws(() => paidOrder({...payment,...patch}));
  assert.throws(() => paidOrder(payment,"attacker@example.com"));
});
test("token is bound to the payment, buyer, expiry and private key", () => {
  const order=paidOrder(payment); const now=Date.now(); const token=intakeToken(order,now);
  assert.ok(verifyIntakeToken(token,order,now));
  assert.equal(verifyIntakeToken(token,{...order,paymentId:"pay_another1234"},now),false);
  assert.equal(verifyIntakeToken(token,{...order,buyerEmail:"attacker@example.com"},now),false);
  assert.equal(verifyIntakeToken(token,order,now+31*86400000),false);
  assert.equal(verifyIntakeToken(token.slice(0,-1)+"!",order,now),false);
});
test("spoofed senders, malformed briefs, attachments and unsafe URLs never create runs", () => {
  const row=rowFor(); const order=paidOrder(payment);
  assert.equal(inputFromEmail(row).status,"needs_payment");
  assert.equal(inputFromEmail({...row,sender_authenticated:false},order).status,"needs_payment");
  assert.equal(inputFromEmail({...row,sender:"attacker@example.com"},order).status,"needs_payment");
  assert.equal(inputFromEmail({...row,body_incomplete:true},order).status,"needs_details");
  assert.equal(inputFromEmail({...row,attachment_names:["brief.pdf"]},order).status,"needs_details");
  assert.equal(inputFromEmail({...row,body_text:row.body_text+"Mode: deep_simulation\n"},order).status,"needs_payment");
  assert.equal(inputFromEmail({...row,body_text:row.body_text!.replace("Product-URL: ","Product-URL: http://127.0.0.1/")},order).status,"needs_details");
  assert.equal(parsePaidBrief("Receipt: paid " + payment.id),null);
  assert.equal(parsePaidBrief(row.body_text+"Payment-ID: pay_another1234\n"),null);
  assert.equal(parsePaidBrief(paidBriefTemplate(order,intakeToken(order))),null);
});
test("Gmail requires DMARC pass from its first authentication header", () => {
  const valid={key:"authentication-results",line:"Authentication-Results: mx.google.com; dmarc=pass (p=REJECT) header.from=example.com; spf=pass"};
  const fail={key:"authentication-results",line:"Authentication-Results: mx.google.com; dmarc=fail header.from=example.com"};
  assert.ok(gmailAuthenticatedSender([valid],"buyer@example.com"));
  assert.equal(gmailAuthenticatedSender([fail,valid],"buyer@example.com"),false);
  assert.equal(gmailAuthenticatedSender([valid],"buyer@attacker.com"),false);
});
test("one payment has one stable bounded run key across different emails", () => {
  assert.equal(emailRunKey(payment.id),emailRunKey(payment.id));
  assert.notEqual(emailRunKey(payment.id),emailRunKey("pay_different123"));
  assert.ok(emailRunKey(payment.id).length<=128);
});
test("a newly linked intake enables delivery in the same database update", () => {
  const fields = linkedIntakeFields("owner-1", "project-1", "run-1");
  assert.equal(fields.research_status, "linked");
  assert.equal(fields.research_run_id, "run-1");
  assert.equal(fields.auto_report_delivery_enabled, true);
});
test("an authenticated product email starts one fixed light simulation without payment", () => {
  const row: ClaimedIntake = {
    ...rowFor(), body_text: "Here is our seaweed snack idea.",
    analysis: { _sender_authenticated: true, category: "product_submission", next_action: "research_intake",
      product_name: "Seoul Street", product_description: "Crunchy seaweed and rice chips with Korean street-food flavors.",
      target_audience: "US snack buyers", research_question: "Which flavor and positioning should launch first?",
      product_url: "https://example.com/snacks" },
  };
  const result = inputFromResearchEmail(row);
  assert.equal(result.status, "ready");
  if (result.status === "ready") {
    assert.equal(result.input.mode, "light_simulation");
    assert.equal(result.input.paymentId, undefined);
    assert.deepEqual(result.input.urls, ["https://example.com/snacks"]);
  }
  assert.equal(incomingEmailRunKey(row.message_key), incomingEmailRunKey(row.message_key));
  assert.notEqual(incomingEmailRunKey(row.message_key), incomingEmailRunKey("gmail:another"));
});
test("unrelated, unauthenticated, incomplete, and unsafe email submissions do not start runs", () => {
  const ready: ClaimedIntake = { ...rowFor(), analysis: {
    _sender_authenticated: true, category: "product_submission", next_action: "research_intake",
    product_name: "Seoul Street", product_description: "Crunchy seaweed and rice chips.",
    target_audience: "US snack buyers", research_question: "Would they try it?", product_url: null,
  } };
  assert.equal(inputFromResearchEmail({ ...ready, analysis: { category: "spam" } }).status, "skipped");
  assert.equal(inputFromResearchEmail({ ...ready, sender_authenticated: false,
    analysis: { ...(ready.analysis as object), _sender_authenticated: false } }).status, "needs_details");
  assert.equal(inputFromResearchEmail({ ...ready, body_incomplete: true }).status, "needs_details");
  assert.equal(inputFromResearchEmail({ ...ready, attachment_names: ["package.png"] }).status, "needs_details");
  assert.equal(inputFromResearchEmail({ ...ready, analysis: {
    ...(ready.analysis as object), product_url: "http://127.0.0.1/private" } }).status, "needs_details");
});
test("a claimed product email is linked to its saved run with report delivery enabled", async () => {
  const row: ClaimedIntake = { ...rowFor(), analysis: {
    _sender_authenticated: true, category: "product_submission", next_action: "research_intake",
    product_name: "Seoul Street", product_description: "Crunchy seaweed and rice chips.",
    target_audience: "US snack buyers", research_question: "Would they try it?", product_url: null,
  } };
  const previousOwner = process.env.ORIT_LOCAL_OWNER_ID;
  const previousPaid = process.env.PAID_EMAIL_INTAKE_ENABLED;
  process.env.ORIT_LOCAL_OWNER_ID = "86e7b651-0d1a-410e-ba7b-ffec57712b64";
  process.env.PAID_EMAIL_INTAKE_ENABLED = "false";
  let linked: Record<string, unknown> | null = null;
  let createKey: string | null = null;
  const db = {
    rpc: async () => ({ data: row, error: null }),
    from: () => ({ update: (fields: Record<string, unknown>) => {
      linked = fields;
      const query = { eq: () => query, select: async () => ({ data: [{ message_key: row.message_key }], error: null }) };
      return query;
    } }),
  };
  try {
    const didWork = await handoffOneEmail(
      db as unknown as Parameters<typeof handoffOneEmail>[0],
      async () => { throw new Error("Payment must not be checked"); },
      (async (_db: unknown, _owner: string, input: ResearchInput, key: string) => {
        assert.equal(input.mode, "light_simulation");
        createKey = key;
        return { project: { id: "project-1" }, run: { id: "run-1" } };
      }) as unknown as NonNullable<Parameters<typeof handoffOneEmail>[2]>,
    );
    assert.equal(didWork, true);
    assert.equal(createKey, incomingEmailRunKey(row.message_key));
    const linkedFields = linked as Record<string, unknown> | null;
    assert.equal(linkedFields?.["research_status"], "linked");
    assert.equal(linkedFields?.["research_run_id"], "run-1");
    assert.equal(linkedFields?.["auto_report_delivery_enabled"], true);
  } finally {
    if (previousOwner === undefined) delete process.env.ORIT_LOCAL_OWNER_ID;
    else process.env.ORIT_LOCAL_OWNER_ID = previousOwner;
    if (previousPaid === undefined) delete process.env.PAID_EMAIL_INTAKE_ENABLED;
    else process.env.PAID_EMAIL_INTAKE_ENABLED = previousPaid;
  }
});
