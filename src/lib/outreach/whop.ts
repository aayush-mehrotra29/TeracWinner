import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { env } from "./config";

const execute = promisify(execFile);
export const WHOP_ACCOUNT_ID = "biz_MexO0HEQnzwpZI";
export const PAID_PLANS = {
  plan_EuakJxGnPAziQ: { product: "prod_ndQbpKRvLZmZo", mode: "light_simulation", name: "Light Simulation", cents: 5900 },
  plan_egia8RPEVQxvz: { product: "prod_hhi9xTjUQpmGD", mode: "deep_simulation", name: "In Depth Simulation", cents: 9900 },
} as const;
export type PaidMode = (typeof PAID_PLANS)[keyof typeof PAID_PLANS]["mode"];
type Money = { amount: string; currency: string };
export type WhopPayment = {
  id: string; account_id: string | null; plan_id: string | null; product_id: string | null;
  customer_email: string | null; payment_method_type: string | null; status: string; substatus: string; currency: string;
  paid_at: string | null; refunded_at: string | null; auto_refunded: boolean;
  dispute_created_at: string | null; dispute_alerted_at: string | null;
  subtotal: Money | null; total: Money | null; refunded_amount: Money | null;
  presentment_refunded_amount: Money | null; membership_id?: string | null;
};
export type PaidOrder = { paymentId: string; buyerEmail: string; planId: keyof typeof PAID_PLANS; mode: PaidMode; name: string; paidAt: string };
export class PaymentRejected extends Error {}
export function paymentId(value: string): string {
  if (!/^pay_[A-Za-z0-9]{8,80}$/.test(value)) throw new PaymentRejected("Invalid Whop payment reference.");
  return value;
}
function cents(money: Money | null | undefined): number {
  if (!money || money.currency !== "usd" || !/^\d+\.\d{2}$/.test(money.amount)) return NaN;
  const [whole, fraction] = money.amount.split(".");
  const amount = Number(whole) * 100 + Number(fraction);
  return Number.isSafeInteger(amount) ? amount : NaN;
}
/** Only Whop's authoritative server response determines the purchased level. */
export function paidOrder(payment: WhopPayment, sender?: string): PaidOrder {
  paymentId(payment.id);
  const plan = payment.plan_id && Object.hasOwn(PAID_PLANS, payment.plan_id)
    ? PAID_PLANS[payment.plan_id as keyof typeof PAID_PLANS] : null;
  const buyer = payment.customer_email?.trim().toLowerCase();
  if (!plan || payment.account_id !== WHOP_ACCOUNT_ID || payment.product_id !== plan.product ||
      !payment.payment_method_type || !["card", "apple_pay", "google_pay"].includes(payment.payment_method_type) ||
      payment.status !== "paid" || payment.substatus !== "succeeded" || !payment.paid_at ||
      !Number.isFinite(Date.parse(payment.paid_at)) || payment.currency !== "usd" ||
      cents(payment.subtotal) !== plan.cents || !(cents(payment.total) >= plan.cents) ||
      payment.auto_refunded !== false || payment.refunded_at !== null ||
      payment.dispute_created_at !== null || payment.dispute_alerted_at !== null ||
      (payment.refunded_amount !== null && cents(payment.refunded_amount) !== 0) ||
      (payment.presentment_refunded_amount !== null && cents(payment.presentment_refunded_amount) !== 0) ||
      !buyer || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyer) ||
      (sender !== undefined && sender.trim().toLowerCase() !== buyer)) {
    throw new PaymentRejected("Payment is not eligible for paid research intake.");
  }
  return { paymentId: payment.id, buyerEmail: buyer, planId: payment.plan_id as keyof typeof PAID_PLANS,
    mode: plan.mode, name: plan.name, paidAt: payment.paid_at };
}
export async function whopRead(resource: "payment", id: string): Promise<WhopPayment>;
export async function whopRead(resource: "list", id?: undefined): Promise<{ data: WhopPayment[]; page_info: { end_cursor: string | null } }>;
export async function whopRead(resource: "payment" | "list", id?: string): Promise<WhopPayment | { data: WhopPayment[]; page_info: { end_cursor: string | null } }> {
  if (id) paymentId(id);
  const apiKey = env("WHOP_API_KEY");
  let result: unknown;
  if (apiKey) {
    const url = resource === "payment" ? `https://api.whop.com/api/v1/payments/${id}`
      : `https://api.whop.com/api/v1/payments?account_id=${WHOP_ACCOUNT_ID}&status=paid&first=100&order=created_at&direction=desc`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}`, "Api-Version-Date": "2026-10-15-1" },
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error("Whop verification unavailable; no research authorized.");
    result = await response.json();
  } else if (env("WHOP_USE_CLI") === "true") {
    // Local-only fallback uses the already authenticated CLI/keychain. No shell,
    // arbitrary arguments, API key extraction, or user-controlled executable.
    const args = resource === "payment" ? ["payments", "get", id!, "--format", "json"]
      : ["payments", "list", "--account_id", WHOP_ACCOUNT_ID, "--status", "paid", "--first", "100", "--order", "created_at", "--direction", "desc", "--format", "json"];
    try { const { stdout } = await execute("whop", args, { timeout: 20000, maxBuffer: 2_000_000 }); result = JSON.parse(stdout); }
    catch { throw new Error("Whop verification unavailable; no research authorized."); }
  } else throw new Error("Configure WHOP_API_KEY or local WHOP_USE_CLI before enabling paid intake.");
  if (!result || typeof result !== "object" || "code" in result) throw new Error("Whop returned an invalid verification response.");
  return result as WhopPayment;
}
export async function verifyPayment(id: string, sender?: string): Promise<PaidOrder> {
  const payment = await whopRead("payment", paymentId(id));
  if (payment.id !== id) throw new PaymentRejected("Payment reference mismatch.");
  return paidOrder(payment, sender);
}
