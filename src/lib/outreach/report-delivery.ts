import { createHash } from "node:crypto";
import nodemailer from "nodemailer";
import type { ReportContent } from "../research/types";
import { CONTACT_EMAIL } from "./config";
import { smtpOptions } from "./smtp";

const MAX_PDF_BYTES = 15 * 1024 * 1024;
const ADDRESS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

/** Rows must be read from storage, not populated from model output or a request body. */
export interface ReportDeliveryInput {
  run: { id: string; owner_id: string; status: string };
  intake: {
    message_key: string;
    sender: string;
    research_run_id: string | null;
    research_owner_id: string | null;
    research_status: string;
  };
  report: Pick<ReportContent, "title" | "metadata">;
  pdf: Uint8Array;
}

export interface ReportEmail {
  from: { name: string; address: string };
  replyTo: string;
  to: string;
  subject: string;
  text: string;
  messageId: string;
  headers: Record<string, string>;
  attachments: Array<{
    filename: string;
    content: Buffer;
    contentType: "application/pdf";
    contentDisposition: "attachment";
  }>;
}

export interface PreparedReportDelivery {
  /** Reserve this key durably before SMTP. The Message-ID alone is not deduplication. */
  deliveryKey: string;
  email: ReportEmail;
}

function validatedRecipient(input: ReportDeliveryInput): string {
  const { run, intake, report, pdf } = input;
  if (run.status !== "completed" || !run.id || !run.owner_id ||
      report.metadata.runId !== run.id ||
      intake.research_status !== "linked" ||
      intake.research_run_id !== run.id ||
      intake.research_owner_id !== run.owner_id ||
      typeof intake.message_key !== "string" || !intake.message_key.startsWith("gmail:") ||
      !Number.isSafeInteger(report.metadata.reportVersion) || report.metadata.reportVersion < 1) {
    throw new Error("Report and saved Gmail intake are not linked to a completed run");
  }
  const recipient = typeof intake.sender === "string" ? intake.sender.trim().toLowerCase() : "";
  if (recipient.length > 254 || !ADDRESS.test(recipient) || /[\r\n,;<>\s]/.test(recipient) || recipient === CONTACT_EMAIL) {
    throw new Error("Saved Gmail intake has no valid external sender");
  }
  if (!(pdf instanceof Uint8Array) || pdf.byteLength < 5 || pdf.byteLength > MAX_PDF_BYTES ||
      Buffer.from(pdf.subarray(0, 5)).toString("ascii") !== "%PDF-") {
    throw new Error("Report attachment must be a PDF under 15 MB");
  }
  return recipient;
}

export function prepareReportDelivery(input: ReportDeliveryInput): PreparedReportDelivery {
  const recipient = validatedRecipient(input);
  const { run, intake, report, pdf } = input;
  const version = report.metadata.reportVersion;
  const digest = createHash("sha256")
    .update(JSON.stringify([run.id, version, intake.message_key, recipient]))
    .digest("hex");
  const deliveryKey = `report:${run.id}:v${version}:${digest}`;
  const messageId = `<orit-report-${digest}@gmail.com>`;
  const title = typeof report.title === "string"
    ? report.title.replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, " ").trim().slice(0, 120)
    : "";
  return {
    deliveryKey,
    email: {
      from: { name: "Orit", address: CONTACT_EMAIL },
      replyTo: CONTACT_EMAIL,
      to: recipient,
      subject: title ? `Your Orit research report: ${title}` : "Your Orit research report",
      text: "Your Orit research report is attached as a PDF.\n\nThe findings are directional. Please review the sources, assumptions, and limitations in the report before making a launch decision.\n\nOrit\n",
      messageId,
      headers: { "Auto-Submitted": "auto-generated" },
      attachments: [{
        filename: `orit-research-report-v${version}.pdf`,
        content: Buffer.from(pdf),
        contentType: "application/pdf",
        contentDisposition: "attachment",
      }],
    },
  };
}

export type ReportEmailSender = (email: ReportEmail) => Promise<{
  messageId?: string;
  accepted?: string[];
  rejected?: string[];
}>;

export async function sendViaGmailSmtp(email: ReportEmail) {
  const transport = nodemailer.createTransport(smtpOptions());
  try {
    return await transport.sendMail(email);
  } finally {
    transport.close();
  }
}

/** Call only after a durable, unique delivery claim has been acquired. Never auto-retry SMTP errors. */
export async function sendReportPdf(
  prepared: PreparedReportDelivery,
  send: ReportEmailSender = sendViaGmailSmtp,
): Promise<{ deliveryKey: string; messageId: string }> {
  const result = await send(prepared.email);
  if (result.rejected?.length || result.accepted?.length !== 1 ||
      result.accepted[0].toLowerCase() !== prepared.email.to) {
    throw new Error("Gmail did not confirm acceptance of the report recipient");
  }
  return { deliveryKey: prepared.deliveryKey, messageId: result.messageId || prepared.email.messageId };
}
