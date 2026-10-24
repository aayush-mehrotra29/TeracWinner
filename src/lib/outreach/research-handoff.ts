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
function authenticated(row: ClaimedIntake): boolean {
  const analysis=row.analysis as Record<string,unknown> | null;
  return row.sender_authenticated===true || analysis?._sender_authenticated===true;
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
export async function handoffOneEmail(db: Admin = createAdminClient(), verify = verifyPayment): Promise<boolean> {
  if (env("PAID_EMAIL_INTAKE_ENABLED") !== "true") return false;
  const { data, error } = await db.rpc("orit_claim_research_intake", { p_token: randomUUID() });
  if (error) throw error;
  if (!data || !(data as { message_key?: string | null }).message_key) return false;
  const row = data as ClaimedIntake;
  try {
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
    const { project, run } = await createProjectAndRun(db, ownerId, decision.input, emailRunKey(order.paymentId));
    await orders.link(order.paymentId,row.message_key,project.id,run.id);
    await finishClaim(db, row, {
      research_status: "linked", research_owner_id: ownerId, research_project_id: project.id,
      research_run_id: run.id, research_started_at: new Date().toISOString(), research_error: null,
    });
    return true;
  } catch (caught) {
    if (caught instanceof PaymentRejected) {
      await finishClaim(db, row, { research_status: "needs_details", research_error: "Whop payment is not eligible for this sender and package." }); return true;
    }
    await finishClaim(db, row, {
      research_status: row.research_attempts >= 3 ? "failed" : "pending",
      research_error: "Paid intake is unavailable; no additional run authorized. Check worker configuration.",
      research_next_attempt_at: new Date(Date.now() + 60_000 * 2 ** row.research_attempts).toISOString(),
    });
    throw new Error("Paid email handoff unavailable; inspect worker configuration.");
  }
}
