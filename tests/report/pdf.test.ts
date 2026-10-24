import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PDFDict, PDFDocument, PDFName, PDFString } from "pdf-lib";
import { renderReportPdf } from "../../src/lib/report/pdf";
import type { ReportContent } from "../../src/lib/research/types";

function report(): ReportContent {
  const longText = "This product has a conditional advantage for buyers who value the stated feature, while public evidence leaves adoption uncertain. ".repeat(24);
  const point = { text: longText, evidenceIds: ["src:one"], basis: "external" as const };
  return {
    title: "Refillable cleaner — directional analysis 🚀",
    mode: "light_simulation",
    verdict: "inconclusive",
    verdictReason: longText,
    executiveSummary: longText,
    questionAnswers: [{ question: "How might it perform?", answer: longText, evidenceIds: ["src:one"], basis: "external" }],
    findings: [point, point],
    strengths: [point],
    weaknesses: [point],
    recommendations: [point],
    nextExperiment: point,
    pricing: { status: "benchmarks_only", marginFloor: null, testPrices: [], benchmarks: [], note: "Unit economics unavailable." },
    synthetic: { total: 8, counts: { concept_a: 3, concept_b: 0, status_quo: 3, neither: 1, insufficient_information: 1 }, label: "share of synthetic agents in this run" },
    sources: [{ id: "src:one", url: "https://example.com/product", title: "A comparable product", publishedAt: null, excerpt: longText, provider: "exa", fetchedAt: "2026-10-24T00:00:00.000Z", category: "competitor", limitations: [] }],
    caveats: ["Synthetic contexts are not a representative human sample."],
    metadata: { runId: "test-run", reportVersion: 1, generatedAt: "2026-10-24T00:00:00.000Z", modelIds: ["gpt-6-luna", "gpt-6.1-sol"], evidenceCount: 1, simulationCount: 8, humanStatus: "not_requested" },
  };
}

test("long structured reports render as valid multipage PDFs", async () => {
  const bytes = await renderReportPdf(report());
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), "%PDF");
  const document = await PDFDocument.load(bytes);
  assert.ok(document.getPageCount() > 1);
  assert.equal(document.getTitle(), "Refillable cleaner — directional analysis 🚀");
});

test("PDF includes the saved source identifiers and URLs", async (context) => {
  try {
    execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
  } catch {
    context.skip("Poppler is unavailable");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "terac-report-"));
  try {
    const path = join(directory, "report.pdf");
    writeFileSync(path, await renderReportPdf(report()));
    const extracted = execFileSync("pdftotext", ["-layout", path, "-"], { encoding: "utf8" });
    assert.match(extracted, /share of synthetic agents in this run/i);
    assert.match(extracted, /src:one/);
    assert.match(extracted, /https:\/\/example\.com\/product/);
    assert.match(extracted, /A comparable product/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("source links are clickable and unsafe URLs are not active", async () => {
  const content = report();
  content.sources.push({ ...content.sources[0], id: "src:unsafe", url: "javascript:alert(1)" });
  const document = await PDFDocument.load(await renderReportPdf(content));
  const destinations = document.getPages().flatMap((page) => {
    const annotations = page.node.Annots();
    return annotations ? annotations.asArray().map((reference) => {
      const annotation = document.context.lookup(reference, PDFDict);
      const action = annotation.lookup(PDFName.of("A"), PDFDict);
      return action.lookup(PDFName.of("URI"), PDFString).decodeText();
    }) : [];
  });
  assert.ok(destinations.includes("https://example.com/product"));
  assert.ok(destinations.every((destination) => destination.startsWith("https://")));
});

test("human addendum PDF preserves its reviewed answer excerpts", async (context) => {
  try {
    execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
  } catch {
    context.skip("Poppler is unavailable");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "terac-human-report-"));
  try {
    const content = report();
    const humanId = "human:902f5d25-35cb-429d-ac9a-b005ebee379e";
    content.humanAddendum = {
      responses: 1,
      comparison: "The reviewed answer raised a new concern.",
      findings: [{ text: "The buyer questioned setup time.", basis: "human", evidenceIds: [humanId] }],
      caveats: ["The hosted form does not independently prove authorship."],
      sources: [{ id: humanId, responseId: humanId.slice(6), excerpts: [{ questionId: "concern", answer: "Setup would take too long for my team." }] }],
    };
    const path = join(directory, "report.pdf");
    writeFileSync(path, await renderReportPdf(content));
    const extracted = execFileSync("pdftotext", [path, "-"], { encoding: "utf8" });
    assert.match(extracted, /human:902f5d25-35cb-429d-ac9a-b005ebee379e/);
    assert.match(extracted, /Setup would take too long for my team/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
