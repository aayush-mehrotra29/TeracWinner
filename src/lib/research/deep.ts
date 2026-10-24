import { createHash } from "node:crypto";
import { approvalFingerprint } from "../api/study";
import { IntegrationBlockedError } from "../providers/errors";
import { TeracMcp } from "../providers/terac";
import { TERAC_FIELDWORK_AVAILABLE, TERAC_FIELDWORK_UNAVAILABLE_REASON } from "./fieldwork";
import { ResearchModels } from "./models";
import { schemas } from "./schemas";
import { ResearchStore } from "./store";
import { ensureDeepStudyForm, syncTallyResponses, type TallyStudy } from "./tally";
import type { IntakeArtifact, ReportContent, ReportPoint, RunRow } from "./types";

interface Quote {
  id: string;
  amountUsd: number | null;
  currency: "USD";
  costPerParticipantUsd: number | null;
  status: string;
  providerResponse: Record<string, unknown>;
}

type HumanStudyRow = Omit<TallyStudy, "quote"> & { quote: Quote | null };

interface HumanResponseRow {
  id: string;
  provider_submission_id: string | null;
  answers: { responses?: Record<string, string>; presentationOrder?: string[]; demoRun?: boolean };
  review_status: "pending" | "accepted" | "rejected";
  provider_status: "unconfirmed" | "confirmed" | "disputed";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Read the live draft's current charge, never an old feasibility quote. */
export function draftTotalUsd(raw: Record<string, unknown>): number | null {
  const data = asRecord(raw.data);
  const rows = [asRecord(data.opportunity), data, asRecord(raw.opportunity), raw];
  for (const row of rows) {
    const pricing = asRecord(row.pricing);
    const cents = pricing.total_cost_cents ?? pricing.totalCostCents ?? row.total_cost_cents ?? row.totalCostCents;
    if (typeof cents === "number" && Number.isInteger(cents) && cents > 0) return cents / 100;
    const dollars = pricing.total_usd ?? pricing.totalUsd ?? row.total_usd ?? row.totalUsd;
    if (typeof dollars === "number" && Number.isFinite(dollars) && dollars > 0) return dollars;
  }
  return null;
}

function opportunityStatus(raw: Record<string, unknown>): string {
  const data = asRecord(raw.data);
  return String(asRecord(data.opportunity).status ?? data.status ?? asRecord(raw.opportunity).status ?? raw.status ?? "").toLowerCase();
}

export function savedAddendumMatches(
  row: { kind: string; content: unknown } | null | undefined, fingerprint: string,
): boolean {
  const content = asRecord(row?.content);
  const metadata = asRecord(content.metadata);
  return row?.kind === "human_addendum" && metadata.humanResponseFingerprint === fingerprint;
}

export function getProviderSubmissions(raw: Record<string, unknown>): Array<{ id: string; status: string; opportunityId: string | null }> {
  const nestedData = asRecord(raw.data);
  const nestedResult = asRecord(raw.result);
  const nested = Array.isArray(raw.data) ? raw.data
    : nestedData.submissions ?? nestedData.data ?? raw.submissions ?? nestedResult.submissions ?? nestedResult.data;
  if (!Array.isArray(nested)) return [];
  return nested.flatMap((item) => {
    const row = asRecord(item);
    const id = row.id ?? row.submission_id ?? row.submissionId;
    if (typeof id !== "string" || row.is_test === true || row.isTest === true ||
      String(row.participant_name ?? row.participantName ?? "").trim().toLowerCase() === "test participant") return [];
    const status = String(row.status ?? "").trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    return [{ id, status, opportunityId: typeof (row.opportunity_id ?? row.opportunityId) === "string" ? String(row.opportunity_id ?? row.opportunityId) : null }];
  });
}

export function humanAddendumDecision(studyStatus: string, acceptedCount: number, targetCount: number, providerState: string): "publish" | "pending" {
  if (studyStatus === "completed" || acceptedCount >= targetCount || ["completed", "closed", "stopped", "cancelled", "ended"].includes(providerState.toLowerCase())) return "publish";
  return "pending";
}

async function getStudy(store: ResearchStore, run: RunRow): Promise<HumanStudyRow | null> {
  const { data, error } = await store.db.from("human_studies").select("*").eq("run_id", run.id).maybeSingle();
  if (error) throw new Error(`Unable to read human study: ${error.message}`);
  return data as HumanStudyRow | null;
}

async function updateStudy(store: ResearchStore, study: HumanStudyRow, changes: Record<string, unknown>): Promise<void> {
  store.assertLease();
  const { error } = await store.db.from("human_studies").update(changes).eq("id", study.id);
  if (error) throw new Error(`Unable to update human study: ${error.message}`);
  Object.assign(study, changes);
}

async function initiateStudy(store: ResearchStore, run: RunRow, study: HumanStudyRow, terac: TeracMcp): Promise<void> {
  await updateStudy(store, study, { status: "requesting_feasibility" });
  const materials = study.materials;
  const requested = await terac.requestFeasibility({
    audience: materials.panelDescription,
    task: materials.taskDescription,
    count: study.target_count,
  });
  const quote: Quote = { id: requested.id, amountUsd: null, currency: "USD", costPerParticipantUsd: null, status: requested.status, providerResponse: requested.raw };
  await updateStudy(store, study, { quote, status: "feasibility_pending" });
  await store.eventOnce(run, "terac_quote", "terac_feasibility", { status: "pending", targetCount: study.target_count });
}

async function pollFeasibility(store: ResearchStore, run: RunRow, study: HumanStudyRow, terac: TeracMcp): Promise<void> {
  if (!study.quote?.id) throw new IntegrationBlockedError("Terac feasibility request needs manual reconciliation", "terac");
  const current = await terac.getFeasibility(study.quote.id);
  if (current.status === "RESPONDED" && Number.isFinite(current.costPerParticipant) && (current.costPerParticipant ?? 0) > 0) {
    const cost = current.costPerParticipant!;
    const quote: Quote = {
      id: study.quote.id, amountUsd: Math.round(cost * study.target_count * 100) / 100,
      currency: "USD", costPerParticipantUsd: cost, status: "RESPONDED", providerResponse: current.raw,
    };
    await updateStudy(store, study, { quote, status: "needs_approval" });
    await store.finish(run, "awaiting_approval", "terac_feasibility");
    await store.event(run, "terac_quote", "terac_feasibility", { status: "priced", quote, approvalRequired: true });
    return;
  }
  if (["LOST", "NOT_PURSUED"].includes(current.status)) throw new IntegrationBlockedError(`Terac feasibility ended as ${current.status}`, "terac");
  await store.finish(run, "awaiting_humans", "terac_feasibility");
}

async function launchApproved(store: ResearchStore, run: RunRow, study: HumanStudyRow, terac: TeracMcp): Promise<void> {
  if (!study.quote || study.quote.status !== "RESPONDED" || !study.quote.amountUsd || !study.approved_fingerprint ||
      approvalFingerprint(study.quote, study.materials) !== study.approved_fingerprint) {
    throw new IntegrationBlockedError("Terac quote or shared materials changed after owner approval", "terac");
  }
  let opportunityId = study.provider_id;
  if (!opportunityId) {
    let projectId = await store.artifact<string>(run.id, "terac", "project_id");
    if (!projectId) {
      const project = await terac.createProject(study.materials.title);
      projectId = project.id;
      await store.saveArtifact(run, "terac", "project_id", projectId);
    }
    const draft = await terac.createOpportunity({
      title: study.materials.title,
      description: study.materials.description,
      audience: study.materials.audience,
      businessType: study.materials.businessType,
      taskUrl: study.materials.taskUrl,
      feasibilityId: study.quote.id,
      count: study.target_count,
      projectId,
      screeningQuestions: study.materials.screeningQuestions,
    });
    if (draft.totalUsd === null || !Number.isFinite(draft.totalUsd) || draft.totalUsd <= 0) {
      await updateStudy(store, study, { provider_id: draft.id, status: "price_mismatch" });
      throw new IntegrationBlockedError("Terac draft price is unavailable; the draft needs manual reconciliation", "terac");
    }
    if (Math.abs(draft.totalUsd - study.quote.amountUsd) > 0.01) {
      const revisedQuote: Quote = {
        ...study.quote, amountUsd: draft.totalUsd,
        costPerParticipantUsd: Math.round(draft.totalUsd / study.target_count * 100) / 100,
        providerResponse: { feasibility: study.quote.providerResponse, draft: draft.raw },
      };
      await updateStudy(store, study, {
        provider_id: draft.id, quote: revisedQuote, status: "needs_approval",
        approved_fingerprint: null, approval_at: null,
      });
      await store.finish(run, "awaiting_approval", "terac_feasibility");
      await store.event(run, "terac_quote", "terac_feasibility", { status: "repriced", quote: revisedQuote, approvalRequired: true });
      return;
    }
    opportunityId = draft.id;
    await updateStudy(store, study, { provider_id: opportunityId, status: "draft_ready" });
  }
  // Terac has no atomic conditional launch/cost cap. Re-read the draft as close
  // as possible to launch and require a new owner approval if its total moved.
  const freshDraft = await terac.getOpportunity(opportunityId);
  const freshTotal = draftTotalUsd(freshDraft);
  if (freshTotal === null) {
    throw new IntegrationBlockedError("Terac draft has no current total; launch needs manual reconciliation", "terac");
  }
  if (Math.round(freshTotal * 100) !== Math.round(study.quote.amountUsd * 100)) {
    const revisedQuote: Quote = {
      ...study.quote, amountUsd: freshTotal,
      costPerParticipantUsd: Math.round(freshTotal / study.target_count * 100) / 100,
      providerResponse: { feasibility: study.quote.providerResponse, currentDraft: freshDraft },
    };
    await updateStudy(store, study, {
      quote: revisedQuote, status: "needs_approval", approved_fingerprint: null, approval_at: null,
    });
    await store.finish(run, "awaiting_approval", "terac_feasibility");
    await store.event(run, "terac_quote", "terac_feasibility", {
      status: "repriced", quote: revisedQuote, approvalRequired: true,
    });
    return;
  }
  const draftStatus = opportunityStatus(freshDraft);
  if (draftStatus && !["draft", "ready", "draft_ready"].includes(draftStatus)) {
    throw new IntegrationBlockedError(`Terac draft status ${draftStatus} needs reconciliation before launch`, "terac");
  }
  await updateStudy(store, study, { status: "launching" });
  await terac.launchDraft(opportunityId);
  await updateStudy(store, study, { status: "awaiting_response", launched_at: new Date().toISOString() });
  await store.finish(run, "awaiting_humans", "terac_fieldwork");
  await store.eventOnce(run, "terac_launched", "terac_fieldwork", {
    opportunityId, targetCount: study.target_count, tallyUrl: study.materials.tallyUrl,
  });
}

async function reconcileLaunching(store: ResearchStore, run: RunRow, study: HumanStudyRow, terac: TeracMcp): Promise<void> {
  if (!study.provider_id) throw new IntegrationBlockedError("Terac launch needs manual reconciliation: no opportunity ID", "terac");
  const current = await terac.getOpportunity(study.provider_id);
  const status = opportunityStatus(current);
  if (["launched", "active", "published", "recruiting", "in_progress"].includes(status)) {
    await updateStudy(store, study, { status: "awaiting_response", launched_at: study.launched_at ?? new Date().toISOString() });
    await store.finish(run, "awaiting_humans", "terac_fieldwork");
    await store.eventOnce(run, "terac_launched", "terac_fieldwork", {
      opportunityId: study.provider_id, targetCount: study.target_count, tallyUrl: study.materials.tallyUrl,
    });
    return;
  }
  throw new IntegrationBlockedError(`Terac launch state ${status || "unknown"} needs manual reconciliation; no second paid launch was attempted`, "terac");
}

const activeTeracStatuses = new Set(["in_progress", "work_review", "awaiting_review", "submitted", "completed", "approved"]);

async function reconcileResponses(store: ResearchStore, run: RunRow, study: HumanStudyRow, terac: TeracMcp): Promise<{ accepted: HumanResponseRow[]; confirmed: HumanResponseRow[] }> {
  if (!study.provider_id) throw new IntegrationBlockedError("Terac opportunity ID is missing", "terac");
  const raw = await terac.getSubmissions(study.provider_id);
  const submissions = getProviderSubmissions(raw).filter((item) => item.opportunityId === null || item.opportunityId === study.provider_id);
  const activeIds = new Set(submissions.filter((item) => activeTeracStatuses.has(item.status)).map((item) => item.id));
  // Never insert arbitrary public-form IDs: a provider match comes first, so
  // anonymous traffic cannot consume the response quota ahead of participants.
  await syncTallyResponses(store, run, study, activeIds);
  const byId = new Map(submissions.map((item) => [item.id, item]));
  const { data, error } = await store.db.from("human_responses").select("*").eq("study_id", study.id);
  if (error) throw new Error(`Unable to read human responses: ${error.message}`);
  const responses = data as HumanResponseRow[];
  const accepted: HumanResponseRow[] = [];
  const confirmedRows: HumanResponseRow[] = [];
  const approvedIds = new Set<string>();
  for (const row of responses) {
    store.assertLease();
    if (!row.provider_submission_id || row.answers?.demoRun || row.provider_submission_id.startsWith("demo_")) continue;
    const provider = byId.get(row.provider_submission_id);
    const reviewMarker = await store.artifact<string>(run.id, "terac_review", row.id);
    if (reviewMarker === "approval_requested") {
      if (provider && ["approved", "completed"].includes(provider.status)) {
        await store.saveArtifact(run, "terac_review", row.id, "approved");
      } else {
        throw new IntegrationBlockedError(`Terac approval for response ${row.id} needs manual reconciliation`, "terac");
      }
    }
    if (reviewMarker === "rejection_requested") {
      if (provider?.status === "rejected") {
        await store.saveArtifact(run, "terac_review", row.id, "rejected");
      } else {
        throw new IntegrationBlockedError(`Terac rejection for response ${row.id} needs manual reconciliation`, "terac");
      }
    }
    const confirmed = provider && activeTeracStatuses.has(provider.status);
    if (confirmed && row.provider_status !== "confirmed") {
      const { error: updateError } = await store.db.from("human_responses").update({ provider_status: "confirmed", provider_confirmed_at: new Date().toISOString() }).eq("id", row.id);
      if (updateError) throw new Error(`Unable to confirm response: ${updateError.message}`);
      row.provider_status = "confirmed";
    } else if (!confirmed && row.provider_status === "confirmed") {
      const { error: disputeError } = await store.db.from("human_responses").update({ provider_status: "disputed" }).eq("id", row.id);
      if (disputeError) throw new Error(`Unable to dispute response: ${disputeError.message}`);
      row.provider_status = "disputed";
    }
    if (!provider || row.provider_status !== "confirmed") continue;
    confirmedRows.push(row);
    if (row.review_status === "accepted" && provider.status === "awaiting_review") {
      if (!reviewMarker) {
        await store.saveArtifact(run, "terac_review", row.id, "approval_requested");
        await terac.approveSubmission(provider.id);
        await store.saveArtifact(run, "terac_review", row.id, "approved");
        approvedIds.add(provider.id);
      } else if (reviewMarker === "approved") approvedIds.add(provider.id);
    } else if (row.review_status === "rejected" && provider.status === "awaiting_review") {
      if (!reviewMarker) {
        await store.saveArtifact(run, "terac_review", row.id, "rejection_requested");
        await terac.rejectSubmission(provider.id);
        await store.saveArtifact(run, "terac_review", row.id, "rejected");
      }
    } else if (provider.status === "approved" || provider.status === "completed") {
      approvedIds.add(provider.id);
    }
    if (row.review_status === "accepted" && approvedIds.has(provider.id)) accepted.push(row);
  }
  return { accepted, confirmed: confirmedRows };
}

async function publishAddendum(
  store: ResearchStore, run: RunRow, models: ResearchModels, report: ReportContent,
  study: HumanStudyRow, accepted: HumanResponseRow[],
  saveVersion: (store: ResearchStore, run: RunRow, report: ReportContent, kind: "synthetic" | "human_addendum") => Promise<void>,
): Promise<void> {
  const fingerprint = createHash("sha256").update(JSON.stringify(accepted.map((row) => ({ id: row.id, answers: row.answers })).sort((a, b) => a.id.localeCompare(b.id)))).digest("hex");
  const { data: versions, error: versionsError } = await store.db.from("report_versions")
    .select("version,kind,content,pdf_path").eq("run_id", run.id)
    .order("version", { ascending: false }).limit(1);
  if (versionsError) throw new Error(`Unable to read report versions: ${versionsError.message}`);
  const latest = versions?.[0] ?? null;
  if (savedAddendumMatches(latest, fingerprint)) {
    // A restart can land between report persistence and the audit marker. Reuse
    // the saved version and finish its PDF rather than publishing a duplicate.
    await saveVersion(store, run, latest!.content as ReportContent, "human_addendum");
    await store.saveArtifact(run, "terac", "addendum_fingerprint", fingerprint);
    await updateStudy(store, study, { status: "completed" });
    await store.finish(run, "completed", "human_addendum");
    return;
  }
  const version = Math.max(2, Number(latest?.version ?? 1) + 1);
  const responseSummaries = accepted.map((row) => ({ id: `human:${row.id}`, answers: row.answers.responses ?? {} }));
  const result = accepted.length ? await models.ask<{ comparison: string; findings: ReportPoint[]; caveats: string[] }>({
    stage: "human_addendum", model: "gpt-6.1-sol", schemaName: "human_addendum_v1", schema: schemas.addendum,
    instructions: "Compare saved, owner-reviewed, provider-matched written responses with the FROZEN synthetic report. These are convenience-sample respondents, not a representative statistical panel. Do not infer identity verification from URL IDs. Quote no unsaved answers. Discuss agreement and disagreement; do not modify the frozen synthetic result. Cite human response IDs as provided and disclose sample size.",
    input: JSON.stringify({ syntheticReport: report, responseSummaries, targetCount: study.target_count }),
    maxOutputTokens: 2200,
  }) : { comparison: "No owner-accepted, provider-matched responses were available when fieldwork ended.", findings: [] as ReportPoint[], caveats: ["Human feedback was insufficient; the synthetic report remains unvalidated."] };
  const allowed = new Set(responseSummaries.map((item) => item.id));
  const findings = result.findings
    .filter((point) => point.evidenceIds.length > 0 && point.evidenceIds.every((id) => allowed.has(id)))
    .map((point) => ({ ...point, basis: "human" as const }));
  const omittedFindings = result.findings.length - findings.length;
  const humanSources = accepted.map((row) => ({
    id: `human:${row.id}`, responseId: row.id,
    excerpts: Object.entries(row.answers.responses ?? {}).map(([questionId, answer]) => ({ questionId, answer: String(answer).slice(0, 4000) })),
  }));
  const updated: ReportContent = {
    ...report,
    humanAddendum: {
      responses: accepted.length, comparison: result.comparison, findings, sources: humanSources,
      caveats: [
        ...result.caveats,
        "These answers were matched to Terac submission records and reviewed by the workspace owner. Hosted-form authorship cannot be independently verified from a URL submission ID.",
        ...(omittedFindings ? [`${omittedFindings} human finding(s) were omitted because they lacked valid saved response citations.`] : []),
      ],
    },
    metadata: { ...report.metadata, reportVersion: version, generatedAt: new Date().toISOString(), humanStatus: accepted.length >= study.target_count ? "complete" : "insufficient", humanResponseFingerprint: fingerprint },
  };
  await saveVersion(store, run, updated, "human_addendum");
  await store.saveArtifact(run, "terac", "addendum_fingerprint", fingerprint);
  await updateStudy(store, study, { status: "completed" });
  await store.finish(run, "completed", "human_addendum");
}

/** Establish human fieldwork before any OpenAI or synthetic research stage runs. */
export async function prepareDeepStudy(store: ResearchStore, run: RunRow): Promise<boolean> {
  if (!TERAC_FIELDWORK_AVAILABLE) throw new IntegrationBlockedError(TERAC_FIELDWORK_UNAVAILABLE_REASON, "terac");
  if (!process.env.TERAC_API_KEY) throw new IntegrationBlockedError("TERAC_API_KEY is required for Deep fieldwork", "terac");

  // Deep forms must be targeted without asking a model to infer the audience.
  // A resumed clarification supplies the audience verbatim.
  const audience = run.input.audience?.trim() || run.input.clarifications?.at(-1)?.trim();
  if (!audience) {
    await store.finish(run, "needs_input", "intake");
    await store.eventOnce(run, "needs_input", "intake", {
      questions: ["Who is the primary buyer or user for this product?"],
    });
    return false;
  }
  if (!run.input.audience) await store.setRun(run, { input: { ...run.input, audience } });

  const priorGate = await store.artifact<{ responseId: string; studyId: string }>(run.id, "deep_gate");
  if (priorGate) {
    await store.eventOnce(run, "first_human_response", "terac_fieldwork", priorGate);
    return true;
  }

  // This helper persists the hosted form metadata before any Terac opportunity
  // is drafted. On retry, it returns that same form instead of creating another.
  const study = await ensureDeepStudyForm(store, run) as HumanStudyRow;
  if (!study.materials.tallyFormId || !study.materials.tallyUrl || study.materials.taskUrl !== study.materials.tallyUrl) {
    throw new IntegrationBlockedError("Tally study form is not published with a usable task URL", "tally");
  }
  await store.eventOnce(run, "tally_form_created", "terac_fieldwork", {
    studyId: study.id, tallyFormId: study.materials.tallyFormId,
    tallyUrl: study.materials.tallyUrl, imageCount: study.materials.assetIds.length,
  });
  const terac = new TeracMcp();
  await terac.connect();
  try {
    if (study.status === "creating_form") {
      throw new IntegrationBlockedError("Tally form creation needs reconciliation before retry", "tally");
    }
    if (study.status === "awaiting_response" && !study.quote && !study.provider_id) {
      await store.transition(run, "terac_feasibility", "request", {
        studyId: study.id, tallyFormId: study.materials.tallyFormId, targetCount: study.target_count,
      }, () => initiateStudy(store, run, study, terac));
      await store.finish(run, "awaiting_humans", "terac_feasibility");
      return false;
    }
    if (study.status === "requesting_feasibility") {
      throw new IntegrationBlockedError("Terac feasibility request needs manual reconciliation before retry", "terac");
    }
    if (study.status === "feasibility_pending") {
      await store.transition(run, "terac_feasibility", "poll", { studyId: study.id, quoteId: study.quote?.id },
        () => pollFeasibility(store, run, study, terac));
      return false;
    }
    if (study.status === "needs_approval") {
      await store.finish(run, "awaiting_approval", "terac_feasibility");
      return false;
    }
    if (study.status === "approved" || study.status === "draft_ready") {
      await store.transition(run, "terac_fieldwork", "launch", {
        studyId: study.id, quote: study.quote, materials: study.materials,
      }, () => launchApproved(store, run, study, terac));
      return false;
    }
    if (study.status === "launching") {
      await store.transition(run, "terac_fieldwork", "reconcile_launch", {
        studyId: study.id, providerId: study.provider_id,
      }, () => reconcileLaunching(store, run, study, terac));
      return false;
    }
    if (["awaiting_response", "launched", "collecting", "recruiting", "completed"].includes(study.status) && study.provider_id) {
      const { confirmed } = await store.transition(run, "terac_fieldwork", "first_response_poll", {
        studyId: study.id, providerId: study.provider_id,
      }, () => reconcileResponses(store, run, study, terac));
      if (confirmed.length === 0) {
        await store.finish(run, "awaiting_humans", "terac_fieldwork");
        return false;
      }
      const gate = { responseId: confirmed[0].id, studyId: study.id };
      await store.saveArtifact(run, "deep_gate", "main", gate);
      await store.eventOnce(run, "first_human_response", "terac_fieldwork", gate);
      if (study.status === "awaiting_response") await updateStudy(store, study, { status: "collecting" });
      return true;
    }
    throw new IntegrationBlockedError(`Unknown Terac study state ${study.status}`, "terac");
  } finally {
    await terac.close();
  }
}

/** Add human feedback to a frozen synthetic report as owner reviews arrive. */
export async function advanceDeepStudy(
  store: ResearchStore, run: RunRow, models: ResearchModels,
  intake: IntakeArtifact, report: ReportContent,
  saveVersion: (store: ResearchStore, run: RunRow, report: ReportContent, kind: "synthetic" | "human_addendum") => Promise<void>,
): Promise<void> {
  void intake;
  if (!TERAC_FIELDWORK_AVAILABLE) throw new IntegrationBlockedError(TERAC_FIELDWORK_UNAVAILABLE_REASON, "terac");
  const terac = new TeracMcp();
  await terac.connect();
  try {
    const study = await getStudy(store, run);
    if (!study) throw new IntegrationBlockedError("Deep study is missing after the first response gate", "terac");
    if (["awaiting_response", "launched", "collecting", "recruiting", "completed"].includes(study.status)) {
      await store.transition(run, "terac_fieldwork", "poll", { studyId: study.id, providerId: study.provider_id, studyStatus: study.status }, async () => {
        const { accepted } = await reconcileResponses(store, run, study, terac);
        const providerOpportunity = await terac.getOpportunity(study.provider_id!);
        const providerState = opportunityStatus(providerOpportunity);
        if (humanAddendumDecision(study.status, accepted.length, study.target_count, providerState) === "publish") {
          await store.transition(run, "human_addendum", "publish", { studyId: study.id, acceptedResponseIds: accepted.map((row) => row.id) }, () => publishAddendum(store, run, models, report, study, accepted, saveVersion));
        } else {
          await store.finish(run, "awaiting_humans", "terac_fieldwork");
          const priorCount = await store.artifact<number>(run.id, "terac", "accepted_count");
          if (priorCount !== accepted.length) {
            await store.saveArtifact(run, "terac", "accepted_count", accepted.length);
            await store.event(run, "stage_completed", "terac_fieldwork", { accepted: accepted.length, target: study.target_count, pending: true });
          }
        }
      });
      return;
    }
    throw new IntegrationBlockedError(`Unknown Terac study state ${study.status}`, "terac");
  } finally {
    await terac.close();
  }
}
