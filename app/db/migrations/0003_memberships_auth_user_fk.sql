-- memberships.user_id must refer to a real Supabase auth user.
--
-- Without this, deleting a user in the Supabase dashboard leaves a membership
-- row pointing at nobody. It grants no access, so it fails safe — but it is
-- invisible rot, and "the account exists and the membership exists but the
-- person cannot get in" is a confusing way to spend an afternoon. This
-- happened during setup, which is why the constraint is here now.
--
-- Guarded because the auth schema belongs to Supabase and does not exist in
-- the PGlite test database. The tests still apply every migration in order, so
-- an unguarded reference would break them.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'auth')
     and not exists (
       select 1 from pg_constraint where conname = 'memberships_user_id_auth_users_fk'
     )
  then
    -- Clear any row already orphaned, or the constraint cannot be added.
    delete from memberships m
    where not exists (select 1 from auth.users u where u.id = m.user_id);

    alter table memberships
      add constraint memberships_user_id_auth_users_fk
      foreign key (user_id) references auth.users (id) on delete cascade;
  end if;
end $$;
