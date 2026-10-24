alter table public.outreach_intakes
  add column body_text text check (length(body_text) <= 20000),
  add column body_incomplete boolean not null default false,
  add column attachment_names jsonb not null default '[]'::jsonb check (jsonb_typeof(attachment_names) = 'array' and jsonb_array_length(attachment_names) <= 50),
  add column lead_id bigint references public.outreach_leads(id) on delete set null;
create index outreach_intakes_lead_id on public.outreach_intakes(lead_id) where lead_id is not null;

alter table public.outreach_candidates
  add column attempts integer not null default 0 check (attempts between 0 and 3),
  add column next_attempt_at timestamptz not null default now(),
  add column discovery_provider text not null default 'openai',
  add column discovered_at timestamptz not null default now();
create index outreach_candidates_pending on public.outreach_candidates(status,next_attempt_at,id);

create or replace function public.orit_candidate() returns jsonb language plpgsql security definer set search_path='' as $$
declare candidate public.outreach_candidates;
begin
  update public.outreach_candidates set status='skipped'
    where attempts>=3 and (status='pending' or (status='processing' and claimed_at<now()-interval '10 minutes'));
  select * into candidate from public.outreach_candidates
    where attempts<3 and ((status='pending' and next_attempt_at<=now()) or (status='processing' and claimed_at<now()-interval '10 minutes'))
    order by id limit 1 for update skip locked;
  if candidate.id is null then return null; end if;
  update public.outreach_candidates set status='processing',claimed_at=now(),attempts=attempts+1 where id=candidate.id;
  return jsonb_build_object('id',candidate.id,'website',candidate.website,'attempts',candidate.attempts+1);
end $$;

create function public.orit_finish_candidate(p_id bigint,p_outcome text) returns void language plpgsql security definer set search_path='' as $$
begin
  if p_outcome not in ('verified','skipped','retry') then raise exception 'Invalid candidate outcome'; end if;
  update public.outreach_candidates set
    status=case when p_outcome='retry' and attempts<3 then 'pending' when p_outcome='retry' then 'skipped' else p_outcome end,
    next_attempt_at=case when p_outcome='retry' then now()+interval '15 minutes' else next_attempt_at end
    where id=p_id and status='processing';
end $$;
revoke all on function public.orit_finish_candidate(bigint,text) from public,anon,authenticated;
grant execute on function public.orit_finish_candidate(bigint,text) to service_role;

create or replace function public.orit_configure(p_values jsonb) returns void language plpgsql security definer set search_path='' as $$
declare item record; secret_id uuid;
begin
  for item in select key,value from jsonb_each_text(p_values) loop
    if item.key not in ('EXA_API_KEY','OPENAI_API_KEY','GMAIL_APP_PASSWORD','GMAIL_USER','OUTREACH_POSTAL_ADDRESS','EMAIL_START_DATE','OUTREACH_DAILY_LIMIT','OUTREACH_FOCUS','OPENAI_EMAIL_MODEL','OPENAI_DISCOVERY_MODEL') then raise exception 'Unsupported runtime setting'; end if;
    select id into secret_id from vault.secrets where name='orit_outreach_'||item.key;
    if secret_id is null then perform vault.create_secret(item.value,'orit_outreach_'||item.key);
    else perform vault.update_secret(secret_id,item.value); end if;
  end loop;
end $$;

create or replace function public.orit_import(p_snapshot jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare item jsonb;
begin
  if exists(select 1 from public.outreach_settings where key='migration_complete' and value='true') then raise exception 'Snapshot already imported'; end if;
  for item in select value from jsonb_array_elements(coalesce(p_snapshot->'leads','[]')) loop
    insert into public.outreach_leads(domain,business,website,email,contact_source,fact,fact_quote,country_evidence,sources,verified_at,status,subject,body,message_id,sent_at,error,ecommerce_verified)
    values(item->>'domain',item->>'business',item->>'website',lower(item->>'email'),item->>'contact_source',item->>'fact',item->>'fact_quote',item->>'country_evidence',item->>'sources',(item->>'verified_at')::timestamptz,item->>'status',item->>'subject',item->>'body',item->>'message_id',(item->>'sent_at')::timestamptz,item->>'error',false)
    on conflict do nothing;
  end loop;
  for item in select value from jsonb_array_elements(coalesce(p_snapshot->'intakes','[]')) loop
    insert into public.outreach_intakes(message_key,sender,subject,received_at,analysis,created_at) values(item->>'message_key',item->>'sender',item->>'subject',(item->>'received_at')::timestamptz,(item->>'analysis')::jsonb,(item->>'created_at')::timestamptz) on conflict do nothing;
  end loop;
  for item in select value from jsonb_array_elements(coalesce(p_snapshot->'suppressions','[]')) loop
    insert into public.outreach_suppressions values(lower(item->>'email'),item->>'reason',(item->>'created_at')::timestamptz) on conflict do nothing;
  end loop;
  for item in select value from jsonb_array_elements(coalesce(p_snapshot->'mail_state','[]')) loop
    perform public.orit_advance(item->>'key',(item->>'last_uid')::bigint);
  end loop;
  insert into public.outreach_settings values('migration_complete','true') on conflict(key) do update set value='true';
  return jsonb_build_object('leads',(select count(*) from public.outreach_leads),'intakes',(select count(*) from public.outreach_intakes),'suppressions',(select count(*) from public.outreach_suppressions));
end $$;
