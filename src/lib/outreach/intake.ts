import { env } from "./config";
import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import { openai } from "./openai";
import { EMAIL_INSTRUCTIONS } from "./prompts";
export const IntakeSchema = z.object({
  category: z.enum(["product_submission", "service_question", "existing_customer", "spam", "other"]),
  summary: z.string(), product_name: z.string().nullable(), product_description: z.string().nullable(),
  product_url: z.string().nullable(), target_audience: z.string().nullable(), research_question: z.string().nullable(),
  order_reference: z.string().nullable(), missing_information: z.array(z.string()),
  next_action: z.enum(["research_intake", "needs_details", "human_review", "no_action"]),
});
export type Intake = z.infer<typeof IntakeSchema>;
export type IncomingEmail = { key: string; sender: string; subject: string; text: string; receivedAt: string; attachmentNames: string[]; incomplete?: boolean; automatic?: boolean; failedRecipients?: string[] };
export function normalizeIntake(input: Intake, incomplete = false): Intake {
  const result = IntakeSchema.parse(input);
  // Do not let model-generated routing silently treat an incomplete submission as ready.
  if (result.category === "spam" || result.category === "other") result.next_action = "no_action";
  else if (result.category !== "product_submission") result.next_action = "human_review";
  else if (incomplete || !result.product_description?.trim() || !result.target_audience?.trim() || !result.research_question?.trim()) result.next_action = "needs_details";
  else result.next_action = "research_intake";
  if (result.product_url) {
    try { const url = new URL(result.product_url); if (!["http:", "https:"].includes(url.protocol)) result.product_url = null; }
    catch { result.product_url = null; }
  }
  return result;
}
export async function analyzeEmail(email: IncomingEmail): Promise<Intake> {
  const response = await openai().responses.parse({
    model: env("OPENAI_EMAIL_MODEL") || "gpt-4.1-mini", store: false,
    instructions: EMAIL_INSTRUCTIONS,
    input: JSON.stringify({ sender: email.sender, subject: email.subject.slice(0, 500), body: email.text.slice(0, 20000), attachment_names: email.attachmentNames, attachments_not_opened: true }),
    text: { format: zodTextFormat(IntakeSchema, "orit_email_intake") }, max_output_tokens: 1800,
  });
  if (!response.output_parsed) throw new Error("Email analysis did not produce an intake record");
  const intake = response.output_parsed;
  if (email.attachmentNames.length) intake.missing_information.push("Review attachments in Gmail; the agent has not read them.");
  if (email.incomplete || email.text.length > 20000) intake.missing_information.push("Review the complete email; the analyzed text was incomplete.");
  return normalizeIntake(intake, email.incomplete || email.text.length > 20000 || email.attachmentNames.length > 0);
}
