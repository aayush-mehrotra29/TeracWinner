import { createAdminClient } from "@/lib/db/admin";
import { ApiError, apiErrorResponse, privateJson, readJson, requireUser } from "@/lib/api/http";
import { createRun, idempotencyKey, ownedProject } from "@/lib/api/research";
import { parseMessage } from "@/lib/api/validation";
import { answerReportQuestion } from "@/lib/research/followup";
import { IntegrationBlockedError } from "@/lib/providers/errors";
import { groundedFallback } from "@/lib/api/followup";
import {
  assertMatchingFollowupRequest, assertMatchingSavedFollowupRun,
  followupRequestFingerprint, followupRunInput, parseFollowupOptions,
} from "@/lib/api/followup-input";
import { saveFollowupMessages } from "@/lib/api/followup-messages";
import {
  isClarificationMessage, resumeClarification, resumeNewClarification, saveClarificationMessage,
} from "@/lib/api/followup-clarification";
import type { ReportContent } from "@/lib/research/types";

function newRunAnswer(status: string, hasUpdatedInputs: boolean): string {
  if (hasUpdatedInputs) {
    return status === "integration_blocked"
      ? "Your new research run is blocked by a required integration. Your updated inputs are saved with that run."
      : "A new research run has started with your updated inputs. Its saved findings will appear here when ready.";
  }
  return status === "integration_blocked"
    ? "This question needs new research. The new run is blocked by a required integration."
    : "This question needs new evidence. A versioned research run has started; its saved findings will appear here when ready.";
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    const body = await readJson(request);
    const content = parseMessage(body);
    const options = parseFollowupOptions(body);
    const requestFingerprint = followupRequestFingerprint(content, options);
    const requestKey = idempotencyKey(request, body);
    const db = createAdminClient();
    const project = await ownedProject(db, id, user.id);
    const ensureRunMessages = async (run: { id: string; status: string }) => {
      const pair = await saveFollowupMessages(db, {
        projectId: id, ownerId: user.id, runId: run.id, requestKey, content, requestFingerprint,
        answer: newRunAnswer(run.status, options.startsNewRun), answerCitations: [],
      });
      return { ...pair, run };
    };
    const { data: priorMessages, error: priorError } = await db.from("messages").select("*")
      .eq("owner_id", user.id).eq("idempotency_key", requestKey);
    if (priorError) throw priorError;
    const priorUser = priorMessages?.find((message) => message.role === "user");
    if (priorUser) {
      if (priorUser.project_id !== id) throw new ApiError(409, "Idempotency key belongs to another project.");
      if (priorUser.content !== content) throw new ApiError(409, "Idempotency key belongs to another message.");
      const savedFingerprint = Array.isArray(priorUser.citations)
        ? priorUser.citations.find((value: unknown) => typeof value === "string" && value.startsWith("followup-request-sha256:"))
        : undefined;
      assertMatchingFollowupRequest(savedFingerprint, requestFingerprint, options.startsNewRun);
      const priorAnswer = priorMessages?.find((message) => message.role === "assistant") ?? null;
      const { data: priorRun, error: priorRunError } = await db.from("runs").select("*")
        .eq("id", priorUser.run_id).eq("owner_id", user.id).maybeSingle();
      if (priorRunError) throw priorRunError;
      if (priorRun && priorRun.project_id !== id) throw new ApiError(409, "Idempotency key belongs to another project.");
      let clarification = isClarificationMessage(priorUser);
      if (!clarification && !priorAnswer && priorRun && priorRun.idempotency_key !== requestKey &&
        !options.startsNewRun) {
        // Older clarification messages have no marker. The per-message archive
        // identifies them after completion; a run without a report cannot have
        // answered a grounded follow-up either.
        const { data: archive, error: archiveError } = await db.from("run_artifacts")
          .select("id").eq("run_id", priorRun.id).eq("owner_id", user.id)
          .eq("kind", "intake").eq("key", `before-clarification-${priorUser.id}`).maybeSingle();
        if (archiveError) throw archiveError;
        if (archive) clarification = true;
        else {
          const { data: existingReports, error: existingReportsError } = await db.from("report_versions")
            .select("id").eq("run_id", priorRun.id).eq("owner_id", user.id).limit(1);
          if (existingReportsError) throw existingReportsError;
          clarification = !existingReports?.length;
        }
      }
      if (priorRun && clarification) {
        if (options.startsNewRun) {
          throw new ApiError(409, "Answer the requested clarification before adding sources, images, or changing the mode.");
        }
        const resumed = await resumeClarification(db, {
          projectId: id, ownerId: user.id, runId: priorRun.id, message: priorUser,
        });
        return privateJson({ message: priorUser, run: resumed, answer: null });
      }
      if (!priorAnswer && priorRun?.idempotency_key === requestKey) {
        assertMatchingSavedFollowupRun(priorRun.input, requestFingerprint);
        return privateJson(await ensureRunMessages(priorRun));
      }
      return privateJson({ message: priorUser, answer: priorAnswer, run: priorRun });
    }
    const { data: savedRun, error: savedRunError } = await db.from("runs").select("*")
      .eq("owner_id", user.id).eq("idempotency_key", requestKey).maybeSingle();
    if (savedRunError) throw savedRunError;
    if (savedRun) {
      if (savedRun.project_id !== id) throw new ApiError(409, "Idempotency key belongs to another project.");
      assertMatchingSavedFollowupRun(savedRun.input, requestFingerprint);
      return privateJson(await ensureRunMessages(savedRun));
    }
    const { data: latest, error: runError } = await db.from("runs").select("*")
      .eq("project_id", id).eq("owner_id", user.id)
      .order("version", { ascending: false }).limit(1).maybeSingle();
    if (runError) throw runError;
    if (!latest) throw new ApiError(409, "Start a research run first.");

    if (latest.status === "needs_input") {
      if (options.startsNewRun) {
        throw new ApiError(409, "Answer the requested clarification before adding sources, images, or changing the mode.");
      }
      const { message, created } = await saveClarificationMessage(db, {
        projectId: id, ownerId: user.id, runId: latest.id, requestKey,
        content, requestFingerprint,
      });
      const resumed = await resumeNewClarification(db, {
        projectId: id, ownerId: user.id, runId: latest.id, message, created,
      });
      return privateJson({ message, run: resumed, answer: null });
    }

    const { data: report, error: reportError } = await db.from("report_versions").select("*")
      .eq("run_id", latest.id).eq("owner_id", user.id)
      .order("version", { ascending: false }).limit(1).maybeSingle();
    if (reportError) throw reportError;
    if (!report) throw new ApiError(409, "The report is not ready for follow-up questions.");

    let result;
    let newRun = null;
    if (options.startsNewRun) {
      const input = followupRunInput(latest.input, project.idea, options, content, requestFingerprint);
      newRun = await createRun(db, user.id, id, input, requestKey);
      result = {
        answer: newRunAnswer(newRun.status, true),
        citations: [],
      };
    } else {
      try {
        result = await answerReportQuestion({
          question: content,
          report: report.content as ReportContent,
          runId: latest.id,
          ownerId: user.id,
        });
      } catch (error) {
        if (!(error instanceof IntegrationBlockedError)) throw error;
        result = groundedFallback(content, report.content as ReportContent);
      }
      if (result.requiresNewResearch) {
        const input = followupRunInput(latest.input, project.idea, options, content, requestFingerprint);
        try {
          newRun = await createRun(db, user.id, id, input, requestKey);
          result = {
            ...result,
            answer: newRunAnswer(newRun.status, false),
            citations: [],
          };
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          result = { ...result, answer: `This question needs new research. I could not start a new run: ${error.message}`, citations: [] };
        }
      }
    }
    const { message, answer } = await saveFollowupMessages(db, {
      projectId: id, ownerId: user.id, runId: newRun?.id ?? latest.id,
      requestKey, content, requestFingerprint,
      answer: result.answer, answerCitations: result.citations,
      reportVersion: newRun ? null : report.version,
    });
    return privateJson({ message, answer, run: newRun });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
