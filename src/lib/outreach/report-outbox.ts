import type { SupabaseClient } from "@supabase/supabase-js";
import { renderReportPdf } from "../report/pdf";
import type { ReportContent } from "../research/types";
import {
  prepareReportDelivery, sendReportPdf,
  type PreparedReportDelivery,
} from "./report-delivery";

type Delivery = {
  id: string;
  run_id: string;
  owner_id: string;
  report_version: number;
  intake_message_key: string | null;
  recipient: string | null;
};

type DeliverySteps = {
  claim: (messageId: string) => Promise<boolean>;
  send: (prepared: PreparedReportDelivery) => Promise<unknown>;
  markSent: () => Promise<void>;
  markUncertain: (reason: string) => Promise<void>;
};

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/** A claimed SMTP attempt is never retried automatically: a timeout may follow acceptance. */
export async function sendClaimedReport(prepared: PreparedReportDelivery, steps: DeliverySteps): Promise<boolean> {
  if (!await steps.claim(prepared.email.messageId)) return false;
  try {
    await steps.send(prepared);
  } catch (error) {
    await steps.markUncertain(errorText(error));
    return true;
  }
  try {
    await steps.markSent();
  } catch (error) {
    await steps.markUncertain(`Gmail accepted the PDF but status recording failed: ${errorText(error)}`);
  }
  return true;
}

async function skip(db: SupabaseClient, row: Delivery, reason: string): Promise<void> {
  const { error } = await db.from("report_deliveries")
    .update({ status: "skipped", error: reason.slice(0, 500) })
    .eq("id", row.id).eq("status", "pending");
  if (error) throw new Error(`Unable to skip report delivery: ${error.message}`);
}

async function pdfBytes(db: SupabaseClient, report: { pdf_path: string | null; content: ReportContent }): Promise<Uint8Array> {
  if (report.pdf_path) {
    const { data, error } = await db.storage.from("research-reports").download(report.pdf_path);
    if (!error && data) return new Uint8Array(await data.arrayBuffer());
  }
  return renderReportPdf(report.content);
}

/** Process at most one pending report. Safe to run from concurrent workers. */
export async function deliverOnePendingReport(db: SupabaseClient): Promise<boolean> {
  // A process can exit after claiming and before recording Gmail's answer.
  // Such rows require review and must never return to the pending queue.
  const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString();
  const { error: staleError } = await db.from("report_deliveries")
    .update({ status: "uncertain", error: "Worker stopped during Gmail delivery; check Sent before manual action" })
    .eq("status", "sending").lt("claimed_at", staleBefore);
  if (staleError) throw new Error(`Unable to reconcile claimed report deliveries: ${staleError.message}`);
  const { data: row, error: queueError } = await db.from("report_deliveries")
    .select("id,run_id,owner_id,report_version,intake_message_key,recipient")
    .eq("status", "pending").order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (queueError) throw new Error(`Unable to read report deliveries: ${queueError.message}`);
  if (!row) return false;
  const delivery = row as Delivery;
  if (!delivery.intake_message_key || !delivery.recipient) {
    await skip(db, delivery, "Missing saved customer email recipient");
    return true;
  }

  const [runResult, intakeResult, reportResult] = await Promise.all([
    db.from("runs").select("id,owner_id,status").eq("id", delivery.run_id).eq("owner_id", delivery.owner_id).maybeSingle(),
    db.from("outreach_intakes")
      .select("message_key,sender,research_run_id,research_owner_id,research_status,auto_report_delivery_enabled")
      .eq("message_key", delivery.intake_message_key).maybeSingle(),
    db.from("report_versions").select("run_id,owner_id,version,content,pdf_path")
      .eq("run_id", delivery.run_id).eq("owner_id", delivery.owner_id)
      .eq("version", delivery.report_version).maybeSingle(),
  ]);
  if (runResult.error || intakeResult.error || reportResult.error) {
    throw new Error(`Unable to load report delivery: ${runResult.error?.message ?? intakeResult.error?.message ?? reportResult.error?.message}`);
  }
  const run = runResult.data;
  const intake = intakeResult.data;
  const report = reportResult.data;
  if (!run || !intake || !report || !intake.auto_report_delivery_enabled ||
      run.status !== "completed" || report.run_id !== run.id || report.owner_id !== run.owner_id ||
      report.version !== delivery.report_version ||
      intake.research_run_id !== run.id || intake.research_owner_id !== run.owner_id ||
      intake.research_status !== "linked" || intake.sender.trim().toLowerCase() !== delivery.recipient) {
    await skip(db, delivery, "Saved report or customer email link no longer matches the completed run");
    return true;
  }

  let pdf: Uint8Array;
  try {
    pdf = await pdfBytes(db, { pdf_path: report.pdf_path, content: report.content as ReportContent });
  } catch (error) {
    await skip(db, delivery, `Saved report could not be rendered as a PDF: ${errorText(error)}`);
    return true;
  }
  let prepared: PreparedReportDelivery;
  try {
    prepared = prepareReportDelivery({ run, intake, report: report.content as ReportContent, pdf });
    if (prepared.email.to !== delivery.recipient) throw new Error("Saved report recipient changed");
  } catch (error) {
    await skip(db, delivery, errorText(error));
    return true;
  }

  await sendClaimedReport(prepared, {
    claim: async (messageId) => {
      const { data, error } = await db.from("report_deliveries")
        .update({ status: "sending", message_id: messageId, claimed_at: new Date().toISOString(), error: null })
        .eq("id", delivery.id).eq("status", "pending").eq("recipient", prepared.email.to)
        .select("id");
      if (error) throw new Error(`Unable to claim report delivery: ${error.message}`);
      return Boolean(data?.length);
    },
    send: sendReportPdf,
    markSent: async () => {
      const { data, error } = await db.from("report_deliveries")
        .update({ status: "sent", sent_at: new Date().toISOString(), error: null })
        .eq("id", delivery.id).eq("status", "sending").eq("message_id", prepared.email.messageId)
        .select("id");
      if (error || !data?.length) throw new Error(`Unable to record sent report: ${error?.message ?? "claim changed"}`);
    },
    markUncertain: async (reason) => {
      const { error } = await db.from("report_deliveries")
        .update({ status: "uncertain", error: reason })
        .eq("id", delivery.id).eq("status", "sending").eq("message_id", prepared.email.messageId);
      if (error) throw new Error(`Unable to record uncertain report delivery: ${error.message}`);
    },
  });
  return true;
}
