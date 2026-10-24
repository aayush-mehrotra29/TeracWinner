import type { SupabaseClient } from "@supabase/supabase-js";
import { paymentId, type PaidOrder } from "./whop";

type OrderRecord = PaidOrder & { invitationStatus: "sending" | "sent" | "uncertain"; messageKey?: string; projectId?: string; runId?: string };
/** Uses the existing service-only state table in the research project. Its key
 * primary key and compare-and-set updates provide atomic cross-worker claims. */
export class PaidOrders {
  constructor(private readonly db: SupabaseClient) {}
  key(id: string) { return `orit_paid_order_v1:${paymentId(id)}`; }
  async read(id: string): Promise<{ raw: string; order: OrderRecord } | null> {
    const { data, error } = await this.db.from("outreach_settings").select("value").eq("key",this.key(id)).maybeSingle();
    if(error)throw new Error("Paid order persistence unavailable.");
    if(!data)return null;
    const order=JSON.parse(data.value) as OrderRecord;
    if(order.paymentId!==id || !["sending","sent","uncertain"].includes(order.invitationStatus))throw new Error("Invalid paid order state.");
    return {raw:data.value,order};
  }
  async reserveInvitation(order: PaidOrder): Promise<boolean> {
    const {data,error}=await this.db.from("outreach_settings").upsert({key:this.key(order.paymentId),value:JSON.stringify({...order,invitationStatus:"sending"})},{onConflict:"key",ignoreDuplicates:true}).select("key");
    if(error)throw new Error("Could not reserve paid invitation.");
    return Boolean(data?.length);
  }
  private async replace(id:string,raw:string,next:OrderRecord):Promise<boolean>{
    const {data,error}=await this.db.from("outreach_settings").update({value:JSON.stringify(next)}).eq("key",this.key(id)).eq("value",raw).select("key");
    if(error)throw new Error("Paid order update unavailable.");
    return Boolean(data?.length);
  }
  async invitationStatus(id:string,status:"sent"|"uncertain"):Promise<void>{
    const saved=await this.read(id);
    if(!saved || saved.order.invitationStatus!=="sending" || !await this.replace(id,saved.raw,{...saved.order,invitationStatus:status}))throw new Error("Invitation state could not be committed.");
  }
  async reserveBrief(order:PaidOrder,messageKey:string):Promise<boolean>{
    const saved=await this.read(order.paymentId);
    if(!saved || saved.order.invitationStatus!=="sent" || saved.order.buyerEmail!==order.buyerEmail || saved.order.planId!==order.planId || saved.order.mode!==order.mode)return false;
    if(saved.order.messageKey)return saved.order.messageKey===messageKey;
    if(await this.replace(order.paymentId,saved.raw,{...saved.order,messageKey}))return true;
    return (await this.read(order.paymentId))?.order.messageKey===messageKey;
  }
  async link(id:string,messageKey:string,projectId:string,runId:string):Promise<void>{
    const saved=await this.read(id);
    if(!saved || saved.order.messageKey!==messageKey)throw new Error("Payment reservation does not own this brief.");
    if(!await this.replace(id,saved.raw,{...saved.order,projectId,runId}))throw new Error("Paid run link could not be saved.");
  }
}
