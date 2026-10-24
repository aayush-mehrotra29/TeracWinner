import { createAdminClient } from "@/lib/db/admin";
import { apiErrorResponse, privateJson, requireUser } from "@/lib/api/http";

type InboxRow = {
  message_key: string;
  sender: string;
  subject: string;
  received_at: string;
  body_text: string | null;
  analysis: Record<string, unknown> | null;
  research_status: string;
  research_owner_id: string | null;
  research_run_id: string | null;
  research_error: string | null;
};

type SentRow = {
  message_key: string;
  recipient: string;
  subject: string;
  body_text: string | null;
  sent_at: string;
};

function shortText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 220) : "";
}

export async function GET() {
  try {
    const user = await requireUser();
    const db = createAdminClient();
    const intakes: InboxRow[] = [];
    const sent: SentRow[] = [];
    const pageSize = 500;
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await db.from("outreach_intakes")
        .select("message_key,sender,subject,received_at,body_text,analysis,research_status,research_owner_id,research_run_id,research_error")
        .order("received_at", { ascending: false }).order("message_key", { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) throw error;
      intakes.push(...(data ?? []) as InboxRow[]);
      if (!data || data.length < pageSize) break;
    }
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await db.from("outreach_sent_messages")
        .select("message_key,recipient,subject,body_text,sent_at")
        .order("sent_at", { ascending: false })
        .order("message_key", { ascending: true }).range(offset, offset + pageSize - 1);
      if (error) throw error;
      sent.push(...(data ?? []) as SentRow[]);
      if (!data || data.length < pageSize) break;
    }
    const emails = [
      ...intakes.map((row) => {
        const analysis = row.analysis && typeof row.analysis === "object" ? row.analysis : {};
        return {
          id: row.message_key, receivedAt: row.received_at, from: row.sender,
          subject: row.subject, preview: shortText(row.body_text || analysis.summary),
          direction: "incoming", classification: shortText(analysis.category) || "unclassified",
          orderReference: shortText(analysis.order_reference) || null,
          runId: row.research_owner_id === user.id ? row.research_run_id : null,
          status: row.research_status,
          error: shortText(row.research_error) || null,
        };
      }),
      ...sent.map((row) => ({
        id: row.message_key, receivedAt: row.sent_at, from: `To: ${row.recipient}`,
        subject: row.subject || "(No subject)", preview: shortText(row.body_text),
        direction: "outgoing", classification: "outreach", orderReference: null,
        runId: null, status: "sent", error: null,
      })),
    ].sort((left, right) => right.receivedAt.localeCompare(left.receivedAt));
    return privateJson({ emails });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
