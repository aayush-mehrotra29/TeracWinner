import { verifyPayment } from "../outreach/whop";
import { IntegrationBlockedError } from "../providers/errors";
import { renderReportPdf } from "../report/pdf";
import { ResearchModels } from "./models";
import { ResearchStore } from "./store";
import { advanceDeepStudy, prepareDeepStudy } from "./deep";
import {
  buildReport, runContexts, runDiscussion, runEvaluations, runEvidence, runIntake,
  runSensitivities, runSynthesis, runWorld,
} from "./stages";
import type { ReportContent, RunRow } from "./types";

export async function saveReportVersion(store: ResearchStore, run: RunRow, report: ReportContent, kind: "synthetic" | "human_addendum"): Promise<void> {
  const version = report.metadata.reportVersion;
  const { data: existing, error: readError } = await store.db.from("report_versions")
    .select("id,pdf_path").eq("run_id", run.id).eq("version", version).maybeSingle();
  if (readError) throw new Error(`Unable to inspect report version: ${readError.message}`);
  if (!existing) {
    const { error } = await store.db.from("report_versions").insert({
      run_id: run.id, owner_id: run.owner_id, version, kind, content: report,
    });
    if (error) throw new Error(`Unable to save report version: ${error.message}`);
  }
  if (!existing?.pdf_path) {
    const bytes = await renderReportPdf(report);
    const path = `${run.owner_id}/${run.id}/v${version}.pdf`;
    const { error: uploadError } = await store.db.storage.from("research-reports")
      .upload(path, Buffer.from(bytes), { contentType: "application/pdf", upsert: true });
    if (uploadError) throw new Error(`Unable to save report PDF: ${uploadError.message}`);
    const { error: updateError } = await store.db.from("report_versions")
      .update({ pdf_path: path }).eq("run_id", run.id).eq("version", version);
    if (updateError) throw new Error(`Unable to link report PDF: ${updateError.message}`);
  }
  await store.eventOnce(run, version === 1 ? "report_ready" : "addendum_ready", version === 1 ? "report" : "human_addendum", { version, kind });
}

export async function processResearchRun(runId: string, injectedStore?: ResearchStore): Promise<void> {
  const store = injectedStore ?? new ResearchStore();
  const run = await store.getRun(runId);
  if (run.status === "completed") return;
  if (run.status === "awaiting_approval" || run.status === "needs_input") return;
  const models = new ResearchModels(store, run);
  try {
    if (run.input.paymentId) {
      const paid = await verifyPayment(run.input.paymentId);
      if (paid.mode !== run.mode) throw new IntegrationBlockedError("Purchased plan does not authorize this research mode", "whop");
    }
    if (run.mode === "deep_simulation" && !await prepareDeepStudy(store, run)) return;
    const intake = await runIntake(store, run, models);
    if (!intake.decision.trim() || !intake.audience.trim()) {
      await store.finish(run, "needs_input", "intake", null);
      await store.eventOnce(run, "needs_input", "intake", { questions: [
        ...(!intake.decision.trim() ? ["What decision should this research help you make?"] : []),
        ...(!intake.audience.trim() ? ["Who is the primary buyer or user?"] : []),
      ] });
      return;
    }
    const evidence = await runEvidence(store, run, models, intake);
    const world = await runWorld(store, run, models, intake, evidence);
    const simulation = run.mode !== "light_research";
    const contexts = simulation ? await runContexts(store, run, models, intake, evidence, world) : [];
    const evaluations = simulation ? await runEvaluations(store, run, models, intake, evidence, world, contexts) : [];
    const scenarios = simulation ? await runSensitivities(store, run, models, intake, evidence, world, contexts, evaluations) : [];
    const discussion = simulation ? await runDiscussion(store, run, models, intake, evidence, contexts, evaluations) : null;
    const synthesis = await runSynthesis(store, run, models, intake, evidence, world, contexts, evaluations, scenarios, discussion);
    const report = await buildReport(store, run, intake, evidence, world, contexts, evaluations, scenarios, synthesis);
    await saveReportVersion(store, run, report, "synthetic");
    await store.eventOnce(run, "stage_completed", "report", { finished: true });
    if (run.mode === "deep_simulation") {
      await advanceDeepStudy(store, run, models, intake, report, saveReportVersion);
      return;
    }
    await store.finish(run, "completed", "report");
  } catch (error) {
    if (error instanceof IntegrationBlockedError) {
      await store.finish(run, "integration_blocked", run.stage ?? "intake", { provider: error.provider, message: error.message });
      await store.eventOnce(run, "integration_blocked", run.stage ?? "intake", { provider: error.provider, message: error.message });
      return;
    }
    throw error;
  }
}
