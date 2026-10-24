# Whop payment and email intake

## Purchase contract

Whop remains the native checkout, card processor and receipt source. The website links to the existing Whop configurations. There is no browser checkbox or email-provided tier that authorizes research.

- `plan_EuakJxGnPAziQ` / `prod_ndQbpKRvLZmZo`: $59 USD, Light Simulation -> `light_simulation`.
- `plan_egia8RPEVQxvz` / `prod_hhi9xTjUQpmGD`: $99 USD, In Depth Simulation -> `deep_simulation`.
- Merchant: `biz_MexO0HEQnzwpZI`. Price, product, merchant, successful captured payment, buyer email, and absence of refunds/disputes must match. Discounted or non-USD purchases require manual review rather than silently granting service.

The local research worker polls native Whop payments. It rereads each candidate before sending one transactional invitation to Whop's `customer_email`. That invitation includes an HMAC token bound to the payment ID, buyer and 30-day expiry, and a prefilled plain-text brief. Sending begins only with `PAID_EMAIL_INTAKE_ENABLED=true`. This uses native Whop API reads (or the authenticated official CLI locally), not a homemade payment system. A webhook is not required for this polling design; restarts discover uninvited payments. If the paid payment list exceeds 100 entries, the worker stops inviting and requires backlog reconciliation instead of silently dropping orders.

The inbound email must have Gmail DMARC authentication recorded by the trusted collector in `analysis._sender_authenticated`, the exact paid buyer address, the signed token and the strict ORIT-PAID-BRIEF/1 format. Quoted receipts, screenshots, attachments, missing fields and model-extracted order references do not authorize a run. Email content is not evaluated as authorization. Product and research text remains untrusted input to the existing bounded research pipeline.

Anyone can email a public address; enforcement happens before accepting the brief or starting agents. A direct visit to `/start` cannot authorize research or generate an intake token. Generic contact email is separate from paid fulfillment.

## Duplicate and refund handling

A private `outreach_settings` row with the prefix `orit_paid_order_v1:` reserves each payment. The existing primary key prevents duplicate invitation creation, and compare-and-set updates bind a payment to one brief even across concurrent workers. The project/run idempotency key is derived from the payment ID, so retrying a worker cannot create a second paid project. A second email with the same purchase is held, even when it has a new Gmail message ID. The purchased mode is checked again before executing a queued run and before each model request; a refund, dispute or API outage blocks further research. Refunds cannot undo analysis already delivered.

SMTP and database cannot share a transaction. Invitations are reserved as `sending` before SMTP. A failed or uncertain send is never retried automatically. Inspect Gmail Sent and the private order row before manually reconciling it. Tokens expire in 30 days; an operator may reissue only for the same unused, still-paid order. Do not change the signing secret without planning for outstanding invitations.

## Setup and operations

1. Use the existing research project and its private `outreach_settings`, `outreach_intakes`, chat and run tables. Paid authorization state uses a reserved key namespace and requires no new schema in that project. The separately hosted outreach inbox project remains separate. The SQL installed there during setup is not a replacement for the research project and is not used as the research worker's chat database.
2. Configure this project's actual Supabase server key, stable workspace secret, Gmail app password and OpenAI/Exa credentials. Use a least-privilege Whop read key or set `WHOP_USE_CLI=true` only on the trusted local machine where `whop login` is configured. No Whop credentials enter browser bundles.
3. Deep Simulation also requires Tally and Terac worker credentials and retains the existing human-study approval checks. A customer purchase does not authorize arbitrary recruitment spending.
4. Run `npm run paid-intake:check`. Do not enable intake until the relevant mode's providers, schema and mailbox checks pass.
5. The local worker collects authenticated Gmail messages directly into the research project. A hosted collector in a different Supabase project cannot authorize or create its research runs. The separately hosted collector was updated during setup, but its database is not read by this worker.
6. Set `PAID_EMAIL_INTAKE_ENABLED=true` and run `npm run worker:paid-email` from main. The paid-email worker sends invitations, collects mail, creates the chat project and runs the purchased research. Its paid-only mode only collects mail containing the paid-brief marker and does not consume unrelated manual research jobs. The existing general worker remains available separately. Keep it running under the deployment's process manager. The CLI fallback requires the same user's working Whop login and PATH.

Do not test the live flow by charging a real card. Tests cover amount/plan tampering, spoofed senders, token changes/expiry, incomplete briefs, unsafe URLs and replay. A paid sandbox transaction with separate sandbox product IDs is still needed to verify a complete real purchase/email/agent cycle without charging a customer.
