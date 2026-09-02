-- data/everything-public.sql
--
-- Paste into Supabase → SQL Editor → Run.
--
-- Nobody backs anonymously here any more. The board is a public record of who
-- put money behind whom, and a leaderboard where some of the names are withheld
-- is not a record of anything.
--
-- This is not reversible by re-running it: anyone who ticked "stay anonymous"
-- becomes visible — their display name, their picture and their handle appear
-- next to what they have backed, exactly like everyone else's. Their money and
-- their position were always counted; only the name was held back.

begin;

-- How many are about to become visible.
select count(*) as accounts_becoming_public
  from users where is_anonymous is true;

update users set is_anonymous = false where is_anonymous is distinct from false;

-- The column stays. Dropping it would break every query that still selects it,
-- and it costs nothing to leave at false — but nothing reads it for a decision
-- any more, in the pages or in top_fans.
alter table users alter column is_anonymous set default false;

commit;

select count(*)                                          as accounts,
       count(*) filter (where is_anonymous is true)      as still_anonymous,
       count(*) filter (where coalesce(nullif(btrim(display_name),''),'') <> '') as have_a_name
  from users;
