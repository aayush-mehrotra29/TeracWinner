import { store } from "./store";
import { checkInbox } from "./mailbox";
import { discoverProspects, verifyNextCandidate } from "./prospects";
import { prepareDrafts, sendNextDraft } from "./campaign";
import { gmailClient, checkGmailConnection } from "./gmail";
import { verifySmtp, sendGmail, messageId } from "./smtp";
import { CONTACT_EMAIL } from "./config";

export async function syncHostedInbox() {
  const db=store();
  const result=await checkInbox();
  if(!result.busy) {
    await db.setSetting("inbox_pending",String(result.pending));
    if(!result.pending)await db.setSetting("inbox_caught_up_at",new Date().toISOString());
  }
  return result;
}
export async function hostedOutbound(draftOnly=false) {
  const db=store(); const owner=await db.claim("hosted-outbound",120);
  if(!owner)return {sent:0,reason:"Another outbound step is running"};
  try {
    if(draftOnly)return {drafted:await prepareDrafts(1)};
    if(await db.setting("delivery_enabled")!=="true")return {sent:0,reason:"Cloud delivery not enabled"};
    const inboxAt=await db.setting("inbox_caught_up_at");
    if(await db.setting("inbox_pending")!=="false" || !inboxAt || Date.now()-Date.parse(inboxAt)>600000)return {sent:0,reason:"Waiting for a successful recent inbox sync"};
    if((await db.leads("draft")).length)return await sendNextDraft();
    return {drafted:await prepareDrafts(1),sent:0};
  }finally{await db.release("hosted-outbound",owner);}
}
export async function hostedTest() {
  await verifySmtp();await checkGmailConnection();
  const id=messageId();
  await sendGmail(CONTACT_EMAIL,"Orit hosted email connection test","This is a connection test sent by the Orit agent running on Supabase. No prospect was contacted.",id);
  const client=gmailClient();const timer=setTimeout(()=>client.close(),20000);
  let received=false;
  try {
    await client.connect();const lock=await client.getMailboxLock("INBOX",{readOnly:true});
    try{const found=await client.search({header:{"Message-ID":id}},{uid:true});received=Boolean(found&&found.length);}finally{lock.release();}
  }finally{clearTimeout(timer);client.close();}
  if(!received)throw new Error("Connection test not yet received");
  await store().setSetting("cloud_tested","true");
  return {smtp:true,imap:true,selfTestReceived:true,hosted:true};
}
export const hostedActions={inbox:syncHostedInbox,discover:discoverProspects,verify:verifyNextCandidate,outbound:hostedOutbound};
