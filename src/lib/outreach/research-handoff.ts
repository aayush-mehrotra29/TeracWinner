import { createHash, randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/db/admin";
import { localWorkspaceOwnerId } from "@/lib/api/workspace-identity";
import { createProjectAndRun } from "@/lib/api/research";
import { parseResearchInput, type ResearchInput } from "@/lib/api/validation";
import { PaidOrders } from "./paid-orders";
import { env } from "./config";
import { parsePaidBrief, verifyIntakeToken } from "./paid-brief";
import { PaymentRejected, verifyPayment, type PaidOrder } from "./whop";

type Admin = ReturnType<typeof createAdminClient>;
export type ClaimedIntake = {
  message_key: string; sender: string; subject: string; body_text: string | null;
  body_incomplete: boolean; attachment_names: unknown; sender_authenticated?: boolean;
  received_at: string; analysis: unknown; research_attempts: number; research_claim_token: string;
};
export function emailRunKey(paymentId: string): string {
  return `whop:${createHash("sha256").update(paymentId).digest("hex")}`;
}
export function incomingEmailRunKey(messageKey: string): string {
  return `email:${createHash("sha256").update(messageKey).digest("hex")}`;
}
function authenticated(row: ClaimedIntake): boolean {
  const analysis=row.analysis as Record<string,unknown> | null;
  return row.sender_authenticated===true || analysis?._sender_authenticated===true;
}
function extractedText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Only a saved, classified product brief can start unpaid local research. */
export function inputFromResearchEmail(row: ClaimedIntake):
  | { status: "ready"; input: ResearchInput }
  | { status: "needs_details" | "skipped"; reason: string } {
  const analysis = row.analysis && typeof row.analysis === "object" && !Array.isArray(row.analysis)
    ? row.analysis as Record<string, unknown> : {};
  if (analysis.category !== "product_submission") {
    return { status: "skipped", reason: "Email is not a product submission." };
  }
  if (!authenticated(row)) {
    return { status: "needs_details", reason: "Sender authentication could not be verified in Gmail." };
  }
  if (row.body_incomplete || (Array.isArray(row.attachment_names) && row.attachment_names.length)) {
    return { status: "needs_details", reason: "The complete email or attached materials need review before research starts." };
  }
  if (analysis.next_action !== "research_intake") {
    return { status: "needs_details", reason: "A product description, buyer audience, and research question are needed." };
  }
  const name = extractedText(analysis.product_name) ?? row.subject.trim();
  const description = extractedText(analysis.product_description);
  const audience = extractedText(analysis.target_audience);
  const question = extractedText(analysis.research_question);
  if (!name || !description || !audience || !question) {
    return { status: "needs_details", reason: "A product description, buyer audience, and research question are needed." };
  }
  try {
    const url = extractedText(analysis.product_url);
    const input = parseResearchInput({
      idea: `${name}\n\n${description}\n\nResearch decision: ${question}`,
      mode: "light_simulation", audience, concepts: [], imageAssetIds: [], urls: url ? [url] : [],
    });
    return { status: "ready", input };
  } catch {
    return { status: "needs_details", reason: "Product details or URL are invalid for research." };
  }
}
export function inputFromEmail(row: ClaimedIntake, order?: PaidOrder):
  | { status: "ready"; input: ResearchInput & { paymentId: string } }
  | { status: "needs_details" | "needs_payment" | "skipped"; reason: string } {
  const brief = parsePaidBrief(row.body_text || "");
  if (!brief || !authenticated(row)) return { status: "needs_payment", reason: "A signed paid brief from an authenticated buyer is required." };
  if (row.body_incomplete || (Array.isArray(row.attachment_names) && row.attachment_names.length)) {
    return { status: "needs_details", reason: "Use the complete plain-text brief; attachments require human review." };
  }
  if (!order || brief.paymentId !== order.paymentId || row.sender.toLowerCase() !== order.buyerEmail || !verifyIntakeToken(brief.token, order)) {
    return { status: "needs_payment", reason: "Payment or buyer-bound intake token could not be verified." };
  }
  try {
    const input = parseResearchInput({
      idea: `${brief.name}\n\n${brief.description}\n\nResearch decision: ${brief.question}`,
      mode: order.mode, audience: brief.audience, concepts: [], imageAssetIds: [], urls: brief.url ? [brief.url] : [],
    });
    return { status: "ready", input: { ...input, paymentId: order.paymentId } };
  } catch { return { status: "needs_details", reason: "The brief contains invalid product details or a non-public URL." }; }
}
async function finishClaim(db: Admin, row: ClaimedIntake, fields: Record<string, unknown>): Promise<void> {
  const { data, error } = await db.from("outreach_intakes").update({
    ...fields, research_claim_token: null, research_claimed_at: null,
  }).eq("message_key", row.message_key).eq("research_claim_token", row.research_claim_token)
    .eq("research_status", "processing").select("message_key");
  if (error) throw error;
  if (!data?.length) throw new Error("Email intake claim was lost before completion.");
}
/** Linking and delivery opt-in are saved together so a completed run can be queued once. */
export function linkedIntakeFields(ownerId: string, projectId: string, runId: string) {
  return {
    research_status: "linked" as const,
    research_owner_id: ownerId,
    research_project_id: projectId,
    research_run_id: runId,
    auto_report_delivery_enabled: true,
    research_started_at: new Date().toISOString(),
    research_error: null,
  };
}
export async function handoffOneEmail(
  db: Admin = createAdminClient(),
  verify = verifyPayment,
  create = createProjectAndRun,
): Promise<boolean> {
  const paidIntake = env("PAID_EMAIL_INTAKE_ENABLED") === "true";
  if (!paidIntake && env("EMAIL_RESEARCH_INTAKE_ENABLED") === "false") return false;
  const { data, error } = await db.rpc("orit_claim_research_intake", { p_token: randomUUID() });
  if (error) throw error;
  if (!data || !(data as { message_key?: string | null }).message_key) return false;
  const row = data as ClaimedIntake;
  try {
    if (!paidIntake) {
      const decision = inputFromResearchEmail(row);
      if (decision.status !== "ready") {
        await finishClaim(db, row, { research_status: decision.status, research_error: decision.reason });
        return true;
      }
      const ownerId = localWorkspaceOwnerId();
      const { project, run } = await create(db, ownerId, decision.input, incomingEmailRunKey(row.message_key));
      await finishClaim(db, row, linkedIntakeFields(ownerId, project.id, run.id));
      return true;
    }
    const brief = parsePaidBrief(row.body_text || "");
    if (!brief || !authenticated(row)) {
      await finishClaim(db, row, { research_status: "needs_details", research_error: "Authenticated paid brief required." }); return true;
    }
    // Fetch live payment, including refunds/disputes, before reserving anything.
    const order = await verify(brief.paymentId, row.sender);
    const decision = inputFromEmail(row, order);
    if (decision.status !== "ready") {
      await finishClaim(db, row, { research_status: decision.status === "needs_payment" ? "needs_details" : decision.status, research_error: decision.reason }); return true;
    }
    const orders=new PaidOrders(db);
    const reserved=await orders.reserveBrief(order,row.message_key);
    if (!reserved) {
      await finishClaim(db, row, { research_status: "skipped", research_error: "This payment already belongs to another brief." }); return true;
    }
    const ownerId = localWorkspaceOwnerId();
    const { project, run } = await create(db, ownerId, decision.input, emailRunKey(order.paymentId));
    await orders.link(order.paymentId,row.message_key,project.id,run.id);
    await finishClaim(db, row, linkedIntakeFields(ownerId, project.id, run.id));
    return true;
  } catch (caught) {
    if (caught instanceof PaymentRejected) {
      await finishClaim(db, row, { research_status: "needs_details", research_error: "Whop payment is not eligible for this sender and package." }); return true;
    }
    await finishClaim(db, row, {
      research_status: row.research_attempts >= 3 ? "failed" : "pending",
      research_error: "Email research handoff is unavailable; check worker configuration.",
      research_next_attempt_at: new Date(Date.now() + 60_000 * 2 ** row.research_attempts).toISOString(),
    });
    throw new Error("Email research handoff unavailable; inspect worker configuration.");
  }
}
