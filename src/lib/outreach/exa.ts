import { z } from "zod";
import { required } from "./config";
import { boundedText } from "./http";
import { domainOf, publicUrl } from "./public-web";

export const EXCLUDED_DOMAINS = ["exa.ai", "orit.dev", "amazon.com", "etsy.com", "shopify.com", "facebook.com", "instagram.com", "linkedin.com", "pinterest.com", "wikipedia.org", "youtube.com", "gmail.com"];
const ResponseSchema = z.object({ results: z.array(z.object({ url: z.string(), title: z.string().nullable().optional() })).max(100) });
const segments = ["home goods and kitchenware", "apparel and everyday accessories", "skincare and personal care products", "reusable household products", "pet products", "stationery and craft supplies"];
export type DiscoveredBusiness = { name: string; website: string; domain: string };

export async function exaCompanies(focus: string, excluded: string[], pass = 0, request: typeof fetch = fetch): Promise<DiscoveredBusiness[]> {
  const excludedDomains = [...new Set([...EXCLUDED_DOMAINS, ...excluded])];
  const response = await request("https://api.exa.ai/search", {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(30000),
    headers: { "x-api-key": required("EXA_API_KEY"), "Content-Type": "application/json" },
    body: JSON.stringify({ query: `Independent US brands selling ${segments[Math.abs(pass) % segments.length]} directly from their own online stores`, objective: `${focus.slice(0,500)}. Find official brand storefronts with product and contact pages. Exclude agencies, marketplaces, directories and provider profiles.`, type: "auto", numResults: 20, excludeDomains: excludedDomains.slice(0, 1200) }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(new Error("Exa company search failed"), { status: response.status });
  }
  const result = ResponseSchema.parse(JSON.parse(await boundedText(response, 1000000)));
  const seen = new Set(excludedDomains);
  const candidates: DiscoveredBusiness[] = [];
  for (const item of result.results) {
    try {
      const url = publicUrl(item.url); const domain = domainOf(url.href);
      if (seen.has(domain)) continue;
      seen.add(domain);
      // Search text never supplies contact addresses or verification evidence.
      candidates.push({ name: (item.title?.trim() || domain).slice(0, 100), website: `${url.origin}/`, domain });
      if (candidates.length === 10) break;
    } catch { /* Invalid search links never become verification targets. */ }
  }
  return candidates;
}
