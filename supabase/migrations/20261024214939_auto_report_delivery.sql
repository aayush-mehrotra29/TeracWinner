-- Existing email intakes must not send completed reports retroactively.
-- A new intake handoff opts in only after it links the intended research run.
alter table public.outreach_intakes
  add column auto_report_delivery_enabled boolean not null default false;

-- The linked intake's run must match the delivery's run; the existing single
-- column unique index on research_run_id does not serve as a composite FK key.
alter table public.outreach_intakes
  add constraint outreach_intakes_message_run_uniq unique (message_key, research_run_id);

-- One durable delivery decision per saved report version. A skipped row may
-- have no recipient when the saved intake has no usable sender address.
create table public.report_deliveries (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  owner_id uuid not null,
  report_version integer not null check (report_version > 0),
  intake_message_key text,
  recipient text,
  message_id text,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'uncertain', 'skipped')),
  claimed_at timestamptz,
  sent_at timestamptz,
  error text check (error is null or char_length(error) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (run_id, owner_id) references public.runs(id, owner_id) on delete cascade,
  foreign key (run_id, report_version) references public.report_versions(run_id, version) on delete cascade,
  foreign key (intake_message_key, run_id)
    references public.outreach_intakes(message_key, research_run_id),
  unique (run_id, report_version),
  unique (message_id),
  check (status = 'skipped' or (
    intake_message_key is not null and recipient is not null and recipient <> ''
  )),
  check (status not in ('sending', 'sent', 'uncertain') or
    (message_id is not null and message_id <> '')),
  check (recipient is null or recipient = lower(recipient)),
  check (status <> 'sent' or sent_at is not null)
);

create index report_deliveries_work_idx
  on public.report_deliveries(status, claimed_at, created_at)
  where status in ('pending', 'sending', 'uncertain');

create trigger report_deliveries_touch before update on public.report_deliveries
  for each row execute function private.touch_updated_at();

alter table public.report_deliveries enable row level security;
revoke all on public.report_deliveries from public, anon, authenticated;
grant select, insert, update, delete on public.report_deliveries to service_role;

-- The research worker updates runs as service_role. This invoker trigger adds
-- the delivery row in that same transaction only when a newly completed run
-- belongs to an explicitly opted-in, linked Gmail intake. Existing completed
-- runs and earlier synthetic versions of a deep study cannot be enqueued.
create function private.enqueue_completed_report_delivery() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  v_intake_message_key text;
  v_sender text;
  v_recipient text;
  v_report_version integer;
begin
  select message_key, sender into v_intake_message_key, v_sender
    from public.outreach_intakes
    where research_run_id = new.id
      and research_owner_id = new.owner_id
      and research_status = 'linked'
      and auto_report_delivery_enabled = true;
  if not found then return new; end if;

  select version into v_report_version
    from public.report_versions
    where run_id = new.id and owner_id = new.owner_id
    order by version desc limit 1;
  if not found then return new; end if;

  v_recipient := nullif(lower(trim(v_sender)), '');

  insert into public.report_deliveries (
    run_id, owner_id, report_version, intake_message_key, recipient, status, error
  ) values (
    new.id, new.owner_id, v_report_version,
    v_intake_message_key, v_recipient,
    case when v_recipient is null then 'skipped' else 'pending' end,
    case when v_recipient is null then 'Saved intake has no sender address' else null end
  ) on conflict (run_id, report_version) do nothing;
  return new;
end;
$$;

create trigger runs_enqueue_report_delivery
  after update of status on public.runs
  for each row when (new.status = 'completed' and old.status is distinct from 'completed')
  execute function private.enqueue_completed_report_delivery();

-- Run creation queues work before the intake handoff commits its link. If a
-- resumed or unusually fast run completes first, enqueue at that new link as
-- well. Locking the run row makes a concurrent completion/link transition
-- serialize; the unique delivery key keeps both paths idempotent. Changing an
-- already linked historical intake from opt-out to opt-in does not fire this.
create function private.enqueue_late_linked_report_delivery() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  v_status text;
  v_report_version integer;
  v_recipient text;
begin
  select status into v_status from public.runs
    where id = new.research_run_id and owner_id = new.research_owner_id
    for update;
  if not found or v_status <> 'completed' then return new; end if;

  select version into v_report_version
    from public.report_versions
    where run_id = new.research_run_id and owner_id = new.research_owner_id
    order by version desc limit 1;
  if not found then return new; end if;

  v_recipient := nullif(lower(trim(new.sender)), '');
  insert into public.report_deliveries (
    run_id, owner_id, report_version, intake_message_key, recipient, status, error
  ) values (
    new.research_run_id, new.research_owner_id, v_report_version,
    new.message_key, v_recipient,
    case when v_recipient is null then 'skipped' else 'pending' end,
    case when v_recipient is null then 'Saved intake has no sender address' else null end
  ) on conflict (run_id, report_version) do nothing;
  return new;
end;
$$;

create trigger outreach_intakes_enqueue_late_report_delivery
  after update of research_status, auto_report_delivery_enabled on public.outreach_intakes
  for each row when (
    new.research_status = 'linked'
    and new.auto_report_delivery_enabled = true
    and old.research_status is distinct from 'linked'
  ) execute function private.enqueue_late_linked_report_delivery();
