-- Let the connecting role enter the restricted role.
--
-- Supabase's `postgres` role is not a true superuser, so `set local role
-- vyra_app` is refused unless it is a member of that role. The test database
-- did not catch this: PGlite runs as an actual superuser, which may set any
-- role, so the policies passed there and the application would have failed in
-- production.
--
-- Granting a role with fewer privileges to one that already has more adds no
-- access. It only makes the switch permitted.
do $$
begin
  execute format('grant vyra_app to %I', current_user);
exception
  when duplicate_object then null;
  when others then null;   -- already a member, or the grantor cannot
end $$;
