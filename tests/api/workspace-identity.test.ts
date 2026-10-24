import assert from "node:assert/strict";
import test from "node:test";
import {
  localWorkspaceOwnerId, workspaceSecret, WorkspaceSecretUnavailableError,
} from "../../src/lib/api/workspace-identity";

const secret = Buffer.alloc(32, 7);

function withIdentityEnvironment(action: () => void) {
  const previousSecret = process.env.ORIT_WORKSPACE_SECRET;
  const previousOwner = process.env.ORIT_LOCAL_OWNER_ID;
  try { action(); } finally {
    if (previousSecret === undefined) delete process.env.ORIT_WORKSPACE_SECRET;
    else process.env.ORIT_WORKSPACE_SECRET = previousSecret;
    if (previousOwner === undefined) delete process.env.ORIT_LOCAL_OWNER_ID;
    else process.env.ORIT_LOCAL_OWNER_ID = previousOwner;
  }
}

test("all browser contexts on one local server use the same owner", () => withIdentityEnvironment(() => {
  delete process.env.ORIT_LOCAL_OWNER_ID;
  process.env.ORIT_WORKSPACE_SECRET = secret.toString("base64");
  const first = localWorkspaceOwnerId();
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(localWorkspaceOwnerId(), first);
  process.env.ORIT_WORKSPACE_SECRET = Buffer.alloc(32, 8).toString("base64");
  assert.notEqual(localWorkspaceOwnerId(), first);
}));

test("an existing local owner can be retained across the identity change", () => withIdentityEnvironment(() => {
  process.env.ORIT_WORKSPACE_SECRET = secret.toString("base64");
  process.env.ORIT_LOCAL_OWNER_ID = "86E7B651-0D1A-410E-BA7B-FFEC57712B64";
  assert.equal(localWorkspaceOwnerId(), "86e7b651-0d1a-410e-ba7b-ffec57712b64");
  process.env.ORIT_LOCAL_OWNER_ID = "not-a-uuid";
  assert.throws(() => localWorkspaceOwnerId(), WorkspaceSecretUnavailableError);
}));

test("server identity secret requires exactly 32 base64-encoded bytes", () => withIdentityEnvironment(() => {
  delete process.env.ORIT_LOCAL_OWNER_ID;
  process.env.ORIT_WORKSPACE_SECRET = secret.toString("base64");
  assert.deepEqual(workspaceSecret(), secret);
  process.env.ORIT_WORKSPACE_SECRET = "too-short";
  assert.equal(workspaceSecret(), null);
  assert.throws(() => localWorkspaceOwnerId(), WorkspaceSecretUnavailableError);
}));
