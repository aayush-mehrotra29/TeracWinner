import { createClient } from "@supabase/supabase-js";

export class PersistenceUnavailableError extends Error {}

/** Server-only client. Never import this module from a Client Component. */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new PersistenceUnavailableError("Research persistence is not configured.");
  }
  if (serviceKey.startsWith("sb_publishable_")) {
    throw new PersistenceUnavailableError("SUPABASE_SERVICE_ROLE_KEY needs an OritApp server secret (sb_secret_...) or legacy service_role key.");
  }

  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
