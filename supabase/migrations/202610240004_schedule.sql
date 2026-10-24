create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create function public.orit_schedule_request(p_action text) returns bigint
language plpgsql security definer set search_path='' as $$
declare endpoint text; token text; request_id bigint;
begin
  if p_action not in ('inbox','outbound','discover','verify') then raise exception 'Unknown scheduled action'; end if;
  if not exists(select 1 from public.outreach_settings where key='delivery_enabled' and value='true') then return null; end if;
  select value into endpoint from public.outreach_settings where key='function_url';
  select decrypted_secret into token from vault.decrypted_secrets where name='orit_outreach_CRON_SECRET';
  if endpoint is null or token is null then raise exception 'Hosted schedule configuration missing'; end if;
  select net.http_post(url:=endpoint,headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||token),body:=jsonb_build_object('action',p_action),timeout_milliseconds:=120000) into request_id;
  return request_id;
end $$;
revoke all on function public.orit_schedule_request(text) from public,anon,authenticated;
grant execute on function public.orit_schedule_request(text) to service_role;

-- All schedules run on Supabase in UTC and are dormant until cloud delivery is enabled.
select cron.schedule('orit-email-inbox','*/5 * * * *','select public.orit_schedule_request(''inbox'');');
select cron.schedule('orit-email-outbound','2-59/10 * * * *','select public.orit_schedule_request(''outbound'');');
select cron.schedule('orit-email-verify','4-59/15 * * * *','select public.orit_schedule_request(''verify'');');
select cron.schedule('orit-email-discover','17 9 * * *','select public.orit_schedule_request(''discover'');');
