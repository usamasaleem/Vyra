-- The staff email lookup, reachable by the restricted role.
--
-- listMembers reads auth.users to put a name next to each person in the
-- reassign dropdown. Under the privileged connection that worked; under
-- vyra_app it is "permission denied for schema auth", and because that dropdown
-- exists on exactly one screen, wiring row-level security took the conversation
-- page down and left every other page working.
--
-- security definer, for the same reason vyra_operator_ids() is: the caller must
-- not be given the auth schema, only this one answer out of it. search_path is
-- pinned so the definer's rights cannot be redirected at a different table, and
-- it returns emails only for people who share an operator with the caller — so
-- it grants no more than the memberships policy already does.
--
-- Created conditionally because the test database has no auth schema at all,
-- and PostgreSQL parses a SQL function's body when it is created: naming
-- auth.users unconditionally fails every migration run under PGlite. That
-- absence is also why the email was an optional join in the first place, and
-- why no test in this suite could have caught the permission error.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'auth') then
    execute $fn$
      create or replace function public.vyra_member_emails()
      returns table (user_id uuid, email text)
      language sql stable security definer set search_path = public, auth
      as $body$
        select u.id, u.email::text
        from auth.users u
        where exists (
          select 1 from memberships m
          where m.user_id = u.id and m.active
            and m.operator_id in (select public.vyra_operator_ids())
        )
      $body$
    $fn$;
  else
    -- No auth schema, so no emails to give. Returning nothing keeps the left
    -- join in listMembers valid and the column null, which is exactly what the
    -- test database saw before this function existed.
    execute $fn$
      create or replace function public.vyra_member_emails()
      returns table (user_id uuid, email text)
      language sql stable
      as $body$ select null::uuid, null::text where false $body$
    $fn$;
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'vyra_app') then
    grant execute on function public.vyra_member_emails() to vyra_app;
  end if;
end $$;
