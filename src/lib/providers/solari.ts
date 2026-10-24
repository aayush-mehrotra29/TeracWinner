import { IntegrationBlockedError, ProviderError } from "./errors";
import { validatePublicHttpsUrl } from "./public-url";

/** A selective fallback for a single page whose Exa extraction was empty. */
export async function extractWithSolari(rawUrl: string): Promise<string> {
  const key = process.env.SOLARI_API_KEY;
  if (!key) throw new IntegrationBlockedError("SOLARI_API_KEY is not configured", "solari");
  const url = await validatePublicHttpsUrl(rawUrl);
  const packageName = "@solarisdk/browser";
  const { Solari } = await import(packageName) as typeof import("@solarisdk/browser");
  const client = new Solari({ apiKey: key, baseUrl: "https://api.getsolari.com" });
  const browser = await client.launch({ stealth: false, captcha: false, recording: false });
  try {
    const page = await browser.newPage();
    await page.route("**/*", async (route) => {
      try {
        await validatePublicHttpsUrl(route.request().url());
        await route.continue();
      } catch {
        await route.abort();
      }
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    const finalUrl = page.url();
    await validatePublicHttpsUrl(finalUrl);
    const text = await page.locator("body").innerText({ timeout: 5000 });
    if (!text.trim()) throw new ProviderError("Solari page had no readable text", "solari");
    return text.slice(0, 6000);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(`Solari extraction failed: ${error instanceof Error ? error.message : String(error)}`, "solari");
  } finally {
    await browser.close();
  }
}
