-- supabase-public-profiles.sql
--
-- Paste into Supabase → SQL Editor → Run. Safe to re-run.
--
-- Makes a fan's public identity actually public: their name, their picture and
-- their handle. Nothing else.
--
-- ── Why a view and not a policy ─────────────────────────────────────────────
--
-- "Everything is public here" is true of who backed whom. It is not true of the
-- users table, which also holds email, balance_cents, total_spent_cents and
-- country. Row-level security is row-level — there is no way to say "this row is
-- readable but only these four columns of it". A policy of `using (true)` on
-- users would publish every address and every balance on the site to anyone
-- holding the anon key, which is printed in the page source.
--
-- So the four public columns get their own view, and only that is granted. The
-- users table keeps "users self read" exactly as it is: email and balance stay
-- as private as they are today.

drop view if exists public_profiles;

create view public_profiles as
  select id, display_name, photo_path, social_handle, social_platform
    from users;

-- The view is owned by the role that created it and is not security_invoker, so
-- reads through it are not filtered by the users policy — which is the entire
-- point. It can only ever return these five columns.
alter view public_profiles set (security_invoker = off);

do $$ begin
  grant select on public_profiles to anon, authenticated, service_role;
exception when undefined_object then
  raise notice 'anon/authenticated/service_role not present — skipping grants';
end $$;

-- PostgREST caches the schema it exposes. A new view or function can 404 for a
-- while without this, which looks exactly like the SQL never having been run.
notify pgrst, 'reload schema';

-- Should list the five columns, and only those five.
select column_name from information_schema.columns
 where table_schema = 'public' and table_name = 'public_profiles'
 order by ordinal_position;
