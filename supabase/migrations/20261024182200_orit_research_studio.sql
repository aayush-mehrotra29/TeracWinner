-- Orit research studio persistence. Owner IDs identify private browser workspaces
-- created by the local server; they are not Supabase Auth users. Only the server's
-- service role can access these records through the Data API.
create extension if not exists pgmq;
create schema if not exists private;
select pgmq.create('research_runs');

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  title text not null check (char_length(title) between 1 and 160),
  idea text not null check (char_length(idea) between 1 and 12000),
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_id),
  unique (owner_id, idempotency_key)
);

create table public.runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  owner_id uuid not null,
  mode text not null check (mode in ('light_research', 'light_simulation', 'deep_simulation')),
  status text not null default 'queued' check (status in (
    'queued', 'running', 'needs_input', 'awaiting_approval', 'awaiting_humans',
    'completed', 'failed', 'integration_blocked'
  )),
  stage text not null default 'intake',
  input jsonb not null default '{}'::jsonb check (jsonb_typeof(input) = 'object'),
  version integer not null default 1 check (version > 0),
  budget_usd numeric(12, 6) not null default 0 check (budget_usd >= 0),
  spent_usd numeric(12, 6) not null default 0 check (spent_usd >= 0),
  worker_lease_owner text,
  worker_lease_expires_at timestamptz,
  idempotency_key text,
  error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key (project_id, owner_id) references public.projects(id, owner_id) on delete cascade,
  unique (id, owner_id),
  unique (project_id, version),
  unique (owner_id, idempotency_key)
);
create index runs_project_created_idx on public.runs(project_id, created_at desc);
create index runs_status_created_idx on public.runs(status, created_at);
create index runs_owner_created_idx on public.runs(owner_id, created_at desc);
create index runs_worker_lease_idx on public.runs(worker_lease_expires_at)
  where worker_lease_expires_at is not null;

create table public.run_input_versions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  owner_id uuid not null,
  revision integer not null check (revision > 0),
  input jsonb not null check (jsonb_typeof(input) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (run_id, owner_id) references public.runs(id, owner_id) on delete cascade,
  unique (run_id, revision)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  owner_id uuid not null,
  run_id uuid,
  report_version integer check (report_version is null or report_version > 0),
  idempotency_key text,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) between 1 and 12000),
  citations jsonb not null default '[]'::jsonb check (jsonb_typeof(citations) = 'array'),
  created_at timestamptz not null default now(),
  foreign key (project_id, owner_id) references public.projects(id, owner_id) on delete cascade,
  foreign key (run_id, owner_id) references public.runs(id, owner_id) on delete set null (run_id)
);
create index messages_project_created_idx on public.messages(project_id, created_at);
create unique index messages_idempotency_uniq on public.messages(owner_id, idempotency_key, role)
  where idempotency_key is not null;

create table public.run_events (
  seq bigint generated always as identity primary key,
  run_id uuid not null,
  owner_id uuid not null,
  kind text not null,
  stage text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (run_id, owner_id) references public.runs(id, owner_id) on delete cascade
);
create index run_events_run_seq_idx on public.run_events(run_id, seq);
create unique index run_initial_event_uniq on public.run_events(run_id, kind)
  where stage = 'intake' and kind in ('queued', 'integration_blocked');

create table public.run_artifacts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  owner_id uuid not null,
  kind text not null,
  key text not null default 'main',
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (run_id, owner_id) references public.runs(id, owner_id) on delete cascade,
  unique (run_id, kind, key)
);
create index run_artifacts_run_kind_idx on public.run_artifacts(run_id, kind);

create table public.report_versions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  owner_id uuid not null,
  version integer not null check (version > 0),
  kind text not null check (kind in ('synthetic', 'human_addendum')),
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  pdf_path text,
  created_at timestamptz not null default now(),
  foreign key (run_id, owner_id) references public.runs(id, owner_id) on delete cascade,
  unique (run_id, version)
);

create table public.model_calls (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  owner_id uuid not null,
  request_key text not null,
  request_id text not null,
  response_id text,
  stage text not null,
  model text not null,
  reasoning_effort text,
  prompt_version text not null,
  schema_version text not null,
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  cost_usd numeric(12, 6) not null default 0 check (cost_usd >= 0),
  status text not null,
  error jsonb,
  created_at timestamptz not null default now(),
  foreign key (run_id, owner_id) references public.runs(id, owner_id) on delete cascade,
  unique (run_id, request_key)
);
create index model_calls_run_created_idx on public.model_calls(run_id, created_at);

create table public.stage_attempts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  owner_id uuid not null,
  stage text not null,
  input_hash text not null check (char_length(input_hash) = 64),
  version text not null,
  attempt integer not null check (attempt > 0),
  status text not null,
  error jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key (run_id, owner_id) references public.runs(id, owner_id) on delete cascade,
  unique (run_id, stage, attempt)
);
create index stage_attempts_run_stage_idx on public.stage_attempts(run_id, stage, started_at);

create table public.provider_calls (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  owner_id uuid not null,
  stage text not null,
  provider text not null,
  operation text not null,
  request_key text not null,
  request_id text,
  status text not null,
  cost_usd numeric(12, 6) not null default 0 check (cost_usd >= 0),
  estimated boolean not null default false,
  error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (run_id, owner_id) references public.runs(id, owner_id) on delete cascade,
  unique (run_id, provider, operation, request_key)
);
create index provider_calls_run_created_idx on public.provider_calls(run_id, created_at);

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  project_id uuid,
  path text not null unique,
  mime_type text not null check (mime_type in ('image/png', 'image/jpeg', 'image/webp')),
  byte_size integer not null check (byte_size > 0 and byte_size <= 10485760),
  created_at timestamptz not null default now(),
  foreign key (project_id, owner_id) references public.projects(id, owner_id) on delete set null (project_id)
);

create table public.human_studies (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null unique,
  owner_id uuid not null,
  status text not null default 'pending_feasibility',
  target_count integer not null default 12 check (target_count between 1 and 100),
  quote jsonb,
  materials jsonb not null default '{}'::jsonb,
  provider_id text,
  response_token_hash text,
  approved_fingerprint text,
  approval_at timestamptz,
  launched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (run_id, owner_id) references public.runs(id, owner_id) on delete cascade,
  unique (id, owner_id)
);
create unique index human_studies_token_uniq on public.human_studies(response_token_hash)
  where response_token_hash is not null;

create table public.human_responses (
  id uuid primary key default gen_random_uuid(),
  study_id uuid not null,
  owner_id uuid not null,
  provider_submission_id text,
  provider_status text not null default 'unconfirmed'
    check (provider_status in ('unconfirmed', 'confirmed', 'disputed')),
  provider_confirmed_at timestamptz,
  answers jsonb not null check (jsonb_typeof(answers) = 'object'),
  review_status text not null default 'pending' check (review_status in ('pending', 'accepted', 'rejected')),
  created_at timestamptz not null default now(),
  foreign key (study_id, owner_id) references public.human_studies(id, owner_id) on delete cascade
);
create unique index human_responses_submission_uniq
  on public.human_responses(study_id, provider_submission_id)
  where provider_submission_id is not null;

-- Bound uploads and anonymous form writes independently of the daily run cap.
create function private.guard_asset_quota() returns trigger language plpgsql
  set search_path = '' as $$
declare
  v_unlinked integer;
  v_total integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('asset:' || new.owner_id::text, 0));
  select count(*), count(*) filter (where project_id is null)
    into v_total, v_unlinked from public.assets where owner_id = new.owner_id;
  if v_unlinked >= 20 or v_total >= 500 then
    raise exception 'asset_quota_exceeded' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger assets_quota before insert on public.assets
  for each row execute function private.guard_asset_quota();

create function private.guard_response_quota() returns trigger language plpgsql
  set search_path = '' as $$
declare
  v_target integer;
  v_count integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('study:' || new.study_id::text, 0));
  select target_count into v_target from public.human_studies where id = new.study_id;
  select count(*) into v_count from public.human_responses where study_id = new.study_id;
  if v_count >= least(greatest(coalesce(v_target, 12) * 5, 24), 200) then
    raise exception 'study_response_quota_exceeded' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger responses_quota before insert on public.human_responses
  for each row execute function private.guard_response_quota();

create function private.touch_updated_at() returns trigger language plpgsql
  set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger projects_touch before update on public.projects
  for each row execute function private.touch_updated_at();
create trigger runs_touch before update on public.runs
  for each row execute function private.touch_updated_at();
create trigger artifacts_touch before update on public.run_artifacts
  for each row execute function private.touch_updated_at();
create trigger studies_touch before update on public.human_studies
  for each row execute function private.touch_updated_at();
create trigger provider_calls_touch before update on public.provider_calls
  for each row execute function private.touch_updated_at();

create function private.capture_run_input() returns trigger language plpgsql
  set search_path = '' as $$
declare
  v_revision integer;
begin
  select coalesce(max(revision), 0) + 1 into v_revision
    from public.run_input_versions where run_id = new.id;
  insert into public.run_input_versions(run_id, owner_id, revision, input)
    values (new.id, new.owner_id, v_revision, new.input);
  return new;
end;
$$;
create trigger runs_input_snapshot after insert or update of input on public.runs
  for each row execute function private.capture_run_input();

-- The app may only enqueue by inserting a queued run or resuming a paused one.
-- This trigger runs in the same transaction as the status change.
create function private.enqueue_research_run() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'queued' then
    if tg_op = 'INSERT' then
      perform pgmq.send('research_runs', jsonb_build_object('runId', new.id));
    elsif old.status is distinct from new.status then
      perform pgmq.send('research_runs', jsonb_build_object('runId', new.id));
    end if;
  end if;
  return new;
end;
$$;
create trigger runs_enqueue after insert or update of status on public.runs
  for each row execute function private.enqueue_research_run();

-- Queue operations are server-only. Neither the browser nor the authenticated
-- PostgREST role has access to the queue functions or underlying queue tables.
create function public.claim_research_jobs(
  p_visibility_seconds integer default 300,
  p_qty integer default 1
) returns table(msg_id bigint, read_ct bigint, message jsonb)
  language sql security definer set search_path = '' as $$
  select q.msg_id, q.read_ct, q.message
  from pgmq.read('research_runs', least(greatest(p_visibility_seconds, 30), 3600),
    least(greatest(p_qty, 1), 10)) as q;
$$;
create function public.ack_research_job(p_message_id bigint) returns boolean
  language sql security definer set search_path = '' as $$
  select pgmq.archive('research_runs', p_message_id);
$$;

-- All paid run creation goes through one transaction to enforce the UTC daily
-- limit even when a user submits requests concurrently.
create function public.create_research_run(
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
  v_status text;
begin
  if p_daily_limit < 1 or p_daily_limit > 1000 or
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
  v_status := case when p_budget_usd is null or p_budget_usd <= 0
    then 'integration_blocked' else 'queued' end;
  select count(*) into v_count from public.runs
    where owner_id = p_owner_id
      and created_at >= (pg_catalog.date_trunc('day', now() at time zone 'UTC') at time zone 'UTC');
  if v_count >= p_daily_limit then
    raise exception 'daily_run_limit_exceeded' using errcode = 'P0001';
  end if;
  select coalesce(max(version), 0) + 1 into v_version from public.runs where project_id = p_project_id;
  insert into public.runs(project_id, owner_id, mode, status, stage, input, version,
    budget_usd, idempotency_key, error)
  values (p_project_id, p_owner_id, p_mode, v_status, 'intake', p_input, v_version,
    coalesce(p_budget_usd, 0), p_idempotency_key,
    case when v_status = 'integration_blocked' then
      jsonb_build_object('code', 'budget_not_configured',
        'message', 'This research mode needs a configured budget.') else null end)
  returning id into v_id;
  return v_id;
end;
$$;

create function public.acquire_research_run_lease(
  p_run_id uuid,
  p_owner text,
  p_ttl_seconds integer default 1800
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  v_id uuid;
begin
  if p_owner is null or length(p_owner) < 8 or length(p_owner) > 128 then
    raise exception 'invalid_lease_owner' using errcode = '22023';
  end if;
  update public.runs
    set worker_lease_owner = p_owner,
        worker_lease_expires_at = now() + pg_catalog.make_interval(
          secs => least(greatest(p_ttl_seconds, 60), 3600))
    where id = p_run_id and (
      worker_lease_expires_at is null or worker_lease_expires_at < now()
      or worker_lease_owner = p_owner
    )
    returning id into v_id;
  return v_id is not null;
end;
$$;

create function public.release_research_run_lease(
  p_run_id uuid,
  p_owner text
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  v_id uuid;
begin
  update public.runs
    set worker_lease_owner = null, worker_lease_expires_at = null
    where id = p_run_id and worker_lease_owner = p_owner
    returning id into v_id;
  return v_id is not null;
end;
$$;

alter table public.projects enable row level security;
alter table public.runs enable row level security;
alter table public.run_input_versions enable row level security;
alter table public.messages enable row level security;
alter table public.run_events enable row level security;
alter table public.run_artifacts enable row level security;
alter table public.report_versions enable row level security;
alter table public.model_calls enable row level security;
alter table public.stage_attempts enable row level security;
alter table public.provider_calls enable row level security;
alter table public.assets enable row level security;
alter table public.human_studies enable row level security;
alter table public.human_responses enable row level security;

-- No browser has direct Data API access. The server derives a private owner ID
-- from the browser's opaque cookie and applies owner filters on every query.
revoke all on public.projects, public.runs, public.run_input_versions, public.messages, public.run_events,
  public.run_artifacts, public.report_versions, public.model_calls, public.assets,
  public.stage_attempts, public.provider_calls,
  public.human_studies, public.human_responses from anon, authenticated;
grant select, insert, update, delete on public.projects, public.runs, public.run_input_versions, public.messages,
  public.run_events, public.run_artifacts, public.report_versions, public.model_calls,
  public.stage_attempts, public.provider_calls,
  public.assets, public.human_studies, public.human_responses to service_role;
grant usage, select on all sequences in schema public to service_role;

revoke all on function public.claim_research_jobs(integer, integer) from public, anon, authenticated;
revoke all on function public.ack_research_job(bigint) from public, anon, authenticated;
revoke all on function public.create_research_run(uuid, uuid, text, jsonb, numeric, text, integer)
  from public, anon, authenticated;
revoke all on function public.acquire_research_run_lease(uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.release_research_run_lease(uuid, text)
  from public, anon, authenticated;
grant execute on function public.claim_research_jobs(integer, integer) to service_role;
grant execute on function public.ack_research_job(bigint) to service_role;
grant execute on function public.create_research_run(uuid, uuid, text, jsonb, numeric, text, integer)
  to service_role;
grant execute on function public.acquire_research_run_lease(uuid, text, integer)
  to service_role;
grant execute on function public.release_research_run_lease(uuid, text)
  to service_role;
revoke all on schema private from public, anon, authenticated;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('research-images', 'research-images', false, 10485760,
  array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update set public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('research-reports', 'research-reports', false, 10485760,
  array['application/pdf'])
on conflict (id) do update set public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
