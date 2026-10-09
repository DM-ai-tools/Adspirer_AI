-- Security hardening
-- 1. Users could promote themselves: `profiles_update_own` + a table-wide
--    UPDATE grant let any signed-in user run
--    `update profiles set role = 'admin' where id = auth.uid()`.
--    Restrict end-user updates to harmless display columns. Role and
--    activation changes go through the service role (admin team API).
-- 2. The signup trigger copied `role` from client-supplied user metadata, so
--    `auth.signUp({ data: { role: 'admin' } })` created an admin. New users are
--    always operators; the app's first-user bootstrap promotes via service role.

revoke update on public.profiles from authenticated;
grant update (full_name, avatar_url) on public.profiles to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    coalesce(new.email, new.id::text),
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    'operator'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
