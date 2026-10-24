import { createAdminClient } from "@/lib/db/admin";
import { ApiError, apiErrorResponse, privateJson, requireUser } from "@/lib/api/http";
import { ownedRun } from "@/lib/api/research";
import { renderReportPdf } from "@/lib/report/pdf";
import type { ReportContent } from "@/lib/research/types";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    const db = createAdminClient();
    await ownedRun(db, id, user.id);
    const params = new URL(request.url).searchParams;
    const requestedVersion = params.get("version");
    if (requestedVersion && (!/^\d+$/.test(requestedVersion) || Number(requestedVersion) < 1)) {
      throw new ApiError(400, "Invalid report version.");
    }
    let reportQuery = db.from("report_versions").select("*")
      .eq("run_id", id).eq("owner_id", user.id);
    if (requestedVersion) reportQuery = reportQuery.eq("version", Number(requestedVersion));
    const { data: report, error } = await reportQuery
      .order("version", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    if (!report) throw new ApiError(404, "Report is not ready.");
    const format = params.get("format") ?? "json";
    if (format === "json") return privateJson({ report });
    if (format !== "pdf") throw new ApiError(400, "Unsupported report format.");

    if (report.pdf_path) {
      const { data, error: downloadError } = await db.storage.from("research-reports")
        .download(report.pdf_path);
      if (!downloadError && data) {
        return new Response(data, {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="research-report-v${report.version}.pdf"`,
            "Cache-Control": "private, no-store",
          },
        });
      }
    }
    const pdf = await renderReportPdf(report.content as ReportContent);
    return new Response(Uint8Array.from(pdf).buffer, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="research-report-v${report.version}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
