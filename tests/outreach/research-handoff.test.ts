import assert from "node:assert/strict";
import test from "node:test";
import { emailRunKey, inputFromEmail, type ClaimedIntake } from "../../src/lib/outreach/research-handoff";
import { intakeToken, paidBriefTemplate, parsePaidBrief, verifyIntakeToken } from "../../src/lib/outreach/paid-brief";
import { paidOrder, type WhopPayment } from "../../src/lib/outreach/whop";
import { gmailAuthenticatedSender } from "../../src/lib/outreach/gmail";
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
