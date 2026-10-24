import { loadEnvConfig } from "@next/env";
import { createAdminClient } from "../src/lib/db/admin";
import { localWorkspaceOwnerId } from "../src/lib/api/workspace-identity";
import { whopRead } from "../src/lib/outreach/whop";
import { checkGmailConnection } from "../src/lib/outreach/gmail";
import { verifySmtp } from "../src/lib/outreach/smtp";
import { syncPaidInvitations } from "../src/lib/outreach/paid-invitations";
import { handoffOneEmail } from "../src/lib/outreach/research-handoff";
loadEnvConfig(process.cwd());
async function main() {
  const command=process.argv[2] || "check";
  if(command==="check") {
    const db=createAdminClient();
    const tables=["projects","runs","messages","outreach_intakes","outreach_settings"];
    const checks=await Promise.all(tables.map(async table=>{
      const {error}=await db.from(table).select("*",{head:true,count:"exact"});
      return {table,accessible:!error};
    }));
    const results={database:checks,workspaceIdentity:Boolean(localWorkspaceOwnerId()),
      whopReadable:Array.isArray((await whopRead("list")).data),
      openaiConfigured:Boolean(process.env.OPENAI_API_KEY),
      exaConfigured:Boolean(process.env.EXA_API_KEY),
      deepProvidersConfigured:Boolean(process.env.TALLY_API_KEY && process.env.TERAC_API_KEY),
      enabled:process.env.PAID_EMAIL_INTAKE_ENABLED==="true"};
    await checkGmailConnection(); await verifySmtp();
    console.log(JSON.stringify({...results,gmailReadable:true,smtpReady:true},null,2));
    if(checks.some(check=>!check.accessible) || !results.openaiConfigured || !results.exaConfigured)process.exitCode=1;
    return;
  }
  if(command==="invitations"){await syncPaidInvitations();console.log("Paid invitation sync completed.");return;}
  if(command==="handoff"){console.log(JSON.stringify({processed:await handoffOneEmail()}));return;}
  throw new Error("Choose check, invitations, or handoff");
}
main().catch(()=>{console.error("Paid intake readiness failed. Check private credentials, migration, Gmail and Whop access; no credentials or email contents were printed.");process.exitCode=1;});
