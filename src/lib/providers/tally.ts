import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { IntegrationBlockedError, ProviderError } from "./errors";

type ToolResult = {
  structuredContent?: unknown;
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
};

type TallyTool = { name: string };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function redacted(message: string): string {
  return message.replace(/https?:\/\/\S+/g, "[URL redacted]").slice(0, 500);
}

function unwrap(result: ToolResult, operation: string): Record<string, unknown> {
  if (result.isError) {
    const message = result.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join(" ") ?? "";
    throw new ProviderError(`Tally ${operation} failed: ${redacted(message)}`, "tally");
  }
  if (result.structuredContent) return record(result.structuredContent);
  const text = result.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") ?? "";
  try { return record(JSON.parse(text)); } catch { return { text }; }
}

function feedback(result: Record<string, unknown>): string {
  return String(record(result.context).feedback ?? "");
}

function assertComplete(result: Record<string, unknown>, operation: string): void {
  if (Number(result.failureCount ?? 0) > 0 || result.upgradeTrigger) {
    throw new ProviderError(`Tally ${operation} was not fully applied: ${redacted(feedback(result))}`, "tally");
  }
}

export interface TallyQuestion {
  id: string;
  prompt: string;
  type: "text" | "choice";
  options?: string[];
}

export interface TallySubmission {
  id: string;
  isCompleted: boolean;
  submittedAt: string;
  responses: Array<{ questionId: string; answer: unknown }>;
}

export interface TallySubmissionPage {
  questions: Array<{ id: string; label: string | null; type: string }>;
  submissions: TallySubmission[];
  hasMore: boolean;
}

/** A separate worker credential is required; the Codex Tally plugin session is not shared with Node. */
export class TallyMcp {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private tools: TallyTool[] = [];

  async connect(): Promise<void> {
    const key = process.env.TALLY_API_KEY;
    if (!key) throw new IntegrationBlockedError("Tally MCP requires TALLY_API_KEY in .env.local for the background worker", "tally");
    this.transport = new StreamableHTTPClientTransport(new URL("https://api.tally.so/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${key}` }, redirect: "error" },
      redirectPolicy: "same-origin",
    });
    this.client = new Client({ name: "orit-research-worker", version: "0.1.0" });
    try {
      await this.client.connect(this.transport);
      this.tools = (await this.client.listTools()).tools as TallyTool[];
    } catch (error) {
      await this.close();
      throw new ProviderError(`Tally MCP connection failed: ${error instanceof Error ? error.message : String(error)}`, "tally");
    }
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
    this.transport = null;
    this.tools = [];
  }

  private async call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.client) await this.connect();
    if (!this.tools.some((tool) => tool.name === name)) {
      throw new IntegrationBlockedError(`Tally MCP does not offer ${name}`, "tally");
    }
    const raw = await this.client!.callTool({ name, arguments: args }) as ToolResult;
    const result = unwrap(raw, name);
    assertComplete(result, name);
    return result;
  }

  async listWorkspaces(): Promise<Array<{ id: string; name: string }>> {
    const response = await this.call("list_workspaces", {});
    const rows = record(response.data).workspaces;
    if (!Array.isArray(rows)) throw new ProviderError("Tally returned no workspace list", "tally");
    return rows.flatMap((item) => {
      const row = record(item);
      return typeof row.id === "string" && typeof row.name === "string" ? [{ id: row.id, name: row.name }] : [];
    });
  }

  async listForms(workspaceId: string): Promise<Array<{ id: string; name: string | null; status: string }>> {
    const forms: Array<{ id: string; name: string | null; status: string }> = [];
    let page = 1;
    for (;;) {
      const result = await this.call("list_forms", { filter: { workspaceIds: [workspaceId] }, limit: 100, page });
      const data = record(result.data);
      if (!Array.isArray(data.forms)) throw new ProviderError("Tally returned an invalid forms page", "tally");
      for (const item of data.forms) {
        const row = record(item);
        if (typeof row.id === "string") forms.push({ id: row.id, name: typeof row.name === "string" ? row.name : null, status: String(row.status ?? "") });
      }
      if (!data.hasMore) return forms;
      if (++page > 100) throw new IntegrationBlockedError("Tally workspace has too many forms to safely reconcile this run", "tally");
    }
  }

  async createForm(title: string, workspaceId: string): Promise<{ id: string; ledger: string }> {
    const result = await this.call("create_new_form", { title, workspaceId });
    const ledger = String(record(result.context).ledger ?? "");
    const id = /^formId:\s*([A-Za-z0-9_-]+)\s*$/m.exec(ledger)?.[1]
      ?? /Created draft form ([A-Za-z0-9_-]+)/.exec(feedback(result))?.[1];
    if (!id) throw new ProviderError("Tally created a form but did not return its ID; reconcile by run title before retry", "tally");
    return { id, ledger };
  }

  async loadForm(formId: string): Promise<{ ledger: string; status: string }> {
    const result = await this.call("load_form", { formId });
    const ledger = String(record(result.context).ledger ?? "");
    const note = feedback(result);
    if (!ledger) throw new ProviderError("Tally returned no form ledger", "tally");
    return { ledger, status: /\bpublished\b/i.test(note) ? "PUBLISHED" : "DRAFT" };
  }

  async setFormTitle(formId: string, title: string): Promise<void> {
    await this.call("set_form_title", { formId, title });
  }

  async createBlocks(formId: string, blocks: unknown[]): Promise<string> {
    const result = await this.call("create_blocks", { formId, groups: [{ blocks }] });
    const ledger = String(record(result.context).ledger ?? "");
    if (!ledger) throw new ProviderError("Tally saved blocks but returned no ledger", "tally");
    const expectedImages = blocks.filter((block) => record(block).type === "IMAGE").length;
    const savedImages = ledger.split("\n").filter((line) => line.includes("| IMAGE |")).length;
    if (expectedImages !== savedImages || /stock photo|image.*(?:dropped|replaced|could not|failed)/i.test(feedback(result))) {
      throw new ProviderError("Tally did not preserve every supplied product image in the form", "tally");
    }
    return ledger;
  }

  async setCompletionRedirect(formId: string, hiddenFieldId: string): Promise<void> {
    const redirectOnCompletionUrl = `https://terac.com/api/external/callback?teracSubmissionId={{${hiddenFieldId}}}&result=completed`;
    await this.call("update_settings", { formId, redirectOnCompletionUrl });
  }

  async publishForm(formId: string): Promise<string> {
    const result = await this.call("publish_form", { formId });
    const url = result.url;
    if (typeof url !== "string") throw new ProviderError("Tally published the form but returned no URL", "tally");
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "tally.so" || !parsed.pathname.startsWith("/r/")) {
      throw new ProviderError("Tally returned an unexpected public form URL", "tally");
    }
    return url;
  }

  async fetchSubmissions(formId: string, page: number): Promise<TallySubmissionPage> {
    const result = await this.call("fetch_submissions", { formId, filter: { status: "completed" }, limit: 100, page });
    const data = record(result.data);
    if (!Array.isArray(data.questions) || !Array.isArray(data.submissions)) {
      throw new ProviderError("Tally returned an invalid submissions page", "tally");
    }
    return {
      questions: data.questions.flatMap((item) => {
        const row = record(item);
        return typeof row.id === "string" ? [{ id: row.id, label: typeof row.label === "string" ? row.label : null, type: String(row.type ?? "") }] : [];
      }),
      submissions: data.submissions.flatMap((item) => {
        const row = record(item);
        if (typeof row.id !== "string" || !Array.isArray(row.responses)) return [];
        return [{
          id: row.id, isCompleted: row.isCompleted === true, submittedAt: String(row.submittedAt ?? ""),
          responses: row.responses.flatMap((answer) => {
            const part = record(answer);
            return typeof part.questionId === "string" ? [{ questionId: part.questionId, answer: part.answer }] : [];
          }),
        }];
      }),
      hasMore: data.hasMore === true,
    };
  }
}
