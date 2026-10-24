import { createHash, randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/db/admin";
import { localWorkspaceOwnerId } from "@/lib/api/workspace-identity";
import { createProjectAndRun } from "@/lib/api/research";
import { parseResearchInput, type ResearchInput } from "@/lib/api/validation";
import { IntakeSchema, type Intake } from "./intake";

type Admin = ReturnType<typeof createAdminClient>;

export type ClaimedIntake = {
  message_key: string;
  sender: string;
  subject: string;
  body_text: string | null;
  body_incomplete: boolean;
  attachment_names: unknown;
  received_at: string;
  analysis: unknown;
  research_attempts: number;
  research_claim_token: string;
};

/** Stable across worker restarts, while remaining below the API's 128-character key cap. */
export function emailRunKey(messageKey: string): string {
  return `email:${createHash("sha256").update(messageKey).digest("hex")}`;
}

export function inputFromEmail(row: ClaimedIntake):
  | { status: "ready"; input: ResearchInput }
  | { status: "needs_details" | "skipped"; reason: string } {
  const parsed = IntakeSchema.safeParse(row.analysis);
  if (!parsed.success) return { status: "needs_details", reason: "Saved email classification is incomplete." };
  const intake: Intake = parsed.data;
  if (intake.category !== "product_submission") {
    return { status: "skipped", reason: `Email classified as ${intake.category}.` };
  }
  if (row.body_incomplete) {
    return { status: "needs_details", reason: "Email body was truncated; inspect the original message." };
  }
  const description = (intake.product_description || row.body_text || "").trim();
  if (description.length < 8) {
    return { status: "needs_details", reason: "Product details are missing from the readable email text." };
  }
  const question = intake.research_question?.trim() || "Where is this product promising, where does it fall short, and what should be tested next?";
  const idea = [intake.product_name?.trim(), description, `Research decision: ${question}`]
    .filter(Boolean).join("\n\n").slice(0, 12000);
  const audience = intake.target_audience?.trim() || "US consumers (broad default; sender did not specify an audience)";
  const base = { idea, mode: "light_simulation", concepts: [], urls: [], imageAssetIds: [], audience };
  const candidateUrl = intake.product_url?.trim();
  if (candidateUrl) {
    try { return { status: "ready", input: parseResearchInput({ ...base, urls: [candidateUrl] }) }; }
    catch { /* The untrusted URL is omitted; the text-only analysis can proceed. */ }
  }
  return { status: "ready", input: parseResearchInput(base) };
}

async function finishClaim(
  db: Admin, row: ClaimedIntake, fields: Record<string, unknown>,
): Promise<void> {
  const { data, error } = await db.from("outreach_intakes").update({
    ...fields, research_claim_token: null, research_claimed_at: null,
  }).eq("message_key", row.message_key).eq("research_claim_token", row.research_claim_token)
    .eq("research_status", "processing").select("message_key");
  if (error) throw error;
  if (!data?.length) throw new Error("Email intake claim was lost before completion.");
}

/** Claims one saved email and links it to one queued run; safe to call repeatedly. */
export async function handoffOneEmail(db: Admin = createAdminClient()): Promise<boolean> {
  const claimToken = randomUUID();
  const { data, error } = await db.rpc("orit_claim_research_intake", { p_token: claimToken });
  if (error) throw error;
  // PostgREST serializes a null composite as an object with null fields.
  if (!data || !(data as { message_key?: string | null }).message_key) return false;
  const row = data as ClaimedIntake;
  const decision = inputFromEmail(row);
  if (decision.status !== "ready") {
    await finishClaim(db, row, {
      research_status: decision.status,
      research_error: decision.reason,
      research_next_attempt_at: new Date().toISOString(),
    });
    return true;
  }
  try {
    const ownerId = localWorkspaceOwnerId();
    const { project, run } = await createProjectAndRun(db, ownerId, decision.input,
      emailRunKey(row.message_key));
    await finishClaim(db, row, {
      research_status: "linked", research_owner_id: ownerId,
      research_project_id: project.id, research_run_id: run.id,
      research_started_at: new Date().toISOString(), research_error: null,
    });
    return true;
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    const exhausted = row.research_attempts >= 3;
    await finishClaim(db, row, {
      research_status: exhausted ? "failed" : "pending",
      research_error: message.slice(0, 500),
      research_next_attempt_at: new Date(Date.now() + Math.min(60_000 * 2 ** row.research_attempts, 10 * 60_000)).toISOString(),
    });
    throw caught;
  }
}
