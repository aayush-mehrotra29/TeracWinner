import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./config";
import type { PaidOrder } from "./whop";

export type PaidBrief = { paymentId: string; token: string; name: string; description: string; audience: string; question: string; url?: string };
const LABELS = ["Payment-ID", "Intake-Token", "Product-Name", "Product-Description", "Target-Audience", "Research-Question", "Product-URL"];
export function parsePaidBrief(text: string): PaidBrief | null {
  if (text.length > 18000) return null;
  // A quoted/forwarded receipt or a model-extracted order reference is never an authorization.
  const lines = text.replace(/\r\n/g, "\n").trim().split("\n");
  if (lines.shift() !== "ORIT-PAID-BRIEF/1") return null;
  const fields: Record<string, string> = {};
  for (const line of lines) {
    if (!line.trim()) continue;
    const match = /^([A-Za-z-]+): ?(.*)$/.exec(line);
    if (!match || !LABELS.includes(match[1]) || Object.hasOwn(fields, match[1])) return null;
    fields[match[1]] = match[2].trim();
  }
  if (!/^pay_[A-Za-z0-9]{8,80}$/.test(fields["Payment-ID"] || "")) return null;
  if (!/^\d{10}\.[A-Za-z0-9_-]{43}$/.test(fields["Intake-Token"] || "") ||
      !fields["Product-Name"] || fields["Product-Name"].length > 160 ||
      !fields["Product-Description"] || fields["Product-Description"].length < 8 || fields["Product-Description"].length > 10000 ||
      !fields["Target-Audience"] || fields["Target-Audience"].length > 500 ||
      !fields["Research-Question"] || fields["Research-Question"].length > 1000 ||
      (fields["Product-URL"]?.length || 0) > 2048) return null;
  if (Object.values(fields).some(value => /^\[.*\]$/.test(value))) return null;
  return { paymentId: fields["Payment-ID"], token: fields["Intake-Token"], name: fields["Product-Name"],
    description: fields["Product-Description"], audience: fields["Target-Audience"], question: fields["Research-Question"], url: fields["Product-URL"] || undefined };
}
function signingKey(): string {
  const key = env("WHOP_INTAKE_SIGNING_SECRET") || env("ORIT_WORKSPACE_SECRET");
  if (!key || key.length < 32) throw new Error("Configure a stable private intake signing secret.");
  return key;
}
function signature(id: string, buyer: string, expiry: string): string {
  return createHmac("sha256", signingKey()).update(JSON.stringify(["orit-paid-brief-v1", id, buyer.toLowerCase(), expiry])).digest("base64url");
}
export function intakeToken(order: PaidOrder, now = Date.now()): string {
  const expiry = String(Math.floor(now / 1000) + 30 * 86400);
  return `${expiry}.${signature(order.paymentId, order.buyerEmail, expiry)}`;
}
export function verifyIntakeToken(token: string, order: PaidOrder, now = Date.now()): boolean {
  const match = /^(\d{10})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match || Number(match[1]) <= now / 1000 || Number(match[1]) > now / 1000 + 31 * 86400) return false;
  const actual = Buffer.from(match[2]);
  const expected = Buffer.from(signature(order.paymentId, order.buyerEmail, match[1]));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function paidBriefTemplate(order: PaidOrder, token: string): string {
  return `ORIT-PAID-BRIEF/1\nPayment-ID: ${order.paymentId}\nIntake-Token: ${token}\nProduct-Name: [your product name]\nProduct-Description: [describe your product on one line]\nTarget-Audience: [your target customers]\nResearch-Question: [what you want to learn]\nProduct-URL: \n`;
}
