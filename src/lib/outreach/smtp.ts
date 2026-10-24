import nodemailer from "nodemailer";
import { randomUUID } from "node:crypto";
import { CONTACT_EMAIL } from "./config";
import { gmailOptions } from "./gmail";

export function smtpOptions() {
  return { host: "smtp.gmail.com", port: 465, secure: true, auth: gmailOptions().auth,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
    logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true };
}
export function messageId() { return `<orit-${randomUUID()}@gmail.com>`; }
export async function verifySmtp() {
  const transport = nodemailer.createTransport(smtpOptions());
  try { await transport.verify(); } finally { transport.close(); }
}
export async function sendGmail(to: string, subject: string, text: string, id = messageId()) {
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(to) || /[\r\n]/.test(subject) || !subject.trim() || !text.trim()) throw new Error("Invalid email envelope");
  const transport = nodemailer.createTransport(smtpOptions());
  try {
    const result = await transport.sendMail({ from: { name: "Orit", address: CONTACT_EMAIL }, replyTo: CONTACT_EMAIL, to, subject, text, messageId: id,
      headers: { "List-Unsubscribe": `<mailto:${CONTACT_EMAIL}?subject=unsubscribe>`, "Auto-Submitted": "auto-generated" } });
    if (result.rejected?.length || result.accepted?.length !== 1) throw new Error("Gmail did not accept the recipient");
    return { messageId: result.messageId };
  } finally { transport.close(); }
}
