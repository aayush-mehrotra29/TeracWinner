# Orit email intake and outreach

The email agent from `outreach-agent` now lives on `main`. This local release uses the existing **OritApp** Supabase project (`whmjfcnwpmshzfetmufi`) for inbox records and research runs. The old branch's hosted project is separate, and its historical leads, sent mail, and opt-outs were not available to import. Outbound delivery in OritApp therefore remains disabled.

## Local email-to-research flow

1. Add the dedicated Gmail address, its Google App Password, and `EMAIL_START_DATE` to ignored `.env.local`. The password is server-only. `GMAIL_USER` should match the dedicated mailbox currently configured as `oritsoftware@gmail.com` in `src/lib/outreach/config.ts`.
2. Start `npm run dev` and `npm run worker:research`. The research worker checks Gmail Inbox and Sent about every 15 seconds, reading at most three new messages from each folder per pass. It stores classification, bounded body text, attachment names, and Gmail UID checkpoints in private OritApp tables. Reading Sent lets Home show actual outbound mail from the older hosted agent even though its database is separate.
3. The worker independently claims saved product-idea emails. A relevant readable email creates one `light_simulation` project and run using a stable hash of the Gmail message key. A restart after saving the email or creating the run retries safely.
4. Home lists collected incoming messages and actual Gmail Sent mail. Open analysis from an email row to see the saved activity, map, and report. Other messages remain visible as skipped or needing details.

The order reference is model-extracted **unverified text**. This version has no payment/order lookup. The email parser does not open attachments. If the email contains enough text, research starts without those attachments; an attachment-only or truncated message needs details. Messages in Spam, Trash, and archived folders are not scanned. Incoming mail is not marked read or deleted.

The local worker and website must stay running for automatic intake. The schedule in the bundled SQL is dormant while `outreach_settings.delivery_enabled` is false. The optional hosted Edge Function source is preserved under `supabase/functions/orit-outreach/`, but no hosted function has been configured or deployed to OritApp by this integration.

## Outbound prospecting

The port includes Exa storefront discovery, verification, saved drafts, Gmail SMTP sending, suppression, delivery reservation, and the original hosted Edge Function implementation. The sending path is disabled in OritApp until historical sent addresses and suppressions are reconciled from the previous project. Before enabling it, configure a valid business postal address, verify the Gmail connection, import historical suppression/sent records, deploy the function and its Vault secrets to OritApp, and review the sending cap. `npm run outreach:bundle` builds the function bundle. See the commands in `package.json` for hosted operations.

Prospect discovery checks official public HTTPS sites and verifies product, price, location, and contact evidence before drafting. Outbound mail requires the configured sender and postal footer. Uncertain SMTP results halt additional delivery until the saved Message-ID is checked in Gmail Sent.

## Verification

Run `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`. The inbox and handoff can be inspected in OritApp `outreach_intakes`; a linked row records its `research_project_id` and `research_run_id`. Sent mail is in `outreach_sent_messages`. The migrations `20261024205245_orit_email_agent.sql` and `20261024205953_orit_sent_mail.sql` create private email tables, guarded service-role RPCs, and the handoff claim function. Anonymous and authenticated roles have no table access.
