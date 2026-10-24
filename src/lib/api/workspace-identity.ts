import { createHmac } from "node:crypto";

const SECRET_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class WorkspaceSecretUnavailableError extends Error {
  constructor(message = "Local workspace identity is not configured.") { super(message); }
}

/** Keep the identity key outside client bundles and stable across server restarts. */
export function workspaceSecret(): Buffer | null {
  const encoded = process.env.ORIT_WORKSPACE_SECRET;
  if (!encoded || !SECRET_PATTERN.test(encoded)) return null;
  const decoded = Buffer.from(encoded, "base64");
  return decoded.length === 32 && decoded.toString("base64") === encoded ? decoded : null;
}

/** One local server has one workspace, regardless of browser cookies or tabs. */
export function localWorkspaceOwnerId(): string {
  const configured = process.env.ORIT_LOCAL_OWNER_ID?.trim();
  if (configured) {
    if (!UUID_PATTERN.test(configured)) {
      throw new WorkspaceSecretUnavailableError("ORIT_LOCAL_OWNER_ID must be a UUID.");
    }
    return configured.toLowerCase();
  }

  const secret = workspaceSecret();
  if (!secret) throw new WorkspaceSecretUnavailableError();
  const bytes = createHmac("sha256", secret)
    .update("orit-local-workspace-owner:v1").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
