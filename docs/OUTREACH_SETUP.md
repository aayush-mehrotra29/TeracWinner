# Orit hosted ecommerce outreach

The `outreach-agent` branch runs the autonomous email agent on the **orit Supabase project**. Supabase stores prospects, drafts, delivery history, Gmail checkpoints and opt-outs. Edge Functions perform the work; Postgres Cron starts scheduled steps. There is no local worker to keep running.

## Live components

- Project: https://supabase.com/dashboard/project/whruftwhzlazcahmviuy
- Function: `orit-outreach`
- Sender and read-only Inbox: **oritsoftware@gmail.com**
- Gmail SMTP uses TLS on port 465; IMAP uses TLS on port 993.
- Runtime Exa/OpenAI/Gmail credentials and the business postal address are stored in Supabase Vault, not in source code or cron SQL.
- The endpoint requires the private `CRON_SECRET` bearer token and returns no runtime secrets.

The existing organization is on Supabase's free plan. The setup uses its quotas; OpenAI model usage and Exa company-search usage use their respective API accounts and available credits. It does not require a phone provider. Hosted availability remains subject to Supabase account limits and project status.

## Ecommerce targeting

Discovery calls [Exa web search for company storefronts](https://exa.ai/docs/reference/search) with the private `EXA_API_KEY`, rotates product categories, excludes known businesses and queues up to ten new official storefronts per pass. Search results supply URLs only; contact addresses and product facts must still be verified on the website. A pool of 100 pending candidates pauses discovery until verification catches up. Each candidate is verified separately. The agent requires:

1. A public, official HTTPS business website.
2. A same-business product page with an active **Add to cart / Buy now** control and a visible price or priced Product offer.
3. A published business email found in visible website text or a mailto link. Addresses are never guessed.
4. Evidence of US location and a specific product fact, with exact supporting website quotes saved alongside the lead.

Agencies, service businesses, directories, marketplaces, missing contacts, uncertain locations and unverifiable storefronts are skipped. Product and contact URLs are saved for review. The prior email already sent before this stricter verification is retained as historical outreach and cannot be sent again.

Public website requests reject private addresses and unsafe redirects, pin the TCP connection to a checked public IP, and verify TLS against the original hostname. Supabase uses its native TCP/TLS APIs for this connection. Each page has an eight-second deadline and a two-megabyte size limit; malformed or compressed responses that violate the expected format are rejected.

Drafts mention the verified product and pose a relevant consumer research question. The offer comes from Orit's website at https://orit.dev/. The code appends Orit's postal address and a reply-to-stop notice. It avoids invented relationships, guarantees, metrics and prices.

## Cloud schedule

All scheduling happens on Supabase. The schedule expressions use UTC:

| Step | Schedule | Purpose |
| --- | --- | --- |
| Inbox | Every five minutes | Read replies, opt-outs and product inquiries |
| Outbound | Every ten minutes, two minutes after an Inbox slot | Draft one introduction or send one saved draft |
| Verification | Every five minutes | Check one candidate's product/contact evidence |
| Discovery | Every two hours at minute 17 | Find up to ten new candidates through Exa |

Separate steps keep each invocation within the free Edge Function duration. A verification step skips an unsuitable candidate. Temporary failures retry after 15 minutes, with at most three attempts; abandoned claims can be recovered after ten minutes. Expired draft evidence is skipped so it cannot block fresh prospects. A draft step does not send immediately; the following outbound step can send it.

The active campaign is configured for up to 20 introductions per rolling 24 hours, with at least five minutes between sends and no automatic follow-ups. The initial environment template defaults to five; `scripts/hosted-outreach-scale.sql` records the active schedule and cap. The configured cap can be 1–20; database RPCs independently enforce it across concurrent requests. One business domain and one recipient can have only one lead. Before sending, the contact page is checked again and a recent successful Inbox sync is required. Inbox backlog or failure pauses sending.

Incoming email data is stored in private Supabase `outreach_intakes` records: sender, subject, receipt date, up to 20,000 characters of message text, attachment names, truncation flag, structured analysis and the matching contacted business ID when available. The analysis includes product name, description, URL, target audience, research question, missing details and next action. Attachments are not opened. Earlier migrated records retain their original summaries; message text is saved for new messages only.

Any inbound contact suppresses that address from new automated introductions. Standard delivery failures suppress the failed recipient. Opt-outs are handled before AI analysis. Gmail Inbox is opened read-only: messages are not deleted or marked read. Attachments/URLs inside incoming mail are not opened. Spam/Trash/archived messages are not scanned; check those for missed opt-outs and suppress them manually as needed.

If SMTP delivery is ambiguous or a worker crashes after reserving an email, the record remains `uncertain` or `sending` and blocks further sending. Check Gmail Sent using the saved message ID before marking that exact record `sent` or `suppressed` in Supabase. Never reset an uncertain email to draft without confirming non-delivery. Gmail acceptance and a Sent record do not prove Inbox placement at the recipient.

## Manage without running an agent locally

The command-line helpers invoke the hosted function over HTTPS. They do not perform discovery, inbox processing or sending on the laptop. `.env.local` needs only `OUTREACH_FUNCTION_URL` and `CRON_SECRET` for normal operations.

```bash
npm run outreach:check                 # Cloud readiness/status
npm run outreach:status                # Hosted leads and queue
npm run outreach:discover              # Queue a cloud discovery pass
npm run outreach:verify                # Verify one candidate on Supabase
npm run outreach:draft                 # Draft on Supabase
npm run outreach:inbox                 # Sync Gmail on Supabase
npm run outreach:send                  # Cloud Inbox sync, then one outbound step
npm run outreach -- pause              # Pause cloud scheduling/delivery
npm run outreach -- enable             # Resume after required checks
npm run outreach -- suppress person@example.com
```

Keep secrets out of chat and Git. To update the sender's existing Gmail App Password, Exa key, OpenAI key, postal address, focus or cap, edit the corresponding private `.env.local` settings and run `npm run outreach:configure`; the helper transfers them to Vault over the authenticated function endpoint. The sender stays oritsoftware@gmail.com. A postal address is required for US promotional mail, including business-to-business messages: [FTC guidance](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business).

`npm run outreach:smoke` sends one non-promotional test **from Supabase to the sender's own Gmail** and confirms receipt read-only. It does not contact a prospect.

## Deployment and migration

The source is in `src/lib/outreach/`; `npm run outreach:bundle` builds `supabase/functions/orit-outreach/worker.js` with pinned npm imports. Deploy `index.ts`, `worker.js` and `deno.json` together. JWT gateway checking is disabled because the function implements its own private bearer-token authentication.

The migrations in `supabase/migrations/` create private tables, service-only RPCs and the Cron jobs. RLS is enabled and anon/authenticated roles have no table or function access. The service-role credential exists only in the hosted function environment. The optional Next.js `/outreach` dashboard additionally requires verified team sign-in, `OUTREACH_ADMIN_EMAILS`, and a private service-role key on its own hosting server; deploying that optional frontend is separate from the hosted agent.

For the initial move, the local worker was stopped. `npm run outreach:import` read the prior SQLite file once and transactionally copied its sent record, intake records, checkpoints and suppressions into Supabase. Import cannot run twice, and cloud sending cannot be enabled until import and a hosted Gmail test succeed. The ignored local SQLite file remains a backup only. Production code never falls back to it.

## Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build` and `npm run outreach:bundle` validate the repository. Live checks separately verify Supabase authentication, Exa company search from the hosted function, Gmail send/receipt, saved inbox content, state migration, storefront verification, retry backoff/caps and Cron HTTP execution. Reservation guards are also tested transactionally in Postgres with all synthetic rows rolled back.

References: [Supabase scheduling](https://supabase.com/docs/guides/functions/schedule-functions), [Edge limits](https://supabase.com/docs/guides/functions/limits), [Gmail IMAP/SMTP](https://developers.google.com/workspace/gmail/imap/imap-smtp), [Exa search API](https://exa.ai/docs/reference/search).
