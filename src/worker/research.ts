import { loadEnvConfig } from "@next/env";
import { randomUUID } from "node:crypto";
import { processResearchRun } from "../lib/research/pipeline";
import { ResearchStore } from "../lib/research/store";
import { humanPollPage } from "./polling";

loadEnvConfig(process.cwd());

const QUEUE_VISIBILITY_SECONDS = 600;
const RUN_LEASE_SECONDS = 180;
const MAX_DELIVERIES = 3;
const POLL_INTERVAL_MS = 8_000;
const HUMAN_POLL_INTERVAL_MS = 5 * 60_000;
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

async function main(): Promise<void> {
  const store = new ResearchStore();
  let stopped = false;
  process.on("SIGINT", () => { stopped = true; });
  process.on("SIGTERM", () => { stopped = true; });
  let lastHumanPoll = 0;
  while (!stopped) {
    try {
      const jobs = await claim(store);
      for (const job of jobs) await handleJob(store, job);
      if (Date.now() - lastHumanPoll >= HUMAN_POLL_INTERVAL_MS) {
        await pollHumanStudies(store);
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
