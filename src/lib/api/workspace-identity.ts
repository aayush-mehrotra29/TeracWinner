import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const WORKSPACE_COOKIE = "orit_workspace_v1";
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/;
const SECRET_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export class WorkspaceSecretUnavailableError extends Error {
  constructor() { super("Local workspace identity is not configured."); }
}

/** Keep the identity key outside client bundles and stable across server restarts. */
export function workspaceSecret(): Buffer | null {
  const encoded = process.env.ORIT_WORKSPACE_SECRET;
  if (!encoded || !SECRET_PATTERN.test(encoded)) return null;
  const decoded = Buffer.from(encoded, "base64");
  return decoded.length === TOKEN_BYTES && decoded.toString("base64") === encoded ? decoded : null;
}

function signature(payload: string, secret: Buffer): Buffer {
  return createHmac("sha256", secret).update("orit-workspace-token:v1:").update(payload).digest();
}

/** This random cookie is the local workspace's private bearer credential. */
export function createWorkspaceToken(secret: Buffer): string {
  const payload = randomBytes(TOKEN_BYTES).toString("base64url");
  return `${payload}.${signature(payload, secret).toString("base64url")}`;
}

export function validWorkspaceToken(value: string | undefined, secret: Buffer): value is string {
  const match = value?.match(TOKEN_PATTERN);
  if (!match) return false;
  const payload = Buffer.from(match[1], "base64url");
  const signed = Buffer.from(match[2], "base64url");
  if (payload.length !== TOKEN_BYTES || signed.length !== TOKEN_BYTES ||
      payload.toString("base64url") !== match[1] || signed.toString("base64url") !== match[2]) return false;
  return timingSafeEqual(signed, signature(match[1], secret));
}

/** No Supabase Auth account is needed; every private row retains a UUID owner. */
export function ownerIdForWorkspaceToken(token: string, secret: Buffer): string {
  if (!validWorkspaceToken(token, secret)) throw new Error("Invalid workspace token.");
  const bytes = createHmac("sha256", secret)
    .update("orit-workspace-owner:v1:").update(token.split(".", 1)[0]).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function workspaceCookieOptions(secure: boolean) {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    maxAge: ONE_YEAR_SECONDS,
  };
}
