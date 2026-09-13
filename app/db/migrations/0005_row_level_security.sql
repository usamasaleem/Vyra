-- Build plan step 14 — row-level security as defence in depth.
--
-- The primary control remains explicit operator scoping in every query, which
-- is tested. This is the second layer: if a query is ever written without its
-- WHERE operator_id clause, the database refuses it rather than returning
-- another operator's customers.
--
-- Making that real needs a role that does NOT bypass RLS. The inbox connects
-- as the privileged Supabase role, so instead of a second connection string
-- and a second password to rotate, each request switches into a restricted
-- role for the duration of one transaction:
--
--   begin;
--   set local role vyra_app;
--   set local app.current_user_id = '<uuid of the signed-in user>';
--   ... queries run here, with policies enforced ...
--   commit;                        -- role and setting revert automatically
--
-- The worker deliberately does NOT do this. It has no user session, runs
-- privileged, and its isolation comes from explicit scoping — which is what
-- section 18.7 describes and why that scoping is tested directly.

-- Who is asking. Null outside a request, which makes every policy fail closed.
create or replace function public.vyra_current_user_id() returns uuid
language sql stable
as $$
  select nullif(current_setting('app.current_user_id', true), '')::uuid
$$;

-- Which operators they belong to.
--
-- security definer on purpose: the lookup must not itself be filtered by the
-- policy on memberships, which would recurse. search_path is pinned so the
-- definer's rights cannot be redirected at a different table.
create or replace function public.vyra_operator_ids() returns setof uuid
language sql stable security definer set search_path = public
as $$
  select m.operator_id
  from memberships m
  where m.user_id = public.vyra_current_user_id() and m.active
$$;

-- The restricted role. nologin because it is only ever entered with SET ROLE;
-- nobypassrls is the entire point.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'vyra_app') then
    create role vyra_app nologin nobypassrls;
  end if;
end $$;

grant usage on schema public to vyra_app;
grant execute on function public.vyra_current_user_id() to vyra_app;
grant execute on function public.vyra_operator_ids() to vyra_app;

-- No DELETE. Staff edit and add; removing customer records is a retention
-- process, not something a request should be able to do by accident.
grant select, insert, update on
  operators, memberships, whatsapp_accounts, contacts, conversations,
  messages, conversation_notes, outbox, inbound_events, audit_events
to vyra_app;

-- Enable RLS explicitly rather than relying on the Supabase project setting.
--
-- The "Enable automatic RLS" option we ticked at project creation installs an
-- event trigger, so tables created there had RLS switched on for us. That is a
-- property of one Supabase project, not of this schema — the test database has
-- no such trigger, and neither would a second environment. Stating it here
-- makes RLS part of the migration, which is where it belongs. Idempotent
-- wherever it is already on.
--
-- Not FORCE: the table owner keeps bypassing RLS, which is exactly what the
-- worker relies on.
alter table operators           enable row level security;
alter table memberships         enable row level security;
alter table whatsapp_accounts   enable row level security;
alter table contacts            enable row level security;
alter table conversations       enable row level security;
alter table messages            enable row level security;
alter table conversation_notes  enable row level security;
alter table outbox              enable row level security;
alter table inbound_events      enable row level security;
alter table audit_events        enable row level security;

-- Policies. Every table scopes to the caller's operators.
create policy vyra_app_scope on operators for all to vyra_app
  using (id in (select public.vyra_operator_ids()))
  with check (id in (select public.vyra_operator_ids()));

create policy vyra_app_scope on memberships for all to vyra_app
  using (operator_id in (select public.vyra_operator_ids()))
  with check (operator_id in (select public.vyra_operator_ids()));

create policy vyra_app_scope on whatsapp_accounts for all to vyra_app
  using (operator_id in (select public.vyra_operator_ids()))
  with check (operator_id in (select public.vyra_operator_ids()));

create policy vyra_app_scope on contacts for all to vyra_app
  using (operator_id in (select public.vyra_operator_ids()))
  with check (operator_id in (select public.vyra_operator_ids()));

create policy vyra_app_scope on conversations for all to vyra_app
  using (operator_id in (select public.vyra_operator_ids()))
  with check (operator_id in (select public.vyra_operator_ids()));

create policy vyra_app_scope on messages for all to vyra_app
  using (operator_id in (select public.vyra_operator_ids()))
  with check (operator_id in (select public.vyra_operator_ids()));

create policy vyra_app_scope on conversation_notes for all to vyra_app
  using (operator_id in (select public.vyra_operator_ids()))
  with check (operator_id in (select public.vyra_operator_ids()));

create policy vyra_app_scope on outbox for all to vyra_app
  using (operator_id in (select public.vyra_operator_ids()))
  with check (operator_id in (select public.vyra_operator_ids()));

create policy vyra_app_scope on inbound_events for all to vyra_app
  using (operator_id in (select public.vyra_operator_ids()))
  with check (operator_id in (select public.vyra_operator_ids()));

create policy vyra_app_scope on audit_events for all to vyra_app
  using (operator_id in (select public.vyra_operator_ids()))
  with check (operator_id in (select public.vyra_operator_ids()));
