import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { ReportContent, ReportPoint } from "@/lib/research/types";

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 50;
const BODY_WIDTH = PAGE_WIDTH - MARGIN * 2;
const INK = rgb(0.075, 0.086, 0.14);
const MUTED = rgb(0.37, 0.4, 0.47);
const BLUE = rgb(0.063, 0.098, 0.925);
const HAIRLINE = rgb(0.84, 0.86, 0.9);
const PALE_BLUE = rgb(0.94, 0.95, 1);

function printable(value: unknown, font: PDFFont): string {
  const raw = String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(/[\t\u00a0]/g, " ");
  return Array.from(raw, (character) => {
    if (character === "\n") return character;
    try {
      font.encodeText(character);
      return character;
    } catch {
      return "?";
    }
  }).join("");
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph.trim()) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) {
        line = next;
        continue;
      }
      if (line) lines.push(line);
      line = "";
      for (const character of word) {
        if (font.widthOfTextAtSize(line + character, size) > width && line) {
          lines.push(line);
          line = "";
        }
        line += character;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

/** Render the same structured report used by the web view as a private PDF download. */
export async function renderReportPdf(report: ReportContent): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.setTitle(report.title);
  document.setAuthor("Orit Research Studio");
  document.setSubject("Directional product research report");
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;

  function newPage() {
    page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    pages.push(page);
    page.drawRectangle({ x: 0, y: PAGE_HEIGHT - 8, width: PAGE_WIDTH, height: 8, color: BLUE });
    page.drawText("ORIT  /  RESEARCH", {
      x: MARGIN,
      y: PAGE_HEIGHT - 40,
      size: 9,
      font: bold,
      color: BLUE,
    });
    page.drawLine({ start: { x: MARGIN, y: PAGE_HEIGHT - 50 }, end: { x: PAGE_WIDTH - MARGIN, y: PAGE_HEIGHT - 50 }, thickness: 0.8, color: HAIRLINE });
    y = PAGE_HEIGHT - 83;
  }

  function requireSpace(height: number) {
    if (y - height < 66) newPage();
  }

  function paragraph(raw: unknown, options: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; indent?: number; after?: number } = {}) {
    const font = options.font ?? regular;
    const size = options.size ?? 10.5;
    const indent = options.indent ?? 0;
    const lineHeight = size * 1.43;
    const lines = wrap(printable(raw, font), font, size, BODY_WIDTH - indent);
    for (const line of lines) {
      requireSpace(lineHeight);
      if (line) page.drawText(line, { x: MARGIN + indent, y, size, font, color: options.color ?? INK });
      y -= lineHeight;
    }
    y -= options.after ?? 8;
  }

  function section(title: string) {
    requireSpace(45);
    y -= 10;
    page.drawLine({ start: { x: MARGIN, y: y + 13 }, end: { x: PAGE_WIDTH - MARGIN, y: y + 13 }, thickness: 0.8, color: HAIRLINE });
    page.drawText(printable(title.toUpperCase(), bold), { x: MARGIN, y, size: 11, font: bold, color: BLUE });
    y -= 24;
  }

  function points(items: ReportPoint[]) {
    if (!items.length) {
      paragraph("No supported finding was available for this section.", { color: MUTED });
      return;
    }
    for (const item of items) {
      requireSpace(28);
      page.drawCircle({ x: MARGIN + 3, y: y + 3, size: 2.2, color: BLUE });
      const refs = item.evidenceIds.length ? `  [${item.evidenceIds.join(", ")}]` : "";
      const basis = item.basis === "external" ? "External evidence"
        : item.basis === "human" ? "Human feedback"
        : item.basis === "synthetic" ? "Synthetic interpretation"
        : "Assumption";
      paragraph(`${basis}: ${item.text}${refs}`, { indent: 14, after: 6 });
    }
  }

  newPage();
  paragraph(report.mode.replaceAll("_", " ").toUpperCase(), { size: 10, font: bold, color: BLUE, after: 14 });
  paragraph(report.title, { size: 24, font: bold, after: 10 });
  paragraph(`Generated ${new Date(report.metadata.generatedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })}   •   Version ${report.metadata.reportVersion}`, { size: 9, color: MUTED, after: 21 });

  requireSpace(45);
  page.drawRectangle({ x: MARGIN, y: y - 20, width: BODY_WIDTH, height: 34, color: PALE_BLUE });
  page.drawText(printable(`DIRECTIONAL READ  /  ${report.verdict.toUpperCase()}`, bold), { x: MARGIN + 14, y: y - 7, size: 10, font: bold, color: BLUE });
  y -= 34;
  paragraph(report.verdictReason);

  section("Executive summary");
  paragraph(report.executiveSummary);

  if (report.questionAnswers.length) {
    section("Questions answered");
    for (const answer of report.questionAnswers) {
      paragraph(answer.question, { font: bold, after: 2 });
      const basis = answer.basis === "external" ? "External evidence"
        : answer.basis === "synthetic" ? "Synthetic interpretation" : "Assumption";
      paragraph(`${basis}: ${answer.answer}${answer.evidenceIds.length ? `  [${answer.evidenceIds.join(", ")}]` : ""}`);
    }
  }

  section("Key findings");
  points(report.findings);
  section("Where it looks promising");
  points(report.strengths);
  section("Where it falls short");
  points(report.weaknesses);
  section("Recommended changes");
  points(report.recommendations);
  section("Next experiment");
  points([report.nextExperiment]);

  section("Price analysis");
  paragraph(report.pricing.note);
  if (report.pricing.marginFloor !== null) paragraph(`Minimum viable price at the supplied margin: $${report.pricing.marginFloor.toFixed(2)}`);
  if (report.pricing.testPrices.length) paragraph(`Prices to test: ${report.pricing.testPrices.map((price) => `$${price.toFixed(2)}`).join("  /  ")}`);
  for (const benchmark of report.pricing.benchmarks) {
    paragraph(`${benchmark.label}: $${benchmark.price.toFixed(2)} per ${benchmark.unit}  [${benchmark.sourceId}]`, { size: 9, color: MUTED, after: 3 });
  }

  if (report.synthetic) {
    section("Synthetic simulation");
    paragraph(`${report.synthetic.label}. ${report.synthetic.total} hypothetical buyer contexts were evaluated.`, { font: bold });
    for (const [choice, count] of Object.entries(report.synthetic.counts)) {
      paragraph(`${choice.replaceAll("_", " ")}: ${count}/${report.synthetic.total}`, { after: 2 });
    }
    paragraph("These counts are not market share, purchase probability, or a representative human sample.", { color: MUTED });
  }

  if (report.humanAddendum) {
    section("Human feedback addendum");
    paragraph(`${report.humanAddendum.responses} reviewed responses. ${report.humanAddendum.comparison}`);
    points(report.humanAddendum.findings);
    for (const caveat of report.humanAddendum.caveats) paragraph(caveat, { color: MUTED });
    section("Reviewed response excerpts");
    if (!report.humanAddendum.sources.length) {
      paragraph("No reviewed response excerpts were available.", { color: MUTED });
    }
    for (const source of report.humanAddendum.sources) {
      paragraph(`[${source.id}] Reviewed response ${source.responseId}`, { font: bold, size: 9.5, after: 2 });
      for (const excerpt of source.excerpts) {
        paragraph(`${excerpt.questionId}: ${excerpt.answer}`, { size: 9, color: MUTED, after: 4 });
      }
    }
  }

  section("Sources");
  if (!report.sources.length) paragraph("No external sources were successfully retrieved.", { color: MUTED });
  for (const source of report.sources) {
    paragraph(`[${source.id}] ${source.title}`, { font: bold, size: 9.5, after: 1 });
    paragraph(source.url, { size: 8, color: BLUE, after: 2 });
    paragraph(source.excerpt, { size: 9, color: MUTED, after: 9 });
  }

  section("Methods and limitations");
  for (const caveat of report.caveats) paragraph(caveat, { size: 9.5, color: MUTED });
  paragraph(`Models: ${report.metadata.modelIds.join(", ") || "none"}. Evidence sources: ${report.metadata.evidenceCount}. Human feedback: ${report.metadata.humanStatus}.`, { size: 8.5, color: MUTED });

  pages.forEach((current, index) => {
    current.drawLine({ start: { x: MARGIN, y: 48 }, end: { x: PAGE_WIDTH - MARGIN, y: 48 }, thickness: 0.8, color: HAIRLINE });
    current.drawText("Directional analysis • review sources and assumptions before a launch decision", { x: MARGIN, y: 33, size: 7.5, font: regular, color: MUTED });
    current.drawText(`${index + 1} / ${pages.length}`, { x: PAGE_WIDTH - MARGIN - 34, y: 33, size: 8, font: bold, color: MUTED });
  });
  return document.save();
}
