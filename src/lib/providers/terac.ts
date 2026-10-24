import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { IntegrationBlockedError, ProviderError } from "./errors";

type Tool = { name: string; inputSchema: { properties?: Record<string, unknown>; required?: string[] } };
type ToolResult = { structuredContent?: unknown; content?: Array<{ type?: string; text?: string }>; isError?: boolean };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function unwrap(result: ToolResult): Record<string, unknown> {
  if (result.isError) throw new ProviderError(`Terac MCP tool failed: ${JSON.stringify(result.content).slice(0, 1000)}`, "terac");
  if (result.structuredContent) return asRecord(result.structuredContent);
  const text = result.content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n") ?? "";
  try { return asRecord(JSON.parse(text)); } catch { return { text }; }
}

function pick(object: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) if (object[key] !== undefined) return object[key];
  for (const value of Object.values(object)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = pick(asRecord(value), ...keys);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function toolArguments(tool: Tool, values: Record<string, unknown>): Record<string, unknown> {
  const properties = tool.inputSchema?.properties ?? {};
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(properties)) {
    const camel = key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    const snake = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    const value = values[key] ?? values[camel] ?? values[snake];
    if (value !== undefined) result[key] = value;
  }
  for (const key of tool.inputSchema?.required ?? []) {
    if (result[key] === undefined) throw new IntegrationBlockedError(`Terac MCP ${tool.name} requires unsupported field ${key}`, "terac");
  }
  return result;
}

export class TeracMcp {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private tools: Tool[] = [];

  async connect(): Promise<void> {
    const key = process.env.TERAC_API_KEY;
    if (!key) throw new IntegrationBlockedError("Terac MCP requires TERAC_API_KEY for the background worker", "terac");
    this.transport = new StreamableHTTPClientTransport(new URL("https://terac.com/api/mcp"), {
      requestInit: { headers: { "x-api-key": key }, redirect: "error" },
      redirectPolicy: "same-origin",
    });
    this.client = new Client({ name: "terac-research-worker", version: "0.1.0" });
    try {
      await this.client.connect(this.transport);
      const listing = await this.client.listTools();
      this.tools = listing.tools as Tool[];
      if (this.tools.some((tool) => tool.name === "terac_get_context")) {
        await this.call("terac_get_context", {});
      }
    } catch (error) {
      throw new ProviderError(`Terac MCP connection failed: ${error instanceof Error ? error.message : String(error)}`, "terac");
    }
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
    this.transport = null;
  }

  private async call(name: string, values: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.client) await this.connect();
    const tool = this.tools.find((item) => item.name === name);
    if (!tool) throw new IntegrationBlockedError(`Terac MCP does not offer ${name}`, "terac");
    const args = toolArguments(tool, values);
    const result = await this.client!.callTool({ name, arguments: args }) as ToolResult;
    return unwrap(result);
  }

  async requestFeasibility(args: { audience: string; task: string; count: number }): Promise<{ id: string; status: string; raw: Record<string, unknown> }> {
    const raw = await this.call("terac_request_feasibility", {
      taskDescription: args.task, task_description: args.task, task: args.task,
      panelDescription: args.audience, panel_description: args.audience, role: args.audience,
      submissionCount: args.count, submission_count: args.count, count: args.count,
      timelineHours: 168, timeline_hours: 168,
      loiMinutes: 15, loi_minutes: 15,
      payRateFrequency: "ONE_TIME", pay_rate_frequency: "ONE_TIME",
    });
    const id = pick(raw, "id", "requestId", "request_id");
    if (typeof id !== "string") throw new ProviderError("Terac feasibility response lacked request ID", "terac");
    return { id, status: String(pick(raw, "status") ?? "RECEIVED"), raw };
  }

  async getFeasibility(id: string): Promise<{ status: string; costPerParticipant: number | null; raw: Record<string, unknown> }> {
    const raw = await this.call("terac_get_feasibility_request", { requestId: id, request_id: id, id });
    const cost = pick(raw, "costPerParticipant", "cost_per_participant", "cpi_usd");
    return {
      status: String(pick(raw, "status") ?? "UNKNOWN"),
      costPerParticipant: cost === null || cost === undefined ? null : Number(cost),
      raw,
    };
  }

  async createOpportunity(args: {
    title: string; description: string; taskUrl: string; audience: string;
    feasibilityId: string; count: number; projectId?: string; businessType: "b2b" | "b2c";
    screeningQuestions: Array<{ key: string; text: string; pick: string; answers: Array<{ text: string; qualify_logic: string }> }>;
  }): Promise<{ id: string; totalUsd: number | null; raw: Record<string, unknown> }> {
    const task = {
      sequence: 1, task_type: "interview", review_type: "manual_review", task_url: args.taskUrl,
      title: "Written product feedback", description: "Answer the written questions on the linked page.", duration_minutes: 15,
    };
    const raw = await this.call("terac_create_opportunity", {
      title: args.title,
      description: args.description,
      projectId: args.projectId,
      project_id: args.projectId,
      numParticipants: args.count,
      num_participants: args.count,
      businessType: args.businessType,
      business_type: args.businessType,
      expectedDaysToComplete: 7,
      expected_days_to_complete: 7,
      feasibilityRequestId: args.feasibilityId,
      feasibility_request_id: args.feasibilityId,
      tasks: [task],
      filters: [{ "multi_select--country": { "$in": ["US"] } }],
      screeningQuestions: args.screeningQuestions,
      screening_questions: args.screeningQuestions,
    });
    const id = pick(raw, "id", "opportunityId", "opportunity_id");
    if (typeof id !== "string") throw new ProviderError("Terac draft response lacked opportunity ID", "terac");
    const totalCents = pick(raw, "total_cost_cents", "totalCostCents");
    const total = pick(raw, "total", "totalUsd", "total_usd");
    return { id, totalUsd: totalCents !== undefined && totalCents !== null ? Number(totalCents) / 100 : total === undefined || total === null ? null : Number(total), raw };
  }

  async launchDraft(opportunityId: string): Promise<Record<string, unknown>> {
    return this.call("terac_launch_draft_opportunity", { opportunityId, opportunity_id: opportunityId, id: opportunityId });
  }

  async createProject(title: string): Promise<{ id: string; raw: Record<string, unknown> }> {
    const raw = await this.call("terac_create_project", { title, name: title, description: "Market research study" });
    const id = pick(raw, "id", "projectId", "project_id");
    if (typeof id !== "string") throw new ProviderError("Terac project response lacked ID", "terac");
    return { id, raw };
  }

  async getSubmissions(opportunityId: string): Promise<Record<string, unknown>> {
    const rows: unknown[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const raw = await this.call("terac_get_submissions", {
        opportunityId, opportunity_id: opportunityId, id: opportunityId, limit: 100, cursor,
      });
      const data = asRecord(raw.data);
      const result = asRecord(raw.result);
      const pageRows = Array.isArray(raw.data) ? raw.data
        : data.submissions ?? data.data ?? raw.submissions ?? result.submissions ?? result.data;
      if (!Array.isArray(pageRows)) throw new ProviderError("Terac submissions response has no submission list", "terac");
      rows.push(...pageRows);
      const pagination = asRecord(raw.pagination ?? data.pagination ?? result.pagination);
      if (pagination.has_more !== true && pagination.hasMore !== true) return { data: rows };
      const next = pagination.next_cursor ?? pagination.nextCursor;
      if (typeof next !== "string" || !next || seenCursors.has(next)) {
        throw new IntegrationBlockedError("Terac submissions pagination needs manual reconciliation", "terac");
      }
      const schema = this.tools.find((tool) => tool.name === "terac_get_submissions")?.inputSchema?.properties ?? {};
      if (!("cursor" in schema)) {
        throw new IntegrationBlockedError("Terac MCP cannot page through all submissions", "terac");
      }
      seenCursors.add(next);
      cursor = next;
    }
    throw new IntegrationBlockedError("Terac submissions exceeded the safe reconciliation page count", "terac");
  }

  async getOpportunity(opportunityId: string): Promise<Record<string, unknown>> {
    return this.call("terac_get_opportunity", { opportunityId, opportunity_id: opportunityId, id: opportunityId });
  }

  async approveSubmission(submissionId: string): Promise<Record<string, unknown>> {
    return this.call("terac_approve_submission", { submissionId, submission_id: submissionId, id: submissionId });
  }

  async rejectSubmission(submissionId: string): Promise<Record<string, unknown>> {
    return this.call("terac_reject_submission", {
      submissionId, submission_id: submissionId, id: submissionId,
      reason: "Study response did not meet the research quality criteria.",
    });
  }
}
