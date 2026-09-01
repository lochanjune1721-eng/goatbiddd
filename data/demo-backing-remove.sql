-- data/demo-backing-remove.sql
--
-- Removes everything data/demo-backing.sql inserted, and nothing else.
--
-- Run this before turning DEMO_MODE off. Once the site can take real payments,
-- the boards should show real backing: seeded totals then read as other people
-- having already put money down, which is the claim the whole site rests on.
--
-- Only touches the seeded accounts — they share the 'de110000-' id prefix. Real
-- backers, real bids and real top-ups are untouched, and the contender totals
-- are recomputed from whatever bids remain rather than being zeroed, so a board
-- that has taken genuine money keeps it.

begin;

delete from bids       where user_id::text like 'de110000-%';
delete from fan_totals where user_id::text like 'de110000-%';
delete from topups     where user_id::text like 'de110000-%';
delete from users      where id::text      like 'de110000-%';

-- Recompute from the bids that are left. A contender with none goes back to
-- zero with a null first_backed_at, which is the correct "never backed" state
-- and is what the board's tiebreak expects.
update people p
   set total_cents = coalesce(x.total, 0),
       first_backed_at = x.first
  from (select id from people) ids
  left join (select person_id, sum(amount_cents)::int total, min(created_at) first
               from bids group by person_id) x on x.person_id = ids.id
 where p.id = ids.id;

commit;

-- Should come back 0, 0, 0, 0.
-- select
--   (select count(*) from users      where id::text      like 'de110000-%') as users,
--   (select count(*) from bids       where user_id::text like 'de110000-%') as bids,
--   (select count(*) from fan_totals where user_id::text like 'de110000-%') as fan_totals,
--   (select count(*) from topups     where user_id::text like 'de110000-%') as topups;
