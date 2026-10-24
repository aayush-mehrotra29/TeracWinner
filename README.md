# Orit Research Studio

An email-first product research application. Eligible paid customer briefs appear on Home and start an analysis when paid intake is enabled. Each analysis has an activity timeline, inspectable research map, and report.

| Mode | Output |
| --- | --- |
| Light research | Source-backed market evidence and an evidence-only report |
| Light simulation | Research, eight hypothetical buyer contexts, sensitivity tests, an inspectable map, and a directional report |
| Deep simulation | A product-specific Tally questionnaire and five-person Terac opportunity; review Terac's actual total before launch, then research and simulation start after the first matched submission |

Synthetic counts are labeled **share of synthetic agents in this run**. They are not market share, purchase probabilities, or a representative survey. The report records sources, assumptions, model versions, and limitations. Calling and payment collection are outside this release.

## Architecture

- Next.js 16 and React provide Home, the analysis activity timeline, graph, report, and narrow API routes. This local release opens directly into the workspace without sign-in.
- A separate long-running Node worker consumes a Postgres-backed Supabase Queue. It persists stage checkpoints, run events, provider usage, graph artifacts, and report versions.
- OpenAI Responses uses `gpt-6-luna` for specialist work and `gpt-6.1-sol` for synthesis and review. Exa supplies public evidence; Solari is a selective fallback for pages Exa cannot extract. Tally MCP builds respondent forms, and Terac MCP manages the separate human study.
- One server-side local workspace identity is shared across tabs and browser sessions on this computer. Server routes use a server-only Supabase key and scope every project read and write to that identity; images and PDFs live in private Storage buckets. The development and production scripts bind to `127.0.0.1` because this release has no login screen.
- The local worker collects Gmail Inbox and Sent messages in OritApp. A retryable bridge creates one research run per verified paid customer brief. The ported outbound agent is optional and disabled until prior send and suppression history is reconciled.
- When a newly linked customer email run completes, the worker attaches the final saved PDF and sends it to that email's verified sender through the configured Gmail SMTP account. A private delivery row records queued, sent, or review-needed status; uncertain SMTP outcomes are never resent automatically. Older reports and browser-created runs are not emailed.

## Setup

Use Node.js 24.13 or newer. Install dependencies and copy the environment template:

```bash
npm ci
cp .env.example .env.local
```

This checkout is configured for the existing **OritApp** Supabase project. The `orit_research_studio` migration has been applied there, creating research tables, the queue, and private storage buckets. `.env.local` contains that project's URL and a generated workspace secret. Add the Orit project's **server-only** `sb_secret_...` or legacy `service_role` key to `SUPABASE_SERVICE_ROLE_KEY` in that file; an `sb_publishable_...` key cannot access the research tables. Keep `ORIT_WORKSPACE_SECRET` stable and private; replacing it changes the derived local workspace identity unless `ORIT_LOCAL_OWNER_ID` is set. Existing browser-cookie workspaces can be retained by setting `ORIT_LOCAL_OWNER_ID` to their saved owner UUID. Never put the service-role or provider keys in a `NEXT_PUBLIC_` variable.

Set `OPENAI_API_KEY` and `EXA_API_KEY` for live research. `SOLARI_API_KEY` enables selective browser extraction; an inaccessible page without it is recorded as an evidence gap. Deep simulation also requires `TALLY_API_KEY` and `TERAC_API_KEY` in `.env.local`. Obtain the Tally key from your Tally account's API keys; the Codex Tally plugin's OAuth connection is separate from the local worker. The worker calls Tally MCP at `https://api.tally.so/mcp` with `Authorization: Bearer <TALLY_API_KEY>`. Set `TALLY_WORKSPACE_ID` if your key has access to multiple non-personal workspaces. Set `RESEARCH_BUDGET_*_USD=0` and `RESEARCH_DAILY_RUN_LIMIT=0` for no application-level spend or daily run caps. Positive values are optional caps. Every model and provider call still records usage and estimated cost. The website and worker run on your computer, but research still calls the configured Supabase, OpenAI, Exa, Tally, and Terac services as needed. `APP_BASE_URL` is not required for this local version.

Add `GMAIL_USER` and `GMAIL_APP_PASSWORD` for the dedicated inbox to `.env.local`. The local inbox poller needs these credentials. The optional hosted outreach agent also needs its function secrets configured for OritApp; see [outreach setup](docs/OUTREACH_SETUP.md). The paid intake verifies its signed brief and payment before creating a research run. Configure the Whop credentials and `PAID_EMAIL_INTAKE_ENABLED=true` to activate it.

`RESEARCH_DAILY_RUN_LIMIT` defaults to zero (unlimited). Idempotent retries reuse the same run. Projects and pending runs are shared across local browser tabs and sessions using the same server configuration.

Run the website and worker in separate terminals:

```bash
npm run dev
npm run worker:research
```

Keep both terminals running while using the site. The worker processes queued research; web requests do not run the long simulations. The app binds to `127.0.0.1` and does not need a public deployment.

Automatic report email requires the worker to stay running, the Gmail credentials above, and an eligible email intake linked to a run. The current paid intake gate also requires its Whop configuration and `PAID_EMAIL_INTAKE_ENABLED=true`; with that gate disabled, no new customer emails create research runs. The report remains downloadable as a PDF in the workspace.

## Human feedback in the local version

Deep simulation creates a product-specific Tally form before model research starts. It includes the supplied product description, concepts, and images, plus questions about current alternatives, likely use, advantages, objections, price, and choice. Product images are presented through signed private Supabase Storage URLs that expire after 30 days; a failed image link blocks form creation rather than silently omitting the image. The form captures Terac's participant submission ID in a hidden field and redirects completed respondents to Terac's completion callback.

Orit creates a Terac opportunity draft capped at five qualified US participants and saves Terac's actual all-in total for review. The current opportunity was quoted at **$45 total for five people**; new opportunities use their own provider totals. The owner reviews the current total and the exact materials shown to participants before approving a paid launch. **Refresh Terac price** checks for changes; a changed total requires a new confirmation. Terac MCP reports the all-in opportunity total and participant count, but it has no field to set or read a separate participant payout. The app does not claim or enforce a per-person payout.

A public Tally answer alone does not unlock AI research. The worker matches a completed Tally response to a submission on the same Terac opportunity, then starts evidence gathering and synthetic simulation after the first match. Additional matched responses may later appear in a versioned human-feedback addendum. The form URL, opportunity state, answers, and report versions are saved with the run. The local Orit site needs no public deployment because participants use Tally's hosted form.

## Checks

```bash
npm run typecheck
npm run lint
npm run build
npm test
```

The repository does not contain live provider credentials or the Orit server secret key. Live smoke tests for all three modes require those to be configured locally.

On 2026-10-24, the previous research flow had one credentialed verification run per mode against OritApp. Light research saved 10 sources and a PDF; light simulation saved 11 sources, eight buyer evaluations, an analyzed image, and a PDF; the former deep flow saved 12 sources, eight evaluations with both concept orders, a PDF, and a `human_study_unavailable` event. All three reports had valid saved source IDs, and each run's recorded cost matched the sum of its model and provider call journal. Recorded costs were $0.094210, $0.212169, and $0.212781 respectively; these are app estimates or provider-reported charges, not a billing guarantee. The current Tally and Terac first-response gate has not yet had a paid participant end-to-end verification run.

After the report-review prompt update, a further credentialed light-research run completed with 12 saved sources, a reviewed report, and a PDF. Its structured report citations all resolved to saved sources, and its $0.099363 recorded cost matched the call journal. The updated review prompt was used in that run.
