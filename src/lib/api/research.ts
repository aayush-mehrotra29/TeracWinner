import { createAdminClient } from "@/lib/db/admin";
import { ApiError } from "./http";
import type { ResearchInput, ResearchMode } from "./validation";

type Admin = ReturnType<typeof createAdminClient>;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function assertMatchingInitialInput(admin: Admin, runId: string, ownerId: string, expected: unknown) {
  const { data, error } = await admin.from("run_input_versions").select("input")
    .eq("run_id", runId).eq("owner_id", ownerId).eq("revision", 1).maybeSingle();
  if (error) throw error;
  if (!data || canonicalJson(data.input) !== canonicalJson(expected)) {
    throw new ApiError(409, "Idempotency key belongs to a different research request.");
  }
}

export function budgetForMode(mode: ResearchMode): number {
  const name = {
    light_research: "RESEARCH_BUDGET_LIGHT_RESEARCH_USD",
    light_simulation: "RESEARCH_BUDGET_LIGHT_SIMULATION_USD",
    deep_simulation: "RESEARCH_BUDGET_DEEP_SIMULATION_USD",
  }[mode];
  const raw = process.env[name];
  if (!raw) return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new ApiError(503, `${name} must be zero for no cap or a positive USD amount.`);
  }
  return value;
}

function dailyRunLimit(): number {
  const raw = process.env.RESEARCH_DAILY_RUN_LIMIT;
  if (!raw) return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 1000) {
    throw new ApiError(503, "Research daily limit is misconfigured.");
  }
  return value;
}

export async function ownedProject(admin: Admin, projectId: string, ownerId: string) {
  const { data, error } = await admin.from("projects").select("*")
    .eq("id", projectId).eq("owner_id", ownerId).maybeSingle();
  if (error) throw error;
  if (!data) throw new ApiError(404, "Project not found.");
  return data;
}

export async function ownedRun(admin: Admin, runId: string, ownerId: string) {
  const { data, error } = await admin.from("runs").select("*")
    .eq("id", runId).eq("owner_id", ownerId).maybeSingle();
  if (error) throw error;
  if (!data) throw new ApiError(404, "Run not found.");
  return data;
}

export async function validateAndLinkAssets(
  admin: Admin,
  ownerId: string,
  projectId: string,
  ids: string[],
) {
  if (!ids.length) return;
  const { data, error: linkError } = await admin.from("assets").update({ project_id: projectId })
    .eq("owner_id", ownerId).in("id", ids)
    .or(`project_id.is.null,project_id.eq.${projectId}`)
    .select("id");
  if (linkError) throw linkError;
  if (data?.length !== ids.length) throw new ApiError(400, "An image asset is unavailable.");
}

export async function createRun(
  admin: Admin,
  ownerId: string,
  projectId: string,
  input: ResearchInput,
  idempotencyKey: string,
) {
  await ownedProject(admin, projectId, ownerId);
  const payload = {
    ...input,
    assetIds: input.imageAssetIds,
    unitCost: input.economics?.unitCost ?? null,
    minimumGrossMargin: input.economics?.minGrossMargin ?? null,
    priceUnit: input.priceUnit,
  };
  const { data: existing, error: existingError } = await admin.from("runs").select("*")
    .eq("owner_id", ownerId).eq("idempotency_key", idempotencyKey).maybeSingle();
  if (existingError) throw existingError;
  if (existing) {
    if (existing.project_id !== projectId) throw new ApiError(409, "Idempotency key belongs to another project.");
    await assertMatchingInitialInput(admin, existing.id, ownerId, payload);
    return existing;
  }

  await validateAndLinkAssets(admin, ownerId, projectId, input.imageAssetIds);
  const budget = budgetForMode(input.mode);
  const { data: runId, error } = await admin.rpc("create_research_run", {
    p_project_id: projectId,
    p_owner_id: ownerId,
    p_mode: input.mode,
    p_input: payload,
    p_budget_usd: budget,
    p_idempotency_key: idempotencyKey,
    p_daily_limit: dailyRunLimit(),
  });
  if (error) {
    if (error.message.includes("daily_run_limit_exceeded")) {
      throw new ApiError(429, "Daily research run limit reached. Try again tomorrow.");
    }
    if (error.code === "23505") {
      const { data: duplicate } = await admin.from("runs").select("*")
        .eq("owner_id", ownerId).eq("idempotency_key", idempotencyKey).maybeSingle();
      if (duplicate) {
        if (duplicate.project_id !== projectId) throw new ApiError(409, "Idempotency key belongs to another project.");
        await assertMatchingInitialInput(admin, duplicate.id, ownerId, payload);
        return duplicate;
      }
      throw new ApiError(409, "Another run started at the same time. Please retry.");
    }
    throw error;
  }
  const run = await ownedRun(admin, runId as string, ownerId);
  await assertMatchingInitialInput(admin, run.id, ownerId, payload);
  const status = run.status;
  const { error: eventError } = await admin.from("run_events").insert({
    run_id: run.id,
    owner_id: ownerId,
    kind: status === "queued" ? "queued" : "integration_blocked",
    stage: "intake",
    payload: {},
  });
  if (eventError && eventError.code !== "23505") throw eventError;
  const { error: projectError } = await admin.from("projects")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", projectId).eq("owner_id", ownerId);
  if (projectError) throw projectError;
  return run;
}

export async function createProjectAndRun(
  admin: Admin,
  ownerId: string,
  input: ResearchInput,
  idempotencyKey: string,
) {
  const { data: existing, error: existingError } = await admin.from("projects").select("*")
    .eq("owner_id", ownerId).eq("idempotency_key", idempotencyKey).maybeSingle();
  if (existingError) throw existingError;
  let project = existing;
  let created = false;
  if (!project) {
    const title = input.idea.replace(/\s+/g, " ").slice(0, 90);
    const { data, error } = await admin.from("projects").insert({
      owner_id: ownerId, title, idea: input.idea, idempotency_key: idempotencyKey,
    }).select("*").single();
    if (error) {
      if (error.code !== "23505") throw error;
      const duplicate = await admin.from("projects").select("*")
        .eq("owner_id", ownerId).eq("idempotency_key", idempotencyKey).single();
      if (duplicate.error) throw duplicate.error;
      project = duplicate.data;
    } else {
      project = data;
      created = true;
    }
  }
  if (project.idea !== input.idea) throw new ApiError(409, "Idempotency key belongs to another idea.");
  let run;
  try {
    run = await createRun(admin, ownerId, project.id, input, idempotencyKey);
  } catch (error) {
    if (created) {
      await admin.from("projects").delete().eq("id", project.id).eq("owner_id", ownerId);
    }
    throw error;
  }
  const { data: initialMessage, error: messageError } = await admin.from("messages").select("id")
    .eq("project_id", project.id).eq("role", "user").limit(1);
  if (messageError) throw messageError;
  if (!initialMessage?.length) {
    const { error } = await admin.from("messages").insert({
      project_id: project.id, owner_id: ownerId, run_id: run.id,
      role: "user", content: input.idea,
    });
    if (error) throw error;
  }
  return { project, run };
}

export function idempotencyKey(request: Request, body?: unknown): string {
  const fromHeader = request.headers.get("idempotency-key");
  const fromBody = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).idempotencyKey : undefined;
  const key = typeof fromHeader === "string" && fromHeader.trim() ? fromHeader.trim()
    : typeof fromBody === "string" && fromBody.trim() ? fromBody.trim() : crypto.randomUUID();
  if (key.length > 128) throw new ApiError(400, "Idempotency key is too long.");
  return key;
}
