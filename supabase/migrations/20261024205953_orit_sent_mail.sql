-- Gmail Sent is the source of truth for actual outbound mail, including sends
-- made by the older hosted agent whose separate database is not accessible.
create table public.outreach_sent_messages (
  message_key text primary key,
  recipient text not null,
  subject text not null,
  sent_at timestamptz not null,
  body_text text check (body_text is null or length(body_text) <= 20000),
  body_incomplete boolean not null default false,
  attachment_names jsonb not null default '[]'::jsonb
    check (jsonb_typeof(attachment_names) = 'array' and jsonb_array_length(attachment_names) <= 50),
  created_at timestamptz not null default now()
);
create index outreach_sent_messages_sent_at_idx on public.outreach_sent_messages(sent_at desc);
alter table public.outreach_sent_messages enable row level security;
revoke all on public.outreach_sent_messages from anon, authenticated;
grant select, insert, update, delete on public.outreach_sent_messages to service_role;
