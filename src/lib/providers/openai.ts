import { IntegrationBlockedError, ProviderError } from "./errors";

export type ResearchModel = "gpt-6-luna" | "gpt-6.1-sol";
export type ReasoningEffort = "low" | "medium" | "high";

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: Array<string | number | boolean | null>;
}

export interface ModelResult<T> {
  value: T;
  responseId: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  model: ResearchModel;
}

export class ModelOutputError extends ProviderError {
  constructor(message: string, readonly inputTokens: number, readonly outputTokens: number, readonly estimatedCostUsd: number, readonly responseId: string | null) {
    super(message, "openai");
    this.name = "ModelOutputError";
  }
}

const STANDARD_RATES: Record<ResearchModel, { input: number; cached: number; output: number }> = {
  // Standard short-context prices per million tokens, checked 2026-10-24.
  "gpt-6-luna": { input: 0.1, cached: 0.01, output: 0.5 },
  "gpt-6.1-sol": { input: 2, cached: 0.1, output: 10 },
};

function validate(value: unknown, schema: JsonSchema, path = "output"): void {
  if (schema.enum && !schema.enum.includes(value as never)) {
    throw new ProviderError(`${path} was outside the allowed values`, "openai");
  }
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : [];
  if (types.length) {
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (!types.includes(actual)) throw new ProviderError(`${path} must be ${types.join(" or ")}`, "openai");
  }
  if (value === null) return;
  if (Array.isArray(value)) {
    if (schema.items) value.forEach((item, index) => validate(item, schema.items!, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object" && value) {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in object)) throw new ProviderError(`${path}.${key} is missing`, "openai");
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(object)) {
        if (!schema.properties?.[key]) throw new ProviderError(`${path}.${key} is not allowed`, "openai");
      }
    }
    for (const [key, nested] of Object.entries(schema.properties ?? {})) {
      if (key in object) validate(object[key], nested, `${path}.${key}`);
    }
  }
}

export function estimateOpenAiCost(model: ResearchModel, inputTokens: number, outputTokens: number, cachedTokens = 0): number {
  const rate = STANDARD_RATES[model];
  return ((inputTokens - cachedTokens) * rate.input + cachedTokens * rate.cached + outputTokens * rate.output) / 1_000_000;
}

export async function structuredResponse<T>(args: {
  model: ResearchModel;
  effort: ReasoningEffort;
  schemaName: string;
  schema: JsonSchema;
  instructions: string;
  input: string;
  imageDataUrls?: string[];
  maxOutputTokens?: number;
  requestId?: string;
}): Promise<ModelResult<T>> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new IntegrationBlockedError("OPENAI_API_KEY is required for live research", "openai");
  const content: Array<Record<string, string>> = [{ type: "input_text", text: args.input }];
  for (const imageUrl of args.imageDataUrls ?? []) content.push({ type: "input_image", image_url: imageUrl });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(args.requestId ? { "X-Client-Request-Id": args.requestId } : {}),
      },
      body: JSON.stringify({
        model: args.model,
        reasoning: { effort: args.effort },
        store: false,
        max_output_tokens: args.maxOutputTokens ?? 2400,
        instructions: args.instructions,
        input: [{ role: "user", content }],
        text: { format: { type: "json_schema", name: args.schemaName, schema: args.schema, strict: true } },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    throw new ProviderError(`OpenAI request failed: ${error instanceof Error ? error.message : String(error)}`, "openai");
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const body = (await response.text()).slice(0, 1200);
    throw new ProviderError(`OpenAI ${response.status}: ${body}`, "openai", response.status);
  }
  const result = await response.json() as {
    id?: string;
    status?: string;
    output_text?: string;
    output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string; refusal?: string }> }>;
    usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
  };
  const inputTokens = result.usage?.input_tokens ?? 0;
  const outputTokens = result.usage?.output_tokens ?? 0;
  const cachedTokens = result.usage?.input_tokens_details?.cached_tokens ?? 0;
  const cost = estimateOpenAiCost(args.model, inputTokens, outputTokens, cachedTokens);
  const failedOutput = (message: string): never => { throw new ModelOutputError(message, inputTokens, outputTokens, cost, result.id ?? null); };
  if (result.status !== "completed") failedOutput(`OpenAI response ended with status ${result.status}`);
  const refusal = result.output?.flatMap((item) => item.content ?? []).find((item) => item.type === "refusal");
  if (refusal) failedOutput(`OpenAI refused the request: ${refusal.refusal ?? "no reason given"}`);
  const outputText = result.output_text ?? result.output?.flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text").map((item) => item.text ?? "").join("");
  if (!outputText) return failedOutput("OpenAI returned no structured output");
  const value: T = (() => {
    try { return JSON.parse(outputText) as T; }
    catch { return failedOutput("OpenAI returned invalid JSON"); }
  })();
  try { validate(value, args.schema); } catch (error) { failedOutput(error instanceof Error ? error.message : "OpenAI output failed validation"); }
  return {
    value,
    responseId: result.id ?? "",
    inputTokens,
    outputTokens,
    estimatedCostUsd: cost,
    model: args.model,
  };
}
