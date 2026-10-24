import assert from "node:assert/strict";
import test from "node:test";
import { createAdminClient, PersistenceUnavailableError } from "../../src/lib/db/admin";
import { IntegrationBlockedError } from "../../src/lib/providers/errors";
import { ResearchStore } from "../../src/lib/research/store";

test("publishable Supabase keys cannot masquerade as server credentials", () => {
  const priorUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const priorKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_publishable_fixture";
  try {
    assert.throws(() => createAdminClient(), PersistenceUnavailableError);
    assert.throws(() => new ResearchStore(), IntegrationBlockedError);
  } finally {
    if (priorUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = priorUrl;
    if (priorKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = priorKey;
  }
});
