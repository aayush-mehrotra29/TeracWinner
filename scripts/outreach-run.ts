import { required } from "../src/lib/outreach/config";
import { existsSync } from "node:fs";
async function invoke(action:string,extra:Record<string,unknown>={}) {
  const response=await fetch(required("OUTREACH_FUNCTION_URL"),{method:"POST",headers:{Authorization:`Bearer ${required("CRON_SECRET")}`,"Content-Type":"application/json"},body:JSON.stringify({action,...extra}),signal:AbortSignal.timeout(145000)});
  const result=await response.json();if(!response.ok)throw new Error(`Hosted action failed (${response.status})`);return result;
}
async function main() {
  const command=process.argv[2]||"health";
  if(command==="configure") {
    const values:Record<string,string>={};
    for(const key of ["EXA_API_KEY","OPENAI_API_KEY","GMAIL_APP_PASSWORD","GMAIL_USER","OUTREACH_POSTAL_ADDRESS","EMAIL_START_DATE","OUTREACH_DAILY_LIMIT","OUTREACH_FOCUS","OPENAI_EMAIL_MODEL","OPENAI_DISCOVERY_MODEL"])if(process.env[key])values[key]=process.env[key]!;
    console.log(await invoke("configure",{values}));return;
  }
  if(command==="import") {
    const path=process.env.OUTREACH_DB_PATH||".outreach/orit.sqlite";
    if(!existsSync(path))throw new Error("Prior state database missing; do not activate without checking send history");
    const {DatabaseSync}=await import("node:sqlite");const db=new DatabaseSync(path,{readOnly:true});
    try {const snapshot=Object.fromEntries(["leads","intakes","suppressions","mail_state"].map(table=>[table,db.prepare(`SELECT * FROM ${table}`).all()]));console.log(await invoke("import",{snapshot}));}finally{db.close();}return;
  }
  if(command==="send") {const inbox=await invoke("inbox");if(inbox.busy||inbox.pending)throw new Error("Inbox sync pending");console.log(await invoke("outbound"));return;}
  const mapping:Record<string,string>={check:"health",smoke:"test",verify:"verify",discover:"discover",draft:"draft",status:"status",inbox:"inbox",enable:"enable",pause:"pause",health:"health",suppress:"suppress"};
  if(!mapping[command])throw new Error("Choose health, configure, import, smoke, discover, verify, draft, inbox, send, status, enable, pause, or suppress ADDRESS");
  console.log(JSON.stringify(await invoke(mapping[command],command==="suppress"?{email:process.argv[3]}:{}),null,2));
}
main().catch(()=>{console.error("Hosted outreach command failed; check the cloud function status. Credentials and email contents were not printed.");process.exitCode=1;});
