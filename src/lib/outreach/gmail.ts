import { env } from "./config";
import { createHash } from "node:crypto";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { CONTACT_EMAIL, required } from "./config";
import type { IncomingEmail } from "./intake";
export const GMAIL_HOST = "imap.gmail.com";
export const GMAIL_FOLDER = "INBOX";
export function gmailOptions(password = required("GMAIL_APP_PASSWORD")) {
  if (env("GMAIL_USER") && env("GMAIL_USER").trim().toLowerCase() !== CONTACT_EMAIL) throw new Error("GMAIL_USER must match the configured Orit Gmail sender");
  const pass = password.replace(/\s/g, "");
  if (!/^[a-z]{16}$/i.test(pass)) throw new Error("GMAIL_APP_PASSWORD must be a 16-character Google App Password");
  return { host: GMAIL_HOST, port: 993, secure: true, auth: { user: CONTACT_EMAIL, pass }, logger: false as const, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000, disableAutoIdle: true };
}
export function gmailClient() {
  const client = new ImapFlow(gmailOptions());
  client.on("error", () => { /* Awaited operations surface failures; do not log credentials or email contents. */ });
  return client;
}
export function emailStartDate(value = required("EMAIL_START_DATE")): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("EMAIL_START_DATE must be YYYY-MM-DD");
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error("Invalid EMAIL_START_DATE");
  return date;
}
export function gmailMailboxKey(validity: string, startDate: Date): string {
  return createHash("sha256").update(JSON.stringify([GMAIL_HOST, CONTACT_EMAIL, GMAIL_FOLDER, validity, startDate.toISOString()])).digest("hex");
}
export function gmailMessageKey(emailId: string | undefined, mailboxKey: string, uid: number): string {
  // X-GM-MSGID is stable across Gmail folder moves and UIDVALIDITY resets.
  return emailId ? `gmail:${CONTACT_EMAIL}:${emailId}` : `gmail:${mailboxKey}:${uid}`;
}
export function pendingUids(found: number[] | false, lastUid: number, highest: number): number[] {
  return [...new Set(found || [])].filter(uid => Number.isInteger(uid) && uid > lastUid && uid <= highest).sort((a, b) => a - b).slice(0, 3);
}
export async function parseGmailMessage(source: Buffer, base: Omit<IncomingEmail, "text" | "attachmentNames">): Promise<IncomingEmail> {
  if (source.byteLength > 256000) throw new Error("Message exceeds intake size limit");
  const parsed = await simpleParser(source, { skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true, keepDeliveryStatus: true });
  const contentType = parsed.headers.get("content-type");
  const report = typeof contentType === "object" && contentType !== null && "value" in contentType ? String(contentType.value) : String(contentType || "");
  const failedRecipients = /multipart\/report/i.test(report) ? parsed.attachments.filter(a => a.contentType === "message/delivery-status").flatMap(a => [...a.content.toString("utf8").matchAll(/Final-Recipient:\s*rfc822;\s*([^\s<>]+@[^\s<>]+)/gi)].map(m => m[1].toLowerCase())).slice(0, 20) : [];
  const automatic = Boolean(parsed.headers.get("auto-submitted") && parsed.headers.get("auto-submitted") !== "no") || /^(mailer-daemon|postmaster)@/i.test(base.sender);
  return { ...base, automatic, failedRecipients, text: parsed.text || "", attachmentNames: parsed.attachments.map(a => (a.filename || "unnamed attachment").slice(0, 200)).slice(0, 20) };
}
export async function checkGmailConnection() {
  const client = gmailClient();
  const deadline = setTimeout(() => client.close(), 20000);
  try {
    await client.connect();
    const lock = await client.getMailboxLock(GMAIL_FOLDER, { readOnly: true });
    try { if (!client.mailbox) throw new Error("Gmail Inbox unavailable"); }
    finally { lock.release(); }
  } finally { clearTimeout(deadline); client.close(); }
}
