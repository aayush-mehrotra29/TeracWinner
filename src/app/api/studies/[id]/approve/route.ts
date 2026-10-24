import { createAdminClient } from "@/lib/db/admin";
import { ApiError, apiErrorResponse, privateJson, readJson, requireUser } from "@/lib/api/http";
import { approvalFingerprint, isLaunchedApprovalRetry } from "@/lib/api/study";
import { parseTeracOpportunity, TeracMcp } from "@/lib/providers/terac";
import { DEEP_PARTICIPANT_TARGET } from "@/lib/research/deep-config";
import { TERAC_FIELDWORK_AVAILABLE, TERAC_FIELDWORK_UNAVAILABLE_REASON } from "@/lib/research/fieldwork";

const draftStatuses = new Set(["draft", "ready", "draft_ready"]);
const launchedStatuses = new Set(["pre_recruiting", "active", "paused", "fulfilled", "completed"]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function cents(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value * 100) : null;
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (!TERAC_FIELDWORK_AVAILABLE) throw new ApiError(409, TERAC_FIELDWORK_UNAVAILABLE_REASON);
    const user = await requireUser();
    const { id } = await context.params;
    const body = await readJson(request, 1024);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError(400, "Explicit study approval is required.");
    }
    const approval = body as Record<string, unknown>;
    if (approval.approve !== true || approval.shareApproved !== true ||
      typeof approval.quoteId !== "string" || typeof approval.amountUsd !== "number" ||
      typeof approval.approvalFingerprint !== "string") {
      throw new ApiError(400, "Confirm the five-person opportunity, current total, and shared materials.");
    }

    const db = createAdminClient();
    const { data: study, error } = await db.from("human_studies").select("*")
      .eq("id", id).eq("owner_id", user.id).maybeSingle();
    if (error) throw error;
    if (!study) throw new ApiError(404, "Study not found.");
    if (study.target_count !== DEEP_PARTICIPANT_TARGET || !study.provider_id) {
      throw new ApiError(409, "A five-person Terac opportunity draft is required before approval.");
    }
    const quote = asRecord(study.quote);
    const materials = asRecord(study.materials);
    if (quote.id !== study.provider_id || typeof quote.amountUsd !== "number" ||
      quote.currency !== "USD" || cents(quote.amountUsd) === null || quote.amountUsd <= 0 ||
      Object.keys(materials).length === 0) {
      throw new ApiError(409, "Study quote or shared materials are incomplete. Refresh the opportunity.");
    }
    if (Object.hasOwn(quote, "requestedIncentiveUsd")) {
      throw new ApiError(409, "Refresh the opportunity to remove its superseded incentive estimate before approval.");
    }
    const currentFingerprint = approvalFingerprint(study.quote, study.materials);
    if (approval.quoteId !== quote.id || cents(approval.amountUsd) !== cents(quote.amountUsd) ||
      approval.approvalFingerprint !== currentFingerprint) {
      throw new ApiError(409, "Study cost or shared materials changed. Review them again.");
    }

    const { data: run, error: runError } = await db.from("runs").select("id,status,stage")
      .eq("id", study.run_id).eq("owner_id", user.id).maybeSingle();
    if (runError) throw runError;
    if (!run) throw new ApiError(404, "Research run not found.");

    const eventOnce = async (kind: string, stage: string, payload: Record<string, unknown>) => {
      const { data: prior, error: readError } = await db.from("run_events").select("seq")
        .eq("run_id", run.id).eq("owner_id", user.id).eq("kind", kind).limit(1).maybeSingle();
      if (readError) throw readError;
      if (!prior) {
        const { error: insertError } = await db.from("run_events").insert({
          run_id: run.id, owner_id: user.id, kind, stage, payload,
        });
        if (insertError) throw insertError;
      }
    };
    const ensureMonitoring = async () => {
      await eventOnce("terac_launch_requested", "terac_opportunity", {
        studyId: study.id, opportunityId: study.provider_id,
        amountUsd: quote.amountUsd, participantCount: DEEP_PARTICIPANT_TARGET,
      });
      if (run.status === "awaiting_approval" || run.status === "integration_blocked") {
        const { data: updated, error: updateError } = await db.from("runs")
          .update({ status: "awaiting_humans", stage: "terac_fieldwork", error: null })
          .eq("id", run.id).eq("owner_id", user.id).eq("status", run.status)
          .select("id").maybeSingle();
        if (updateError) throw updateError;
        if (!updated) throw new ApiError(409, "Research run changed; refresh and try again.");
        run.status = "awaiting_humans";
      } else if (!["awaiting_humans", "running", "completed"].includes(run.status)) {
        throw new ApiError(409, "Research run is not ready to monitor the opportunity.");
      }
    };
    const finalizeLaunch = async () => {
      const { data: updated, error: updateError } = await db.from("human_studies")
        .update({ status: "awaiting_response", launched_at: new Date().toISOString() })
        .eq("id", study.id).eq("owner_id", user.id).eq("status", "launching")
        .eq("approved_fingerprint", currentFingerprint)
        .select("*").maybeSingle();
      if (updateError) throw updateError;
      let confirmed = updated;
      if (!confirmed) {
        const { data: current, error: currentError } = await db.from("human_studies")
          .select("*").eq("id", study.id).eq("owner_id", user.id).maybeSingle();
        if (currentError) throw currentError;
        if (!current || !isLaunchedApprovalRetry(current, currentFingerprint)) {
          throw new ApiError(409, "Study launch state changed; refresh and reconcile it.");
        }
        confirmed = current;
      }
      await eventOnce("terac_approved", "terac_opportunity", {
        studyId: study.id, opportunityId: study.provider_id,
        amountUsd: quote.amountUsd, participantCount: DEEP_PARTICIPANT_TARGET,
      });
      return confirmed;
    };

    if (isLaunchedApprovalRetry(study, currentFingerprint)) {
      await eventOnce("terac_approved", "terac_opportunity", {
        studyId: study.id, opportunityId: study.provider_id,
        amountUsd: quote.amountUsd, participantCount: DEEP_PARTICIPANT_TARGET,
      });
      return privateJson({ study });
    }
    if (!["needs_approval", "approved", "launching"].includes(study.status)) {
      throw new ApiError(409, "This opportunity is not awaiting approval or launch reconciliation.");
    }
    if (study.status === "launching" && study.approved_fingerprint !== currentFingerprint) {
      throw new ApiError(409, "The launch request does not match the saved approval.");
    }
    if (study.status !== "launching" && run.status !== "awaiting_approval") {
      throw new ApiError(409, "This research run is not awaiting opportunity approval.");
    }

    const terac = new TeracMcp();
    try {
      await terac.connect();
      const raw = await terac.getOpportunity(study.provider_id);
      const live = parseTeracOpportunity(raw);
      if (live.id !== study.provider_id || live.participantCount !== DEEP_PARTICIPANT_TARGET) {
        throw new ApiError(409, "Terac must show this opportunity with exactly five participants.");
      }
      if (live.totalUsd === null || cents(live.totalUsd) === null || live.totalUsd <= 0) {
        throw new ApiError(409, "Terac did not return a current all-in opportunity cost.");
      }
      const liveCostPerParticipant = live.allInCostPerParticipantUsd ?? live.totalUsd / DEEP_PARTICIPANT_TARGET;
      const editorChanged = Boolean(live.draftEditorUrl && live.draftEditorUrl !== materials.draftEditorUrl);
      const priceChanged = cents(live.totalUsd) !== cents(quote.amountUsd) ||
        cents(liveCostPerParticipant) !== cents(quote.costPerParticipantUsd);
      if (priceChanged || editorChanged) {
        if (study.status === "launching") {
          throw new ApiError(409, "Terac's cost changed during launch. Reconcile this opportunity manually.");
        }
        const refreshedQuote = priceChanged ? {
          ...quote,
          amountUsd: live.totalUsd,
          costPerParticipantUsd: liveCostPerParticipant,
          providerResponse: raw,
        } : quote;
        const refreshedMaterials = editorChanged ? {
          ...materials, draftEditorUrl: live.draftEditorUrl,
        } : materials;
        const { data: refreshed, error: refreshError } = await db.from("human_studies")
          .update({ quote: refreshedQuote, materials: refreshedMaterials,
            status: "needs_approval", approved_fingerprint: null, approval_at: null })
          .eq("id", study.id).eq("owner_id", user.id).eq("updated_at", study.updated_at)
          .in("status", ["needs_approval", "approved"])
          .select("id").maybeSingle();
        if (refreshError) throw refreshError;
        if (!refreshed) throw new ApiError(409, "Study changed; refresh and try again.");
        throw new ApiError(409, "Terac's current cost or editor link changed. Review the refreshed opportunity and approve again.");
      }
      const status = live.status?.toLowerCase() ?? "";
      if (!draftStatuses.has(status) && !launchedStatuses.has(status)) {
        throw new ApiError(409, "Terac opportunity status is not a launchable draft or a confirmed launch.");
      }

      if (study.status === "launching") {
        await ensureMonitoring();
        if (launchedStatuses.has(status)) return privateJson({ study: await finalizeLaunch() });
        return privateJson({ study, launchPending: true }, 202);
      }

      // Claim the paid launch before contacting Terac. A second request that
      // sees "launching" only reads the provider; it never sends another launch.
      const { data: claimed, error: claimError } = await db.from("human_studies")
        .update({ status: "launching", approved_fingerprint: currentFingerprint,
          approval_at: new Date().toISOString() })
        .eq("id", study.id).eq("owner_id", user.id).eq("updated_at", study.updated_at)
        .in("status", ["needs_approval", "approved"])
        .select("*").maybeSingle();
      if (claimError) throw claimError;
      if (!claimed) throw new ApiError(409, "Study approval changed; refresh and try again.");
      await ensureMonitoring();

      if (draftStatuses.has(status)) {
        // A transport failure leaves the saved state as "launching". The worker
        // and later requests reconcile live status without issuing a second
        // paid launch. This favors at-most-once launch over automatic retry.
        try {
          await terac.launchDraft(study.provider_id);
        } catch (launchError) {
          console.error("Terac launch request is pending reconciliation", launchError);
          return privateJson({ study: claimed, launchPending: true }, 202);
        }
      }
      const afterRaw = await terac.getOpportunity(study.provider_id);
      const after = parseTeracOpportunity(afterRaw);
      if (after.id !== study.provider_id || after.participantCount !== DEEP_PARTICIPANT_TARGET ||
        cents(after.totalUsd) !== cents(quote.amountUsd)) {
        throw new ApiError(409, "Terac returned changed opportunity details after launch. Reconcile it manually.");
      }
      if (after.status && launchedStatuses.has(after.status.toLowerCase())) {
        return privateJson({ study: await finalizeLaunch() });
      }
      return privateJson({ study: claimed, launchPending: true }, 202);
    } finally {
      await terac.close();
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
}
