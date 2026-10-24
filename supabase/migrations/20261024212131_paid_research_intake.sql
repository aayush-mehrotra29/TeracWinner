-- Payment references and invitations are private, server-only records.
alter table public.outreach_intakes add column if not exists sender_authenticated boolean not null default false;
alter table public.outreach_intakes drop constraint if exists outreach_intakes_research_status_check;
alter table public.outreach_intakes add constraint outreach_intakes_research_status_check
  check (research_status in ('pending','processing','linked','needs_details','needs_payment','skipped','failed'));

create table public.paid_research_orders (
  payment_id text primary key check (payment_id ~ '^pay_[A-Za-z0-9]{8,80}$'),
  buyer_email text not null check (buyer_email=lower(buyer_email)),
  plan_id text not null,
  mode text not null,
  invitation_status text not null default 'sending' check (invitation_status in ('sending','sent','uncertain')),
  message_key text unique references public.outreach_intakes(message_key),
  project_id uuid references public.projects(id),
  run_id uuid unique references public.runs(id),
  created_at timestamptz not null default now(),
  check ((plan_id='plan_EuakJxGnPAziQ' and mode='light_simulation') or
         (plan_id='plan_egia8RPEVQxvz' and mode='deep_simulation'))
);
alter table public.paid_research_orders enable row level security;
revoke all on public.paid_research_orders from public, anon, authenticated;
grant select,insert,update on public.paid_research_orders to service_role;

-- Reservation and identity comparison happen under a row lock. A retry of the
-- same message succeeds; a new message cannot consume an already-bound payment.
create function public.orit_reserve_paid_brief(p_payment_id text,p_message_key text,p_buyer text,p_plan_id text,p_mode text)
returns boolean language plpgsql security invoker set search_path='' as $$
declare receipt public.paid_research_orders;
begin
  select * into receipt from public.paid_research_orders where payment_id=p_payment_id for update;
  if not found or receipt.invitation_status <> 'sent' or receipt.buyer_email <> lower(p_buyer)
     or receipt.plan_id <> p_plan_id or receipt.mode <> p_mode
     or (receipt.message_key is not null and receipt.message_key <> p_message_key) then return false; end if;
  update public.paid_research_orders set message_key=p_message_key where payment_id=p_payment_id;
  return true;
end $$;
revoke all on function public.orit_reserve_paid_brief(text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.orit_reserve_paid_brief(text,text,text,text,text) to service_role;
