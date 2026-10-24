import { createAdminClient } from "@/lib/db/admin";
import { ApiError, apiErrorResponse, privateJson, requireUser } from "@/lib/api/http";
import { approvalFingerprint } from "@/lib/api/study";
import { parseTeracOpportunity, TeracMcp } from "@/lib/providers/terac";
import { DEEP_PARTICIPANT_TARGET } from "@/lib/research/deep-config";
import { TERAC_FIELDWORK_AVAILABLE, TERAC_FIELDWORK_UNAVAILABLE_REASON } from "@/lib/research/fieldwork";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function cents(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value * 100) : null;
}

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (!TERAC_FIELDWORK_AVAILABLE) throw new ApiError(409, TERAC_FIELDWORK_UNAVAILABLE_REASON);
    const user = await requireUser();
    const { id } = await context.params;
    const db = createAdminClient();
    const { data: study, error } = await db.from("human_studies").select("*")
      .eq("id", id).eq("owner_id", user.id).maybeSingle();
    if (error) throw error;
    if (!study) throw new ApiError(404, "Study not found.");
    if (!study.provider_id || study.target_count !== DEEP_PARTICIPANT_TARGET) {
      throw new ApiError(409, "A five-person Terac opportunity draft is required before refresh.");
    }
    if (study.status !== "needs_approval" && study.status !== "approved") {
      throw new ApiError(409, "This opportunity is no longer awaiting launch confirmation.");
    }
    const quote = asRecord(study.quote);
    const materials = asRecord(study.materials);
    if (quote.id !== study.provider_id || quote.currency !== "USD" || Object.keys(materials).length === 0) {
      throw new ApiError(409, "Study quote or shared materials are incomplete.");
    }

    const terac = new TeracMcp();
    let raw: Record<string, unknown>;
    try {
      await terac.connect();
      raw = await terac.getOpportunity(study.provider_id);
    } finally {
      await terac.close();
    }
    const live = parseTeracOpportunity(raw);
    if (live.id !== study.provider_id || live.participantCount !== DEEP_PARTICIPANT_TARGET) {
      throw new ApiError(409, "Terac must show this opportunity with exactly five participants.");
    }
    if (live.totalUsd === null || cents(live.totalUsd) === null || live.totalUsd <= 0) {
      throw new ApiError(409, "Terac did not return a current all-in opportunity cost.");
    }
    const liveCostPerParticipant = live.allInCostPerParticipantUsd ?? live.totalUsd / DEEP_PARTICIPANT_TARGET;
    const priceChanged = cents(live.totalUsd) !== cents(quote.amountUsd) ||
      cents(liveCostPerParticipant) !== cents(quote.costPerParticipantUsd);
    const editorChanged = Boolean(live.draftEditorUrl && live.draftEditorUrl !== materials.draftEditorUrl);
    // Earlier drafts recorded a requested $30-per-person incentive, which the
    // provider never confirmed. Remove it when refreshing so the approval
    // fingerprint represents only the actual all-in Terac quote and materials.
    const legacyIncentive = Object.hasOwn(quote, "requestedIncentiveUsd");
    if (!priceChanged && !editorChanged && !legacyIncentive) {
      return privateJson({
        study: { ...study, approvalFingerprint: approvalFingerprint(study.quote, study.materials) },
        providerStatus: live.status,
      });
    }

    const refreshedQuote: Record<string, unknown> = {
      ...quote,
      ...(priceChanged ? {
        amountUsd: live.totalUsd,
        costPerParticipantUsd: liveCostPerParticipant,
        providerResponse: raw,
      } : {}),
    };
    delete refreshedQuote.requestedIncentiveUsd;
    const refreshedMaterials = editorChanged ? {
      ...materials, draftEditorUrl: live.draftEditorUrl,
    } : materials;
    const { data: refreshed, error: updateError } = await db.from("human_studies")
      .update({ quote: refreshedQuote, materials: refreshedMaterials,
        status: "needs_approval", approved_fingerprint: null, approval_at: null })
      .eq("id", study.id).eq("owner_id", user.id).eq("updated_at", study.updated_at)
      .in("status", ["needs_approval", "approved"])
      .select("*").maybeSingle();
    if (updateError) throw updateError;
    if (!refreshed) throw new ApiError(409, "Study changed; refresh and try again.");
    return privateJson({
      study: { ...refreshed, approvalFingerprint: approvalFingerprint(refreshed.quote, refreshed.materials) },
      providerStatus: live.status,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
