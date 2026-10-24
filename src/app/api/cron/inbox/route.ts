import { validBearer } from "@/lib/outreach/http";
import { required } from "@/lib/outreach/config";
export const runtime = "nodejs";
export const maxDuration = 120;
export async function GET(request: Request) {
  if (!validBearer(request.headers.get("authorization"), process.env.CRON_SECRET)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try { const response=await fetch(required("OUTREACH_FUNCTION_URL"),{method:"POST",headers:{Authorization:request.headers.get("authorization")!,"Content-Type":"application/json"},body:JSON.stringify({action:"inbox"}),signal:AbortSignal.timeout(100000)}); return Response.json(await response.json(),{status:response.status,headers:{"Cache-Control":"no-store"}}); }
  catch { return Response.json({ error: "Inbox check failed. Check Gmail access, OpenAI settings and the hosted function; messages remain queued for retry." }, { status: 503 }); }
}
