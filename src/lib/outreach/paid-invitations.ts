import { createAdminClient } from "@/lib/db/admin";
import { localWorkspaceOwnerId } from "@/lib/api/workspace-identity";
import { env, CONTACT_EMAIL } from "./config";
import { intakeToken, paidBriefTemplate } from "./paid-brief";
import { sendGmail } from "./smtp";
import { PaymentRejected, paidOrder, verifyPayment, whopRead } from "./whop";

/** Paid-only transactional email. A sending/uncertain record is never auto-retried. */
export async function syncPaidInvitations(): Promise<void> {
  if (env("PAID_EMAIL_INTAKE_ENABLED") !== "true") return;
  localWorkspaceOwnerId(); // Refuse to invite customers until a stable chat workspace exists.
  const db = createAdminClient();
  const page = await whopRead("list");
  if (!Array.isArray(page.data)) throw new Error("Invalid Whop payment list.");
  // Initial stock is one per plan. Refuse silent truncation if that changes.
  if (page.page_info?.end_cursor) throw new Error("Whop payment backlog exceeds one page; reconcile before sending invitations.");
  for (const payment of page.data) {
    let order;
    try { order = paidOrder(payment); }
    catch (error) { if (error instanceof PaymentRejected) continue; throw error; }
    if (!env("OPENAI_API_KEY") || !env("EXA_API_KEY")) throw new Error("Research providers are not configured.");
    if (order.mode === "deep_simulation" && (!env("TALLY_API_KEY") || !env("TERAC_API_KEY"))) {
      throw new Error("Deep Simulation providers are not configured; no invitation sent.");
    }
    const fresh = await verifyPayment(order.paymentId, order.buyerEmail);
    const token = intakeToken(fresh);
    const { data: reserved, error } = await db.from("paid_research_orders").upsert({
      payment_id: fresh.paymentId, buyer_email: fresh.buyerEmail, plan_id: fresh.planId,
      mode: fresh.mode, invitation_status: "sending",
    }, { onConflict: "payment_id", ignoreDuplicates: true }).select("payment_id");
    if (error) throw error;
    if (!reserved?.length) continue;
    const subject = `Your Orit paid brief — ${fresh.name} — ${fresh.paymentId}`;
    const template = paidBriefTemplate(fresh, token);
    const compose = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(`Orit paid brief ${fresh.paymentId}`)}&body=${encodeURIComponent(template)}`;
    const body = `Whop has confirmed your ${fresh.name} payment.\n\nTo start your research, open this prefilled email:\n${compose}\n\nFill every bracketed field on a single line, keep the Payment-ID and Intake-Token unchanged, and send it from this checkout email address to ${CONTACT_EMAIL}. Do not include attachments or quoted messages.\n\nIf the link doesn't open, copy ONLY the following template into a new plain-text email:\n\n${template}\nThe private intake token is valid for 30 days. One payment starts one project at the purchased level. We recheck payment before starting; refunded, disputed, unpaid, or reused purchases cannot start another analysis.\n`;
    try {
      await sendGmail(fresh.buyerEmail, subject, body);
      const { error: saved } = await db.from("paid_research_orders").update({ invitation_status: "sent" }).eq("payment_id", fresh.paymentId);
      if (saved) throw saved;
    } catch {
      await db.from("paid_research_orders").update({ invitation_status: "uncertain" }).eq("payment_id", fresh.paymentId);
      throw new Error("Paid invitation delivery is uncertain; review Gmail Sent before retrying manually.");
    }
  }
}
