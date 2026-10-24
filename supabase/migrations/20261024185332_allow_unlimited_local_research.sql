-- A zero USD budget and a zero daily limit mean "no cap" for this local
-- workspace. Keep the fields for optional caps and for cost accounting.
create or replace function public.create_research_run(
  p_project_id uuid,
  p_owner_id uuid,
  p_mode text,
  p_input jsonb,
  p_budget_usd numeric,
  p_idempotency_key text,
  p_daily_limit integer
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  v_existing public.runs%rowtype;
  v_id uuid;
  v_version integer;
  v_count integer;
begin
  if p_daily_limit is null or p_daily_limit < 0 or p_daily_limit > 1000 or
     coalesce(p_budget_usd, 0) < 0 or
     p_idempotency_key is null or length(p_idempotency_key) > 128 or
     jsonb_typeof(p_input) <> 'object' then
    raise exception 'invalid_run_request' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_id::text, 0));
  select * into v_existing from public.runs
    where owner_id = p_owner_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.project_id <> p_project_id then
      raise exception 'idempotency_conflict' using errcode = '23505';
    end if;
    return v_existing.id;
  end if;
  if not exists (select 1 from public.projects where id = p_project_id and owner_id = p_owner_id) then
    raise exception 'project_not_found' using errcode = '23503';
  end if;
  if p_daily_limit > 0 then
    select count(*) into v_count from public.runs
      where owner_id = p_owner_id
        and created_at >= (pg_catalog.date_trunc('day', now() at time zone 'UTC') at time zone 'UTC');
    if v_count >= p_daily_limit then
      raise exception 'daily_run_limit_exceeded' using errcode = 'P0001';
    end if;
  end if;
  select coalesce(max(version), 0) + 1 into v_version from public.runs where project_id = p_project_id;
  insert into public.runs(project_id, owner_id, mode, status, stage, input, version,
    budget_usd, idempotency_key, error)
  values (p_project_id, p_owner_id, p_mode, 'queued', 'intake', p_input, v_version,
    coalesce(p_budget_usd, 0), p_idempotency_key, null)
  returning id into v_id;
  return v_id;
end;
$$;
