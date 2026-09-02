-- data/board-fix.sql
--
-- Paste into Supabase → SQL Editor → Run. One transaction: it either does all
-- of this or none of it.
--
-- Tidies the boards. Three passes, in this order, because each one makes the
-- next one's job smaller:
--
--   1. Boards that are the same board twice, merged into one.
--   2. Contenders listed twice on a board, merged into one.
--   3. Boards left with nothing on them and nothing behind them, removed.
--
-- ── Run data/canonical-backfill.sql FIRST ───────────────────────────────────
--
-- That file fills every board it recognises up to its canonical twenty. Run it
-- first and a real board is full by the time this one looks at it, so only
-- genuine junk is left to remove. Run this one first and a real board that
-- happens to be empty is deleted before anything can fill it.
--
-- A board whose slug the canonical list does not know stays empty through the
-- backfill and is removed here. That is the right outcome — an empty board is
-- an empty board — but the names are printed at the end so a board you wanted
-- can be put back by adding its slug to the arrays in canonical-backfill.sql
-- and running both again.
--
-- ── The rule that governs all of it ─────────────────────────────────────────
--
-- Money is never destroyed and never orphaned. Nothing that anyone has paid for
-- is deleted: a contender with a single dollar on them survives, a board with a
-- single dollar on it survives, and where two rows merge their bids, their fan
-- totals and their dollar counts are added together rather than one being
-- dropped. A backer who wakes up tomorrow finds their money where they left it.
--
-- What counts as the same board: the name, lowercased, with a leading
-- "Greatest" and every non-letter removed. So "Greatest Anime" and "greatest
-- anime!" are one board; "Greatest Anime" and "Greatest Anime Villain" are two,
-- because they are two different arguments. Deliberately literal — a merge that
-- guesses is worse than a duplicate.

begin;

-- ── Before ──────────────────────────────────────────────────────────────────
create temporary table board_fix_before on commit drop as
select (select count(*) from categories) as boards,
       (select count(*) from people)     as contenders,
       (select coalesce(sum(total_cents),0) from people) as cents_on_boards,
       (select coalesce(sum(amount_cents),0) from bids)  as cents_in_bids;

-- ── 1. The same board twice ─────────────────────────────────────────────────
--
-- The survivor is the one carrying the most money, then the most contenders,
-- then the one that existed first — so a merge never moves a board's identity
-- to the emptier of the two.
create temporary table board_merge on commit drop as
with keyed as (
  select c.id, c.name,
         lower(regexp_replace(regexp_replace(c.name, '^\s*greatest\s+', '', 'i'), '[^a-zA-Z]', '', 'g')) as key,
         coalesce((select sum(p.total_cents) from people p where p.category_id = c.id), 0) as cents,
         (select count(*) from people p where p.category_id = c.id) as n
    from categories c
),
ranked as (
  select *, first_value(id) over (
             partition by key
             order by cents desc, n desc, id asc
           ) as keeper
    from keyed
   where key <> ''
)
select id as loser, keeper from ranked where id <> keeper;

update people p set category_id = m.keeper
  from board_merge m where p.category_id = m.loser;

delete from categories c using board_merge m where c.id = m.loser;

-- ── 2. The same contender twice on one board ────────────────────────────────
--
-- Same board, same name once punctuation and case are set aside. The survivor
-- is again the one with the most money; the loser's bids, fan totals and dollar
-- count move onto it before it goes.
create temporary table person_merge on commit drop as
with keyed as (
  select p.id, p.category_id, p.total_cents,
         lower(regexp_replace(p.name, '[^a-zA-Z0-9]', '', 'g')) as key
    from people p
),
ranked as (
  select *, first_value(id) over (
             partition by category_id, key
             order by total_cents desc, id asc
           ) as keeper
    from keyed
   where key <> ''
)
select id as loser, keeper, total_cents from ranked where id <> keeper;

-- Bids move first: they are the record of who paid what, and they must land on
-- the survivor before anything is counted from them.
update bids b set person_id = m.keeper from person_merge m where b.person_id = m.loser;

-- Fan totals are one row per (person, fan), so a fan who backed both rows would
-- collide on the unique. Add the loser's total into the keeper's row where one
-- exists, and move it where one does not.
update fan_totals k
   set total_cents = k.total_cents + l.total_cents
  from fan_totals l
  join person_merge m on m.loser = l.person_id
 where k.person_id = m.keeper and k.user_id = l.user_id;

update fan_totals l set person_id = m.keeper
  from person_merge m
 where l.person_id = m.loser
   and not exists (select 1 from fan_totals k where k.person_id = m.keeper and k.user_id = l.user_id);

delete from fan_totals l using person_merge m where l.person_id = m.loser;

update people k
   set total_cents = k.total_cents + s.cents,
       first_backed_at = least(k.first_backed_at, s.first_backed)
  from (select keeper, sum(total_cents) cents,
               min((select first_backed_at from people where id = loser)) first_backed
          from person_merge group by keeper) s
 where k.id = s.keeper;

delete from people p using person_merge m where p.id = m.loser;

-- ── 3. Boards with nothing on them ──────────────────────────────────────────
--
-- Removed only where there is no money anywhere near them: no dollars on any
-- contender, and no bid ever placed. A board with one contender and one dollar
-- stays, because somebody paid for it to be there.
create temporary table board_drop on commit drop as
select c.id, c.name,
       (select count(*) from people p where p.category_id = c.id) as n
  from categories c
 where coalesce((select sum(p.total_cents) from people p where p.category_id = c.id), 0) = 0
   and not exists (
     select 1 from bids b join people p on p.id = b.person_id where p.category_id = c.id)
   and (select count(*) from people p where p.category_id = c.id) < 3;

create temporary table board_dropped_names on commit drop as
select name, n from board_drop order by n desc, name;

delete from people p using board_drop d where p.category_id = d.id;
delete from categories c using board_drop d where c.id = d.id;

-- ── 4. Put the counts back in step ──────────────────────────────────────────
update people p
   set backer_count = (select count(distinct b.user_id) from bids b where b.person_id = p.id);

-- ── What happened ───────────────────────────────────────────────────────────
select 'boards merged as duplicates'  as change, (select count(*) from board_merge)::text as n
union all select 'contenders merged as duplicates', (select count(*) from person_merge)::text
union all select 'empty boards removed',            (select count(*) from board_drop)::text
union all select 'boards now',                      (select count(*) from categories)::text
union all select 'boards before',                   (select boards::text from board_fix_before)
union all select 'contenders now',                  (select count(*) from people)::text
union all select 'contenders before',               (select contenders::text from board_fix_before)
union all select 'dollars on boards (must not change)',
       (select cents_on_boards/100 from board_fix_before)::text || ' → ' ||
       (select coalesce(sum(total_cents),0)/100 from people)::text
union all select 'dollars in bids (must not change)',
       (select cents_in_bids/100 from board_fix_before)::text || ' → ' ||
       (select coalesce(sum(amount_cents),0)/100 from bids)::text;

-- Which boards were removed, and how thin each was. A name here that should
-- have survived means its slug is missing from canonical-backfill.sql.
select name as board_removed, n as contenders_it_had from board_dropped_names;

commit;
