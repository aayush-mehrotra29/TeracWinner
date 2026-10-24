import type { SupabaseClient } from "@supabase/supabase-js";

export async function humanPollPage(db: SupabaseClient, cursor: number, pageSize = 12): Promise<{ ids: string[]; nextCursor: number }> {
  const fetchPage = (offset: number) => db.from("runs").select("id", { count: "exact" })
    // A worker can stop after the first response has opened the model stages.
    // Poll running deep runs as well so saved stage artifacts can be resumed.
    .eq("mode", "deep_simulation").in("status", ["awaiting_humans", "running"])
    .order("id", { ascending: true }).range(offset, offset + pageSize - 1);
  let offset = cursor;
  let page = await fetchPage(offset);
  if (page.error) throw new Error(`Unable to poll deep studies: ${page.error.message}`);
  if (!page.data?.length && offset > 0) {
    offset = 0;
    page = await fetchPage(offset);
    if (page.error) throw new Error(`Unable to poll deep studies: ${page.error.message}`);
  }
  const ids = (page.data ?? []).map((row) => row.id);
  const nextCursor = ids.length === pageSize && (page.count === null || offset + ids.length < page.count)
    ? offset + ids.length : 0;
  return { ids, nextCursor };
}
