import { isIP } from "node:net";
import { ApiError } from "./http";

export type ResearchMode = "light_research" | "light_simulation" | "deep_simulation";

export interface ResearchInput {
  idea: string;
  /** Server-supplied only; never populated by parseResearchInput from a browser. */
  paymentId?: string;
  mode: ResearchMode;
  concepts: string[];
  urls: string[];
  imageAssetIds: string[];
  audience?: string;
  geography: "US";
  economics?: { unitCost: number; minGrossMargin: number; priceUnit?: string };
  priceUnit?: string;
  followupQuestion?: string;
  clarifications?: string[];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "Expected a JSON object.");
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, max: number, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.trim().length > max) {
    throw new ApiError(400, `Invalid ${label}.`);
  }
  return value.trim();
}

function stringArray(value: unknown, maxItems: number, maxLength: number, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems ||
    value.some((item) => typeof item !== "string" || !item.trim() || item.length > maxLength)) {
    throw new ApiError(400, `Invalid ${label}.`);
  }
  return [...new Set(value.map((item: string) => item.trim()))];
}

function safePublicUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ApiError(400, "Use valid public URLs.");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password ||
    isIP(host) || host.startsWith("[") || host.includes(":") ||
    host === "localhost" || host.endsWith(".localhost") ||
    host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")) {
    throw new ApiError(400, "Use public HTTPS URLs.");
  }
  url.hash = "";
  return url.toString();
}

export function parseResearchInput(body: unknown, fallbackIdea?: string): ResearchInput {
  const data = object(body);
  const idea = optionalString(data.idea, 12000, "idea") ?? fallbackIdea;
  if (!idea || idea.length < 8) throw new ApiError(400, "Describe your idea in at least eight characters.");
  const mode = data.mode;
  if (mode !== "light_research" && mode !== "light_simulation" && mode !== "deep_simulation") {
    throw new ApiError(400, "Select a research mode.");
  }
  const concepts = stringArray(data.concepts, 2, 4000, "concepts");
  const urls = stringArray(data.urls, 5, 2048, "URLs").map(safePublicUrl);
  const imageAssetIds = stringArray(data.imageAssetIds ?? data.imageIds, 4, 64, "image assets");
  if (imageAssetIds.some((id) => !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id))) {
    throw new ApiError(400, "Invalid image asset ID.");
  }
  const audience = optionalString(data.audience, 500, "audience");
  let economics: ResearchInput["economics"];
  if (data.economics !== undefined) {
    const raw = object(data.economics);
    if (typeof raw.unitCost !== "number" || !Number.isFinite(raw.unitCost) || raw.unitCost < 0 ||
      typeof raw.minGrossMargin !== "number" || !Number.isFinite(raw.minGrossMargin) ||
      raw.minGrossMargin < 0 || raw.minGrossMargin >= 1) {
      throw new ApiError(400, "Economics need a nonnegative unit cost and margin between 0 and 1.");
    }
    economics = {
      unitCost: raw.unitCost,
      minGrossMargin: raw.minGrossMargin,
      priceUnit: optionalString(raw.priceUnit, 80, "price unit"),
    };
  }
  const priceUnit = economics?.priceUnit ?? optionalString(data.priceUnit, 80, "price unit");
  return { idea, mode, concepts, urls, imageAssetIds, audience, geography: "US", economics, priceUnit };
}

export function parseMessage(body: unknown): string {
  const content = optionalString(object(body).content, 12000, "message");
  if (!content) throw new ApiError(400, "Write a message.");
  return content;
}
