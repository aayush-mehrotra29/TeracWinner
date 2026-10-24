import { env } from "./config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { required } from "./config";
import type { IncomingEmail, Intake } from "./intake";
import type { OutreachRepository, NewLead, Lead, IntakeRow } from "./types";
export type { OutreachRepository, NewLead, Lead, IntakeRow } from "./types";

function fail(error: unknown) { if (error) throw new Error("Hosted outreach database operation failed"); }
export class SupabaseStore implements OutreachRepository {
  constructor(readonly client: SupabaseClient) {}
  async rpc<T>(name: string, parameters: Record<string, unknown> = {}): Promise<T> {
    const { data, error } = await this.client.rpc(name, parameters); if(error)throw Object.assign(new Error("Hosted database RPC failed"),{databaseCode:error.code}); return data as T;
  }
  async claim(key: string, seconds = 180) { const owner = randomUUID(); return await this.rpc<boolean>("orit_claim", { p_key: key, p_owner: owner, p_seconds: seconds }) ? owner : null; }
  async release(key: string, owner: string) { await this.rpc("orit_release", { p_key: key, p_owner: owner }); }
  async exists(key: string) { const { data, error } = await this.client.from("outreach_intakes").select("message_key").eq("message_key", key).maybeSingle(); fail(error); return Boolean(data); }
  async saveIntake(email: IncomingEmail, intake: Intake) {
    const { data: lead, error: lookupError } = await this.client.from("outreach_leads").select("id").eq("email", email.sender.toLowerCase()).maybeSingle(); fail(lookupError);
    const { error } = await this.client.from("outreach_intakes").upsert({ body_text: email.text.slice(0,20000), body_incomplete: Boolean(email.incomplete || email.text.length>20000), attachment_names: email.attachmentNames.slice(0,50).map(name=>name.slice(0,200)), lead_id: lead?.id ?? null, message_key: email.key, sender: email.sender.slice(0,500), subject: email.subject.slice(0,500), received_at: email.receivedAt, analysis: { ...intake, _sender_authenticated: Boolean(email.senderAuthenticated) } }, { onConflict: "message_key", ignoreDuplicates: true }); fail(error);
  }
  async intakes(): Promise<IntakeRow[]> { const { data, error } = await this.client.from("outreach_intakes").select("message_key,sender,subject,created_at,analysis").order("created_at",{ascending:false}).limit(50); fail(error); return (data || []).map(row => ({ ...row, analysis: JSON.stringify(row.analysis) })); }
  async checkpoint(key: string) { const { data, error } = await this.client.from("outreach_mail_state").select("last_uid").eq("key",key).maybeSingle(); fail(error); return Number(data?.last_uid || 0); }
  async advance(key: string, uid: number) { await this.rpc("orit_advance", { p_key: key, p_uid: uid }); }
  async setting(key: string) { const { data, error } = await this.client.from("outreach_settings").select("value").eq("key",key).maybeSingle(); fail(error); return data?.value as string | undefined; }
  async setSetting(key: string, value: string) { const { error } = await this.client.from("outreach_settings").upsert({ key, value }); fail(error); }
  async isSuppressed(email: string) { const { data,error } = await this.client.from("outreach_suppressions").select("email").eq("email",email.toLowerCase()).maybeSingle(); fail(error); return Boolean(data); }
  async suppress(email: string, reason: string) { await this.rpc("orit_suppress", { p_email: email.toLowerCase(), p_reason: reason, p_reply: false }); }
  async recordReply(email: string) { await this.rpc("orit_suppress", { p_email: email.toLowerCase(), p_reason: "Inbound message; stop automated outreach", p_reply: true }); }
  async addLead(lead: NewLead) {
    if (!lead.ecommerce_verified || !lead.product_url || !lead.ecommerce_evidence || await this.isSuppressed(lead.email)) return false;
    const { error } = await this.client.from("outreach_leads").insert({ ...lead, email: lead.email.toLowerCase() });
    if (error?.code === "23505") return false; fail(error); return true;
  }
  async leads(status?: string): Promise<Lead[]> { let query = this.client.from("outreach_leads").select("*"); if (status) query = query.eq("status",status); const {data,error} = await query.order("id",{ascending:Boolean(status)}).limit(50); fail(error); return (data || []) as Lead[]; }
  async domains(): Promise<string[]> {
    const results=await Promise.all(["outreach_leads","outreach_candidates"].map(table=>this.client.from(table).select("domain").order("id",{ascending:false}).limit(500)));
    for(const result of results)fail(result.error);
    return [...new Set(results.flatMap(result=>(result.data||[]).map(row=>String(row.domain))))];
  }
  async draft(id: number, subject: string, body: string) { const {error}=await this.client.from("outreach_leads").update({subject,body,status:"draft"}).eq("id",id).eq("status","queued").eq("ecommerce_verified",true); fail(error); }
  async reserve(id: number, messageId: string, dailyLimit: number, spacingMs: number) { return this.rpc<boolean>("orit_reserve",{p_id:id,p_message_id:messageId,p_daily_limit:dailyLimit,p_spacing_ms:spacingMs}); }
  async finish(id: number, status: "sent" | "uncertain") { const {error}=await this.client.from("outreach_leads").update({status,error:status==="uncertain"?"Delivery uncertain; check Gmail Sent before resolving. Automatic sending paused.":null}).eq("id",id).eq("status","sending"); fail(error); }
  async summary() { return this.rpc<unknown[]>("orit_summary"); }
  async enqueue(candidates: {name:string;website:string;domain:string}[], provider="openai") {
    let added=0;
    for (const candidate of candidates) { const {data,error}=await this.client.from("outreach_candidates").upsert({...candidate,discovery_provider:provider},{onConflict:"domain",ignoreDuplicates:true}).select("id"); fail(error); added+=data?.length || 0; }
    return added;
  }
  async pendingCandidates() { const {count,error}=await this.client.from("outreach_candidates").select("id",{count:"exact",head:true}).in("status",["pending","processing"]); fail(error); return count || 0; }
  async candidate() { return this.rpc<{id:number;website:string;attempts:number} | null>("orit_candidate"); }
  async finishCandidate(id:number,status:"verified"|"skipped"|"retry") { await this.rpc("orit_finish_candidate",{p_id:id,p_outcome:status}); }
  async secrets() { return this.rpc<Record<string,string>>("orit_runtime_secrets"); }
}
let cached: SupabaseStore | undefined;
export function store() {
  return cached ??= new SupabaseStore(createClient(env("SUPABASE_URL") || required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth:{persistSession:false,autoRefreshToken:false}, global:{ fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(10000)}) } }));
}
