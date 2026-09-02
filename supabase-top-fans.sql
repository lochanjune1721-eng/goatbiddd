-- supabase-top-fans.sql
--
-- Paste into Supabase → SQL Editor → New query → Run. Read-only, re-runnable.
--
-- The Greatest Fan of All Time for a set of contenders, in one round trip.
--
-- ── This file is not optional ───────────────────────────────────────────────
--
-- Without it the badge on a contender's frame can never show a face, however
-- much money is on the board. fan_totals is public, so the browser can see that
-- a contender has a fan — but users carries "users self read", so it cannot see
-- who that fan is. The embedded read is refused and the badge falls back to the
-- unclaimed crown on every frame.
--
-- No page code gets past a row policy. This function is SECURITY DEFINER, so it
-- answers the one question the badge asks — who leads this contender, what is
-- their picture, what is their handle — without opening the users table to
-- anyone. Email and balance stay exactly as private as they are now.
--
-- The homepage shows around a hundred duels, two contenders each. Asking for
-- each one's top fan separately is two hundred queries before the page settles,
-- which is what a crown on every card would otherwise cost. This answers all of
-- them at once and returns one row per contender.
--
-- DISTINCT ON is what makes it one row: ordered by person and then by money
-- descending, the first row per person is that person's biggest backer. Ties go
-- to whoever got there first, which is the same tiebreak the boards use.

-- The return type changed (social handle and platform added), and CREATE OR
-- REPLACE cannot change one — the old shape is dropped first.
drop function if exists top_fans(uuid[]);

create or replace function top_fans(p_person_ids uuid[])
returns table (
  person_id       uuid,
  user_id         uuid,
  display_name    text,
  photo_path      text,
  social_handle   text,
  social_platform text,
  total_cents     int
)
language sql
stable
security definer
set search_path = public
as $$
  select distinct on (f.person_id)
         f.person_id,
         f.user_id,
         -- Everyone is public here. The board is a record of who put money
         -- behind whom, and a row that hides half of that is not a record.
         u.display_name,
         u.photo_path,
         u.social_handle,
         u.social_platform,
         f.total_cents
    from fan_totals f
    join users u on u.id = f.user_id
   where f.person_id = any (p_person_ids)
     and f.total_cents > 0
   order by f.person_id, f.total_cents desc, f.id asc
$$;

-- fan_totals is already public read — the leaderboards on every contender page
-- are drawn from it in the browser — so this exposes nothing new. It exists to
-- make one query out of many, not to reach past a policy.
do $$ begin
  grant execute on function top_fans(uuid[]) to anon, authenticated, service_role;
exception when undefined_object then
  raise notice 'anon/authenticated/service_role not present — skipping grants on top_fans';
end $$;

-- Should return one row per contender that has a backer.
-- select * from top_fans(array(select id from people limit 5));
