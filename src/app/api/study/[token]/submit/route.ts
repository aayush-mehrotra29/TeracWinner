import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/db/admin";
import { readBoundedFormData } from "@/lib/api/bounded-form";
import { ApiError } from "@/lib/api/http";
import { studyConceptOrder } from "@/lib/study/presentation";

export const runtime = "nodejs";

interface Materials {
  concepts?: string[];
  questions?: Array<{ id: string; prompt: string }>;
}

function problem(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

function callback(submissionId: string): URL {
  const url = new URL("https://terac.com/api/external/callback");
  url.searchParams.set("teracSubmissionId", submissionId);
  url.searchParams.set("result", "completed");
  return url;
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) return problem("Study link not found.", 404);

  const tokenHash = createHash("sha256").update(token).digest("hex");
  const admin = createAdminClient();
  const { data: study, error: studyError } = await admin
    .from("human_studies")
    .select("id,owner_id,status,materials")
    .eq("response_token_hash", tokenHash)
    .maybeSingle();
  if (studyError || !study) return problem("Study link not found.", 404);
  if (!["launched", "collecting", "recruiting"].includes(study.status)) return problem("This study is not accepting responses.", 409);

  let form: FormData;
  try {
    form = await readBoundedFormData(request, 75_000);
  } catch (error) {
    return error instanceof ApiError ? problem(error.message, error.status)
      : problem("The response form could not be read.", 400);
  }
  const submissionId = form.get("teracSubmissionId");
  const taskId = form.get("taskId");
  if (typeof submissionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(submissionId)) {
    return problem("Open the study from your Terac invitation to submit feedback.", 400);
  }
  if (typeof taskId !== "string" || (taskId && !/^[A-Za-z0-9_-]{1,128}$/.test(taskId))) {
    return problem("Invalid task reference.", 400);
  }

  const materials = (study.materials ?? {}) as Materials;
  const questions = (materials.questions ?? []).filter((question) =>
    typeof question.id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(question.id)
  ).slice(0, 10);
  if (!questions.length || new Set(questions.map((question) => question.id)).size !== questions.length) {
    return problem("This study's questions are unavailable.", 409);
  }
  const responses: Record<string, string> = {};
  for (const question of questions) {
    const raw = form.get(`answer:${question.id}`);
    if (typeof raw !== "string" || !raw.trim() || raw.length > 5000) {
      return problem("Please complete each answer in 5,000 characters or fewer.", 400);
    }
    responses[question.id] = raw.trim();
  }
  const concepts = (materials.concepts ?? []).filter((concept): concept is string => typeof concept === "string").slice(0, 2);
  const presentationOrder = studyConceptOrder(study.id, submissionId, concepts);
  const demoRun = submissionId.startsWith("demo_");

  const { error } = await admin.from("human_responses").insert({
    study_id: study.id,
    owner_id: study.owner_id,
    provider_submission_id: submissionId,
    answers: { responses, presentationOrder, taskId: taskId || null, demoRun },
    review_status: demoRun ? "rejected" : "pending",
  });
  if (error?.message.includes("study_response_quota_exceeded")) {
    return problem("This study has reached its response intake limit. Please return to Terac.", 429);
  }
  if (error && error.code !== "23505") return problem("We could not save your response. Please try again.", 503);
  if (error?.code === "23505") {
    return problem("A response is already saved for this Terac submission. Return to Terac or contact the study owner if you need help.", 409);
  }

  return NextResponse.redirect(callback(submissionId), { status: 303 });
}
