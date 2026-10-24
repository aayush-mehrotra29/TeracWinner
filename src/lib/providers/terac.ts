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

export interface TeracOpportunityDetails {
  id: string | null;
  projectId: string | null;
  internalTitle: string | null;
  status: string | null;
  participantCount: number | null;
  /** Terac's all-in cost, including its platform fee; this is not the expert's payout. */
  allInCostPerParticipantUsd: number | null;
  totalUsd: number | null;
  draftEditorUrl: string | null;
}

/** Read documented opportunity fields without treating all-in CPI as participant pay. */
export function parseTeracOpportunity(raw: Record<string, unknown>): TeracOpportunityDetails {
  const data = asRecord(raw.data);
  const result = asRecord(raw.result);
  const rows = [asRecord(data.opportunity), asRecord(result.opportunity), asRecord(raw.opportunity), data, result, raw];
  const value = (...keys: string[]): unknown => {
    for (const row of rows) for (const key of keys) if (row[key] !== undefined) return row[key];
    return undefined;
  };
  const money = (centsKeys: string[], dollarKeys: string[]): number | null => {
    for (const row of rows) {
      const pricing = asRecord(row.pricing);
      for (const source of [pricing, row]) {
        for (const key of centsKeys) {
          const cents = source[key];
          if (typeof cents === "number" && Number.isInteger(cents) && cents >= 0) return cents / 100;
        }
        for (const key of dollarKeys) {
          const dollars = source[key];
          if (typeof dollars === "number" && Number.isFinite(dollars) && dollars >= 0) return dollars;
        }
      }
    }
    return null;
  };
  const id = value("id", "opportunityId", "opportunity_id");
  const projectId = value("project_id", "projectId");
  const internalTitle = value("internal_title", "internalTitle");
  const status = value("status");
  const count = value("num_participants", "numParticipants");
  let draftEditorUrl: string | null = null;
  for (const row of rows) {
    const dashboard = asRecord(asRecord(row.links).dashboard);
    const candidate = dashboard.draft_editor ?? dashboard.draftEditor;
    if (typeof candidate === "string") {
      try {
        const url = new URL(candidate);
        if (url.protocol === "https:" && (url.hostname === "terac.com" || url.hostname.endsWith(".terac.com"))) {
          draftEditorUrl = url.toString();
          break;
        }
      } catch { /* Ignore malformed provider links. */ }
    }
  }
  return {
    id: typeof id === "string" && id.length > 0 ? id : null,
    projectId: typeof projectId === "string" && projectId.length > 0 ? projectId : null,
    internalTitle: typeof internalTitle === "string" && internalTitle.length > 0 ? internalTitle : null,
    status: typeof status === "string" && status.length > 0 ? status : null,
    participantCount: typeof count === "number" && Number.isInteger(count) && count >= 1 ? count : null,
    allInCostPerParticipantUsd: money(
      ["cost_per_participant_cents", "costPerParticipantCents"],
      ["cost_per_participant_usd", "costPerParticipantUsd"],
    ),
    totalUsd: money(["total_cost_cents", "totalCostCents"], ["total_usd", "totalUsd", "total"]),
    draftEditorUrl,
  };
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
    title: string; internalTitle?: string; description: string; taskUrl: string; audience: string;
    feasibilityId?: string; count: number; projectId?: string; businessType: "b2b" | "b2c";
    screeningQuestions: Array<{ key: string; text: string; pick: string; answers: Array<{ text: string; qualify_logic: string }> }>;
  }): Promise<TeracOpportunityDetails & { id: string; raw: Record<string, unknown> }> {
    const task = {
      sequence: 1, task_type: "interview", review_type: "manual_review", task_url: args.taskUrl,
      title: "Written product feedback", description: "Answer the written questions on the linked page.", duration_minutes: 15,
    };
    const raw = await this.call("terac_create_opportunity", {
      title: args.title,
      internalTitle: args.internalTitle,
      internal_title: args.internalTitle,
      description: args.description,
      projectId: args.projectId,
      project_id: args.projectId,
      numParticipants: args.count,
      num_participants: args.count,
      businessType: args.businessType,
      business_type: args.businessType,
      expectedDaysToComplete: 7,
      expected_days_to_complete: 7,
      ...(args.feasibilityId ? {
        feasibilityRequestId: args.feasibilityId,
        feasibility_request_id: args.feasibilityId,
      } : {}),
      tasks: [task],
      filters: [{ "multi_select--country": { "$in": ["US"] } }],
      screeningQuestions: args.screeningQuestions,
      screening_questions: args.screeningQuestions,
    });
    const details = parseTeracOpportunity(raw);
    if (!details.id) throw new ProviderError("Terac draft response lacked opportunity ID", "terac");
    return { ...details, id: details.id, raw };
  }

  /** Reconcile an uncertain draft creation by exact internal title, scoped to one project. */
  async findDraftOpportunityByInternalTitle(
    internalTitle: string, projectId: string,
  ): Promise<(TeracOpportunityDetails & { id: string; raw: Record<string, unknown> }) | null> {
    if (!internalTitle || !projectId) throw new IntegrationBlockedError("Terac draft recovery needs internal title and project ID", "terac");
    // A timed-out create may still be completing remotely. Read a few times
    // before declaring the write uncertain; never issue a second create here.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const found = await this.scanDraftOpportunities(internalTitle, projectId);
      if (found) return found;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    return null;
  }

  private async scanDraftOpportunities(
    internalTitle: string, projectId: string,
  ): Promise<(TeracOpportunityDetails & { id: string; raw: Record<string, unknown> }) | null> {
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let found: (TeracOpportunityDetails & { id: string; raw: Record<string, unknown> }) | null = null;
    for (let page = 0; page < 5; page += 1) {
      const raw = await this.call("terac_list_opportunities", { projectId, status: "draft", limit: 100, cursor });
      const data = asRecord(raw.data);
      const result = asRecord(raw.result);
      const rows = Array.isArray(raw.data) ? raw.data
        : data.opportunities ?? data.data ?? raw.opportunities ?? result.opportunities ?? result.data;
      if (!Array.isArray(rows)) throw new ProviderError("Terac draft listing has no opportunity list", "terac");
      for (const item of rows) {
        const summary = asRecord(item);
        const id = summary.id ?? summary.opportunity_id ?? summary.opportunityId;
        if (typeof id !== "string" || !id) throw new ProviderError("Terac draft listing has an opportunity without ID", "terac");
        const summaryTitle = summary.internal_title ?? summary.internalTitle;
        if (typeof summaryTitle === "string" && summaryTitle !== internalTitle) continue;
        const full = await this.getOpportunity(id);
        const details = parseTeracOpportunity(full);
        if (details.id !== id || !details.projectId || details.projectId !== projectId) {
          throw new IntegrationBlockedError("Terac draft recovery found an inconsistent project or opportunity ID", "terac");
        }
        if (details.internalTitle !== internalTitle) continue;
        if (found) throw new IntegrationBlockedError("Multiple Terac drafts share the recovery title; reconcile them manually", "terac");
        found = { ...details, id, raw: full };
      }
      const pagination = asRecord(raw.pagination ?? data.pagination ?? result.pagination);
      if (pagination.has_more !== true && pagination.hasMore !== true) return found;
      const next = pagination.next_cursor ?? pagination.nextCursor;
      if (typeof next !== "string" || !next || seenCursors.has(next)) {
        throw new IntegrationBlockedError("Terac draft listing pagination needs manual reconciliation", "terac");
      }
      seenCursors.add(next);
      cursor = next;
    }
    throw new IntegrationBlockedError("Terac draft recovery exceeded its safe search window", "terac");
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
