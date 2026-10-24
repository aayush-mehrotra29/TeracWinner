import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { store, type Lead, type IntakeRow } from "@/lib/outreach/store";
import { IntakeSchema } from "@/lib/outreach/intake";
import { postalAddress } from "@/lib/outreach/campaign";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata = { title: "Orit | Email outreach" };
export default async function Outreach() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) return <main style={{ maxWidth: 720, margin: "80px auto", padding: 24 }}><h1>Orit email outreach</h1><p>The email agent runs on Supabase. Configure the public Supabase keys to open the private team dashboard.</p><p>Prospects, email history and opt-outs are stored in the hosted project.</p><Link href="/">Back to sign in</Link></main>;
  const auth = await createClient(); const { data: { user } } = await auth.auth.getUser();
  if (!user) redirect("/");
  const allowed = (process.env.OUTREACH_ADMIN_EMAILS || "").toLowerCase().split(",").map(s => s.trim());
  if (!user.email_confirmed_at || !user.email || !allowed.includes(user.email.toLowerCase())) return <main style={{ padding: 48 }}><h1>Team access required</h1><p>This queue is available to the configured Orit team accounts.</p></main>;
  let leads: Lead[] = []; let records: IntakeRow[] = []; let failed = false;
  try { leads = await store().leads(); records = await store().intakes(); } catch { failed = true; }
  return <main style={{ maxWidth: 1040, margin: "64px auto", padding: "0 24px 64px" }}>
    <p style={{ color: "#0e7c5a", fontWeight: 700 }}>ORIT / EMAIL OUTREACH</p><h1 style={{ fontSize: 36, letterSpacing: "-.04em" }}>Ecommerce outreach</h1>
    <p>Find businesses, personalize from verified website facts, and send from oritsoftware@gmail.com. Replies stop future outreach.</p>
    <p><a href="https://mail.google.com/mail/?authuser=oritsoftware%40gmail.com">Open Gmail</a> · <Link href="/outreach">Refresh queue</Link> · <Link href="/">Account</Link></p>
    {!postalAddress() && <p role="status">Prospect sending is paused until the Orit business postal address is configured.</p>}
    {failed ? <p role="alert">The hosted outreach database is unavailable. Check the Supabase connection.</p> : <>
      <h2>Prospects and drafts</h2>{!leads.length && <p>No verified prospects yet.</p>}
      {leads.map(lead => <article key={lead.id} style={{ border: "1px solid #e4e4e7", borderRadius: 16, padding: 24, marginTop: 20, overflowWrap: "anywhere" }}>
        <p>{lead.status} · {lead.email}</p><h3>{lead.business}</h3><p><a href={lead.website} target="_blank" rel="noreferrer">Business website</a> · <a href={lead.contact_source} target="_blank" rel="noreferrer">Published contact source</a></p>
        <p>{lead.ecommerce_verified ? "Verified ecommerce store" : "Historical contact"}</p>{lead.product_url && <p><a href={lead.product_url} target="_blank" rel="noreferrer">Verified product page</a> · {lead.ecommerce_evidence}</p>}<p>Verified fact: {lead.fact}</p><blockquote>{lead.fact_quote}</blockquote>
        {lead.subject && <h4>{lead.subject}</h4>}{lead.body && <p style={{ whiteSpace: "pre-wrap" }}>{lead.body}</p>}{lead.error && <p role="alert">{lead.error}</p>}
      </article>)}
      <h2>Incoming email</h2>{!records.length && <p>No intake records yet.</p>}
      {records.map(record => {
        const parsed = IntakeSchema.safeParse(JSON.parse(record.analysis));
        return <article key={record.message_key} style={{ borderTop: "1px solid #e4e4e7", padding: "20px 0" }}><h3>{record.subject}</h3><p>{record.sender}</p><p>{parsed.success ? parsed.data.summary : "Review in Gmail"}</p><p>{parsed.success && parsed.data.next_action.replaceAll("_", " ")}</p></article>;
      })}
    </>}
  </main>;
}
