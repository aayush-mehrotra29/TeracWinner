import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkspaceToken, ownerIdForWorkspaceToken, validWorkspaceToken,
  WORKSPACE_COOKIE, workspaceCookieOptions, workspaceSecret,
} from "../../src/lib/api/workspace-identity";

const secret = Buffer.alloc(32, 7);

test("each browser token identifies one stable, distinct UUID workspace", () => {
  const first = createWorkspaceToken(secret);
  const second = createWorkspaceToken(secret);
  assert.ok(validWorkspaceToken(first, secret));
  assert.ok(validWorkspaceToken(second, secret));
  assert.notEqual(first, second);
  const firstOwner = ownerIdForWorkspaceToken(first, secret);
  assert.match(firstOwner, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(ownerIdForWorkspaceToken(first, secret), firstOwner);
  assert.notEqual(ownerIdForWorkspaceToken(second, secret), firstOwner);
  assert.equal(validWorkspaceToken(first, Buffer.alloc(32, 8)), false);
});

test("only canonical 256-bit browser credentials are accepted", () => {
  const valid = createWorkspaceToken(secret);
  for (const malformed of [undefined, "", "a", "0".repeat(43), "x".repeat(44),
    "A".repeat(42) + "!", valid.slice(0, -1) + (valid.endsWith("a") ? "b" : "a")]) {
    assert.equal(validWorkspaceToken(malformed, secret), false);
  }
  assert.throws(() => ownerIdForWorkspaceToken("visitor-chosen-id", secret));
});

test("server identity secret requires exactly 32 base64-encoded random bytes", () => {
  const previous = process.env.ORIT_WORKSPACE_SECRET;
  try {
    process.env.ORIT_WORKSPACE_SECRET = secret.toString("base64");
    assert.deepEqual(workspaceSecret(), secret);
    process.env.ORIT_WORKSPACE_SECRET = "too-short";
    assert.equal(workspaceSecret(), null);
  } finally {
    if (previous === undefined) delete process.env.ORIT_WORKSPACE_SECRET;
    else process.env.ORIT_WORKSPACE_SECRET = previous;
  }
});

test("local workspace credential stays HTTP-only and host-scoped", () => {
  const options = workspaceCookieOptions(false);
  assert.equal(WORKSPACE_COOKIE, "orit_workspace_v1");
  assert.equal(options.httpOnly, true);
  assert.equal(options.sameSite, "lax");
  assert.equal(options.path, "/");
  assert.equal(options.secure, false);
  assert.ok(options.maxAge >= 60 * 60 * 24 * 30);
  assert.equal(workspaceCookieOptions(true).secure, true);
});
