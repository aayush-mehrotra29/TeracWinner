import { convert } from "html-to-text";
import { WEBSITE_URL } from "./config";
import { boundedText } from "./http";
export type Knowledge = { text: string; source: string; fetchedAt: string | null; live: boolean };
let cached: Knowledge | undefined;
const fallback = "Orit combines AI-powered market research with fresh feedback from real people. It helps brands test products, packaging, prices, and messages, then provides a report with findings and suggested next steps. Current pricing, availability, sample sizes and delivery times must be confirmed with Orit.";
export async function getKnowledge(): Promise<Knowledge> {
  if (cached?.fetchedAt && Date.now() - Date.parse(cached.fetchedAt) < 600000) return cached;
  try {
    const response = await fetch(WEBSITE_URL, { signal: AbortSignal.timeout(6000), redirect: "error", cache: "no-store" });
    if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) throw new Error("Website unavailable");
    const text = convert(await boundedText(response, 2_000_000), {
      wordwrap: false,
      selectors: [{ selector: "script", format: "skip" }, { selector: "style", format: "skip" }, { selector: "nav", format: "skip" }, { selector: "footer", format: "skip" }, { selector: "a", options: { ignoreHref: true } }, { selector: "img", format: "skip" }],
    }).replace(/\n{3,}/g, "\n\n").slice(0, 24000);
    if (text.length < 300 || !text.includes("Orit")) throw new Error("Website content missing");
    cached = { text, source: WEBSITE_URL, fetchedAt: new Date().toISOString(), live: true };
    return cached;
  } catch {
    // Never quote potentially stale prices or availability when the site cannot be refreshed.
    return { text: fallback, source: WEBSITE_URL, fetchedAt: null, live: false };
  }
}
