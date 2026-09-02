-- data/board-audit.sql
--
-- Read-only. Paste into Supabase → SQL Editor → Run. Changes nothing.
--
-- What is actually on the boards, worst first. The homepage lists every
-- category it finds, so a board with one contender and no money on it takes the
-- same space as a real fight and makes the page below the fold look like junk.
--
-- Four things worth knowing about each board: how many contenders it has, how
-- much money is on it, how many of its contenders have a portrait, and whether
-- another board is covering the same ground.

-- ── 1. Every board, thinnest first ──────────────────────────────────────────
select c.name                                   as board,
       c.slug,
       count(p.id)                              as contenders,
       coalesce(sum(p.total_cents),0)/100       as dollars_on_it,
       count(p.id) filter (where p.photo_path is not null) as with_photo,
       case
         when count(p.id) = 0                              then 'EMPTY — nothing on it'
         when count(p.id) < 3 and coalesce(sum(p.total_cents),0) = 0 then 'THIN — under 3 contenders, no money'
         when coalesce(sum(p.total_cents),0) = 0           then 'unbacked'
         else 'ok'
       end                                      as verdict
  from categories c
  left join people p on p.category_id = c.id
 group by c.id, c.name, c.slug
 order by count(p.id) asc, c.name asc;

-- ── 2. The summary, if the list above is too long to read ───────────────────
-- Run this on its own to get one row.
--
-- select count(*)                                                   as boards,
--        count(*) filter (where n = 0)                              as empty,
--        count(*) filter (where n between 1 and 2 and cents = 0)    as thin,
--        count(*) filter (where cents > 0)                          as has_money
--   from (select c.id, count(p.id) n, coalesce(sum(p.total_cents),0) cents
--           from categories c left join people p on p.category_id = c.id
--          group by c.id) s;

-- ── 3. Boards that look like duplicates of each other ───────────────────────
-- Matches on the first word after "Greatest", so "Greatest Anime" and
-- "Greatest Anime Villain" land together, as do "Basketball" and "Basketball
-- Player". Judgement is yours — some of these are genuinely different fights.
--
-- select split_part(regexp_replace(c.name,'^Greatest\s+','','i'),' ',1) as stem,
--        count(*) as boards, string_agg(c.name, ' | ' order by c.name) as which
--   from categories c
--  group by 1 having count(*) > 1
--  order by count(*) desc;
