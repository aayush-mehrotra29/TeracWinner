import { cookies, headers } from "next/headers";
import { PersistenceUnavailableError } from "@/lib/db/admin";
import {
  createWorkspaceToken, ownerIdForWorkspaceToken, validWorkspaceToken,
  WORKSPACE_COOKIE, workspaceCookieOptions, workspaceSecret, WorkspaceSecretUnavailableError,
} from "@/lib/api/workspace-identity";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function requireUser() {
  const secret = workspaceSecret();
  if (!secret) throw new WorkspaceSecretUnavailableError();
  const requestHeaders = await headers();
  const origin = requestHeaders.get("origin");
  const host = requestHeaders.get("host");
  // The browser session is a bearer capability. Reject cross-origin browser
  // requests before they can use it for paid runs or study approvals.
  if (origin) {
    let originHost: string;
    try { originHost = new URL(origin).host; } catch { throw new ApiError(403, "Cross-origin request denied."); }
    if (!host || originHost !== host) throw new ApiError(403, "Cross-origin request denied.");
  }
  if (requestHeaders.get("sec-fetch-site") === "cross-site") {
    throw new ApiError(403, "Cross-origin request denied.");
  }

  const cookieStore = await cookies();
  const existing = cookieStore.get(WORKSPACE_COOKIE)?.value;
  const token = validWorkspaceToken(existing, secret) ? existing : createWorkspaceToken(secret);
  if (token !== existing) {
    cookieStore.set(WORKSPACE_COOKIE, token,
      workspaceCookieOptions(requestHeaders.get("x-forwarded-proto") === "https"));
  }
  return { id: ownerIdForWorkspaceToken(token, secret) };
}

export async function readJson(request: Request, maxBytes = 32_768): Promise<unknown> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("application/json")) {
    throw new ApiError(415, "Expected JSON.");
  }
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > maxBytes) {
    throw new ApiError(413, "Request is too large.");
  }
  const body = await request.text();
  if (body.length > maxBytes) throw new ApiError(413, "Request is too large.");
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ApiError(400, "Invalid JSON.");
  }
}

export function apiErrorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof PersistenceUnavailableError) {
    return Response.json({ error: error.message }, { status: 503 });
  }
  if (error instanceof WorkspaceSecretUnavailableError) {
    return Response.json({ error: error.message }, { status: 503 });
  }
  console.error("Research API error", error);
  return Response.json({ error: "Request failed. Please try again." }, { status: 500 });
}

export function privateJson(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "private, no-store" } });
}
