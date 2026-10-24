import { localWorkspaceOwnerId } from "../lib/api/workspace-identity";
import { loadEnvConfig } from "@next/env";
import { randomUUID } from "node:crypto";
import { processResearchRun } from "../lib/research/pipeline";
import { ResearchStore } from "../lib/research/store";
import { syncHostedInbox } from "../lib/outreach/hosted";
import { syncPaidInvitations } from "../lib/outreach/paid-invitations";
import { syncSentMail } from "../lib/outreach/sent";
import { handoffOneEmail } from "../lib/outreach/research-handoff";
import { deliverOnePendingReport } from "../lib/outreach/report-outbox";
import { humanPollPage } from "./polling";

loadEnvConfig(process.cwd());

const QUEUE_VISIBILITY_SECONDS = 600;
const RUN_LEASE_SECONDS = 180;
const MAX_DELIVERIES = 3;
const POLL_INTERVAL_MS = 8_000;
// Terac MCP has no webhook. Its observed rate limit is about one request per
// minute, so polling faster delays the first matched submission behind 429s.
const HUMAN_POLL_INTERVAL_MS = 75_000;
const EMAIL_POLL_INTERVAL_MS = 15_000;
let humanPollCursor = 0;

interface ClaimedJob {
  msg_id: number;
  read_ct: number;
  message: { runId?: string };
}

async function claim(store: ResearchStore): Promise<ClaimedJob[]> {
  const { data, error } = await store.db.rpc("claim_research_jobs", {
    p_visibility_seconds: QUEUE_VISIBILITY_SECONDS,
    p_qty: 1,
  });
  if (error) throw new Error(`Unable to claim research queue: ${error.message}`);
  return (data ?? []) as ClaimedJob[];
}

async function ack(store: ResearchStore, messageId: number): Promise<void> {
  const { error } = await store.db.rpc("ack_research_job", { p_message_id: messageId });
  if (error) throw new Error(`Unable to acknowledge research queue message: ${error.message}`);
}

async function withRunLease(store: ResearchStore, runId: string, work: () => Promise<void>): Promise<boolean> {
  const owner = randomUUID();
  const acquire = async (): Promise<boolean> => {
    const { data, error } = await store.db.rpc("acquire_research_run_lease", {
      p_run_id: runId, p_owner: owner, p_ttl_seconds: RUN_LEASE_SECONDS,
    });
    if (error) throw new Error(`Unable to acquire run lease: ${error.message}`);
    return data === true;
  };
  if (!await acquire()) return false;
  let heartbeatError: Error | null = null;
  store.setLeaseGuard(() => { if (heartbeatError) throw heartbeatError; });
  const heartbeat = setInterval(() => {
    void acquire().then((held) => {
      if (!held) heartbeatError = new Error(`Run ${runId} lost its worker lease`);
    }).catch((error) => { heartbeatError = error instanceof Error ? error : new Error(String(error)); });
  }, 60_000);
  try {
    await work();
    if (heartbeatError) throw heartbeatError;
    return true;
  } finally {
    clearInterval(heartbeat);
    store.setLeaseGuard(null);
    await store.db.rpc("release_research_run_lease", { p_run_id: runId, p_owner: owner });
  }
}

async function handleJob(store: ResearchStore, job: ClaimedJob): Promise<void> {
  const runId = job.message?.runId;
  if (!runId || !/^[0-9a-f-]{36}$/i.test(runId)) {
    await ack(store, job.msg_id);
    return;
  }
  try {
    const processed = await withRunLease(store, runId, () => processResearchRun(runId, store));
    if (processed) await ack(store, job.msg_id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Research run ${runId} failed on delivery ${job.read_ct}: ${message}`);
    if (job.read_ct >= MAX_DELIVERIES) {
      const run = await store.getRun(runId);
      await store.finish(run, "failed", run.stage ?? "intake", { message });
      await store.event(run, "error", run.stage ?? "intake", { message, attempts: job.read_ct });
      await ack(store, job.msg_id);
    }
  }
}

async function pollHumanStudies(store: ResearchStore): Promise<void> {
  const page = await humanPollPage(store.db, humanPollCursor);
  humanPollCursor = page.nextCursor;
  for (const runId of page.ids) {
    try {
      await withRunLease(store, runId, () => processResearchRun(runId, store));
    } catch (caught) {
      console.error(`Deep study ${runId} poll failed: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  }
}

async function pollEmailOnce(store: ResearchStore): Promise<boolean> {
  let backlog = false;
  try { await syncPaidInvitations(); }
  catch { console.error("Paid invitation sync unavailable; check payment and worker configuration."); }
  try {
    const result = await syncHostedInbox();
    backlog = result.pending;
  } catch (error) {
    console.error(`Inbox collection failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const result = process.env.PAID_EMAIL_WORKER_ONLY === "true" ? { pending: false } : await syncSentMail();
    backlog = backlog || result.pending;
  } catch (error) {
    console.error(`Sent mail collection failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Saved intakes are scanned separately. A crash between Gmail save and run
  // creation is recovered on the next pass, even when Gmail itself is down.
  for (let index = 0; index < 20; index += 1) {
    try {
      if (!await handoffOneEmail()) break;
      backlog = true;
    } catch (error) {
      console.error(`Email research handoff failed: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }
  }
  // Sending is separate from run processing. The database queues only final
  // reports linked to newly opted-in Gmail intakes.
  for (let index = 0; index < 5; index += 1) {
    try {
      if (!await deliverOnePendingReport(store.db)) break;
      backlog = true;
    } catch (error) {
      console.error(`Report email delivery failed: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }
  }
  return backlog;
}

async function emailLoop(store: ResearchStore, shouldStop: () => boolean): Promise<void> {
  while (!shouldStop()) {
    const backlog = await pollEmailOnce(store);
    await new Promise((resolve) => setTimeout(resolve, backlog ? 1_000 : EMAIL_POLL_INTERVAL_MS));
  }
}

async function pollPaidRuns(store: ResearchStore, humans = false): Promise<void> {
  const { data, error } = await store.db.from("runs").select("id")
    .eq("owner_id", localWorkspaceOwnerId()).not("input->>paymentId", "is", null)
    .in("status", humans ? ["awaiting_humans"] : ["queued", "running"])
    .order("created_at", { ascending: true }).limit(1);
  if (error) throw new Error("Paid research queue unavailable.");
  for (const row of data || []) {
    try { await withRunLease(store, row.id, () => processResearchRun(row.id, store)); }
    catch {
      const run = await store.getRun(row.id);
      await store.finish(run, "integration_blocked", run.stage ?? "intake", { message: "Paid run needs operator review before retrying." });
    }
  }
}

async function main(): Promise<void> {
  const store = new ResearchStore();
  console.log(process.env.PAID_EMAIL_WORKER_ONLY === "true" ? "Paid email worker started; unverified email cannot start research." : "Research worker started.");
  let stopped = false;
  process.on("SIGINT", () => { stopped = true; });
  process.on("SIGTERM", () => { stopped = true; });
  void emailLoop(store, () => stopped).catch((error) => {
    console.error(`Email poller stopped: ${error instanceof Error ? error.message : String(error)}`);
  });
  let lastHumanPoll = 0;
  while (!stopped) {
    try {
      const paidOnly = process.env.PAID_EMAIL_WORKER_ONLY === "true";
      if (paidOnly) await pollPaidRuns(store);
      else {
        const jobs = await claim(store);
        for (const job of jobs) await handleJob(store, job);
      }
      if (Date.now() - lastHumanPoll >= HUMAN_POLL_INTERVAL_MS) {
        if (paidOnly) await pollPaidRuns(store, true);
        else await pollHumanStudies(store);
        lastHumanPoll = Date.now();
      }
    } catch (error) {
      console.error(`Research worker loop: ${error instanceof Error ? error.message : String(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
