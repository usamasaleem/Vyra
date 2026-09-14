-- Row-level security for the fleet table, and a guard so the next one cannot
-- be forgotten.
--
-- Drizzle generates the table but not the policy, so every migration that adds
-- a tenant table has needed this appended by hand. That has worked so far —
-- knowledge_entries, enquiries and field_evidence all have policies — but it
-- works by remembering, and the cost of forgetting is a table that reads
-- across operators with nothing failing to announce it.
--
-- The check at the end turns the next omission into a failed migration.

grant select, insert, update on vehicles to vyra_app;

alter table vehicles enable row level security;

create policy vyra_app_scope on vehicles for all to vyra_app
  using (operator_id in (select public.vyra_operator_ids()))
  with check (operator_id in (select public.vyra_operator_ids()));

-- Every table carrying operator_id must have RLS enabled. A new table that
-- forgets it fails here rather than shipping a quiet cross-tenant hole.
do $$
declare
  unprotected text;
begin
  select string_agg(c.relname, ', ' order by c.relname)
  into unprotected
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid and a.attname = 'operator_id' and a.attnum > 0
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;

  if unprotected is not null then
    raise exception 'these tables carry operator_id but have no row-level security: %', unprotected;
  end if;
end $$;
