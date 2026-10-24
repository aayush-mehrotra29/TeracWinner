import { IntegrationBlockedError, ProviderError } from "./errors";
import { validatePublicHttpsUrl } from "./public-url";

export interface ExaResult {
  id: string;
  url: string;
  title: string;
  publishedDate: string | null;
  excerpt: string;
  textAvailable: boolean;
}

interface ExaResponse {
  results?: Array<{
    id?: string;
    url?: string;
    title?: string;
    publishedDate?: string | null;
    highlights?: string[];
    text?: string;
  }>;
  costDollars?: { total?: number };
  requestId?: string;
}

async function request(path: string, body: unknown): Promise<ExaResponse> {
  const key = process.env.EXA_API_KEY;
  if (!key) throw new IntegrationBlockedError("EXA_API_KEY is required for live research", "exa");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`https://api.exa.ai${path}`, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new ProviderError(`Exa ${response.status}: ${(await response.text()).slice(0, 1000)}`, "exa", response.status);
    return await response.json() as ExaResponse;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(`Exa request failed: ${error instanceof Error ? error.message : String(error)}`, "exa");
  } finally {
    clearTimeout(timeout);
  }
}

function normalize(raw: ExaResponse): ExaResult[] {
  return (raw.results ?? []).flatMap((item) => {
    if (!item.url || !item.title) return [];
    const excerpt = (item.highlights?.join(" … ") || item.text || "").slice(0, 4000);
    return [{
      id: item.id ?? item.url,
      url: item.url,
      title: item.title,
      publishedDate: item.publishedDate ?? null,
      excerpt,
      textAvailable: excerpt.length > 0,
    }];
  });
}

export async function searchExa(query: string, numResults = 4): Promise<{ results: ExaResult[]; costUsd: number | null; requestId: string | null }> {
  const raw = await request("/search", {
    query: query.slice(0, 300),
    type: "auto",
    numResults: Math.max(1, Math.min(numResults, 5)),
    contents: { highlights: { maxCharacters: 2200 } },
  });
  return { results: normalize(raw), costUsd: raw.costDollars?.total ?? null, requestId: raw.requestId ?? null };
}

export async function contentsExa(urls: string[]): Promise<{ results: ExaResult[]; costUsd: number | null; requestId: string | null }> {
  const safeUrls = await Promise.all(urls.slice(0, 5).map(validatePublicHttpsUrl));
  if (!safeUrls.length) return { results: [], costUsd: 0, requestId: null };
  const raw = await request("/contents", {
    // Contents accepts URLs as identifiers; the current HTTP contract names
    // this field `ids` (the older `urls` alias is not documented).
    ids: safeUrls,
    highlights: { maxCharacters: 2200 },
    text: { maxCharacters: 4000 },
  });
  return { results: normalize(raw), costUsd: raw.costDollars?.total ?? null, requestId: raw.requestId ?? null };
}
