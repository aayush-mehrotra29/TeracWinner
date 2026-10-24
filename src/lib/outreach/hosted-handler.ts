import { env, setRuntimeConfig } from "./config";
import { store } from "./store";
import { boundedText, validBearer } from "./http";
import { hostedActions, hostedOutbound, hostedTest } from "./hosted";

export async function hostedHandler(request: Request): Promise<Response> {
  if(request.method!=="POST")return Response.json({error:"Method not allowed"},{status:405});
  const authorization=request.headers.get("authorization");
  if(!authorization || !/^Bearer [A-Za-z0-9_-]{32,}$/.test(authorization))return Response.json({error:"Unauthorized"},{status:401});
  try {
    const db=store();const config=await db.secrets();
    if(!validBearer(authorization,config.CRON_SECRET))return Response.json({error:"Unauthorized"},{status:401});
    setRuntimeConfig(config);
    const payload=JSON.parse(await boundedText(request,2000000));
    const action=payload.action;
    let result: unknown;
    if(action==="configure") {
      await db.rpc("orit_configure",{p_values:payload.values});
      await db.setSetting("credentials_configured","true");result={configured:true};
    }else if(action==="import")result=await db.rpc("orit_import",{p_snapshot:payload.snapshot});
    else if(action==="health")result={discoveryProvider:"exa",exaConfigured:Boolean(env("EXA_API_KEY")?.trim()),lastDiscovery:await db.setting("last_discovery"),lastDiscoveryCount:await db.setting("last_discovery_count"),lastDiscoveryError:await db.setting("last_discovery_error"),lastInboxSync:await db.setting("inbox_caught_up_at"),pendingCandidates:await db.pendingCandidates(),hosted:true,database:true,configured:await db.setting("credentials_configured")==="true",imported:await db.setting("migration_complete")==="true",deliveryEnabled:await db.setting("delivery_enabled")==="true",cloudTested:await db.setting("cloud_tested")==="true",queue:await db.summary()};
    else if(action==="test")result=await hostedTest();
    else if(action==="enable") {
      if(await db.setting("migration_complete")!=="true" || await db.setting("cloud_tested")!=="true")return Response.json({error:"Import history and verify hosted Gmail first"},{status:409});
      await db.setSetting("delivery_enabled","true");result={deliveryEnabled:true};
    }else if(action==="pause"){await db.setSetting("delivery_enabled","false");result={deliveryEnabled:false};}
    else if(action==="draft")result=await hostedOutbound(true);
    else if(action==="status")result={queue:await db.summary(),leads:await db.leads()};
    else if(action==="suppress" && typeof payload.email==="string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)){await db.suppress(payload.email,"Manually opted out");result={suppressed:true};}
    else if(typeof action==="string" && Object.hasOwn(hostedActions,action))result=await hostedActions[action as keyof typeof hostedActions]();
    else return Response.json({error:"Unknown action"},{status:400});
    return Response.json(result,{headers:{"Cache-Control":"no-store"}});
  }catch (error) {
    const code=error && typeof error==="object" && "databaseCode" in error ? String(error.databaseCode) : "STEP_FAILED";
    // Neither request bodies nor provider exceptions are logged; they can contain credentials or email content.
    const step=error && typeof error==="object" && "step" in error ? String(error.step) : undefined;
    const providerStatus=error && typeof error==="object" && "providerStatus" in error ? Number(error.providerStatus) : undefined;
    return Response.json({code,step,providerStatus,error:"Hosted outreach step failed; inspect readiness and provider access. No automatic retry of uncertain delivery."},{status:503});
  }
}
