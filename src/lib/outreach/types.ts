import type { IncomingEmail, Intake } from "./intake";
export type Lead = {
  id: number; domain: string; business: string; website: string; email: string;
  contact_source: string; fact: string; fact_quote: string; country_evidence: string;
  sources: string; verified_at: string; status: string; subject: string | null;
  body: string | null; message_id: string | null; sent_at: string | null; error: string | null;
  ecommerce_verified?: boolean; product_url?: string | null; ecommerce_evidence?: string | null;
};
export type NewLead = Omit<Lead, "id" | "status" | "subject" | "body" | "message_id" | "sent_at" | "error">;
export type IntakeRow = { message_key: string; sender: string; subject: string; created_at: string; analysis: string };
type Result<T> = T | Promise<T>;
export interface OutreachRepository {
  claim(key: string, seconds?: number): Result<string | null>;
  release(key: string, owner: string): Result<void>;
  exists(key: string): Result<boolean>;
  saveIntake(email: IncomingEmail, intake: Intake): Result<void>;
  intakes(): Result<IntakeRow[]>;
  checkpoint(key: string): Result<number>;
  advance(key: string, uid: number): Result<void>;
  setting(key: string): Result<string | undefined>;
  setSetting(key: string, value: string): Result<void>;
  isSuppressed(email: string): Result<boolean>;
  suppress(email: string, reason: string): Result<void>;
  recordReply(email: string): Result<void>;
  addLead(lead: NewLead): Result<boolean>;
  leads(status?: string): Result<Lead[]>;
  domains(): Result<string[]>;
  draft(id: number, subject: string, body: string): Result<void>;
  reserve(id: number, messageId: string, dailyLimit: number, spacingMs: number): Result<boolean>;
  finish(id: number, status: "sent" | "uncertain"): Result<void>;
  summary(): Result<unknown[]>;
}
