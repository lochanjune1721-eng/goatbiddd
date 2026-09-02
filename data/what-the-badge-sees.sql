-- data/what-the-badge-sees.sql
--
-- Read-only. Paste into Supabase → SQL Editor → Run, and send me the output.
--
-- The badge in the corner of a contender's frame shows the fan who has put the
-- most money behind THAT contender. It draws a crown instead when it is handed
-- nothing. This shows what it is being handed, so we stop guessing which of
-- those two is happening.

-- ── 1. The two contenders each board shows on the homepage, and their fan ───
--
-- greatest_fan '— NONE —' means there is genuinely no fan_totals row for that
-- contender, and the crown is correct. A name here with a crown still on screen
-- means the page is not reading what the database holds.
with ranked as (
  select p.*, row_number() over (partition by p.category_id
                                 order by p.total_cents desc, p.first_backed_at asc nulls last) as seat
    from people p
),
shown as (select * from ranked where seat <= 2)
select c.name                                   as board,
       s.name                                   as contender,
       s.total_cents / 100                      as contender_dollars,
       coalesce(u.display_name, '— NONE —')     as greatest_fan,
       coalesce(f.total_cents / 100, 0)         as fan_dollars,
       case when u.id is null then 'no fan — crown is correct'
            when u.is_anonymous then 'anonymous — initials only, no link'
            when coalesce(nullif(btrim(u.photo_path),''),'') = '' then 'initials (no photo saved)'
            else 'photo' end                    as badge_should_show
  from shown s
  join categories c on c.id = s.category_id
  left join lateral (
      select ft.user_id, ft.total_cents
        from fan_totals ft
       where ft.person_id = s.id and ft.total_cents > 0
       order by ft.total_cents desc limit 1) f on true
  left join users u on u.id = f.user_id
 where s.total_cents > 0 or f.user_id is not null
 order by s.total_cents desc
 limit 40;

-- ── 2. Is the function the page calls actually there, and what shape? ───────
select p.proname,
       pg_get_function_identity_arguments(p.oid) as takes,
       pg_get_function_result(p.oid)             as returns
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'top_fans';
-- No row here means supabase-top-fans.sql has never been run. The page falls
-- back to reading fan_totals directly, so faces still appear — but without the
-- social links, which only the function returns.

-- ── 3. Are there fans at all, and can they be shown? ───────────────────────
select count(*)                                                                as fan_rows,
       count(distinct person_id)                                               as contenders_with_a_fan,
       count(*) filter (where total_cents = 0)                                 as zero_value_rows,
       (select count(*) from fan_totals f
          left join users u on u.id = f.user_id where u.id is null)            as rows_with_no_user
  from fan_totals;
-- rows_with_no_user above zero is the one that silently breaks things: top_fans
-- inner-joins users, so those fans vanish from its answer entirely.

-- ── 4. Is the contender on screen the same row that was backed? ────────────
--
-- The backfill creates its own rows, so a contender who existed already can end
-- up twice: an original that carries the money, and a new one that carries
-- nothing. The homepage shows whichever sorts highest, and the badge asks about
-- the row it drew — so a Messi with a fan and a Messi without are two different
-- questions with the same name.
--
-- More than one row for a name here is the problem, and data/board-fix.sql
-- merges them, moving the bids and fan totals onto the survivor.
select p.name,
       c.name                                   as board,
       p.slug,
       p.total_cents / 100                      as dollars,
       (select count(*) from fan_totals f where f.person_id = p.id) as fan_rows,
       (select count(*) from bids b where b.person_id = p.id)       as bids
  from people p
  join categories c on c.id = p.category_id
 where lower(p.name) in ('lionel messi','cristiano ronaldo','messi','ronaldo')
    or lower(p.name) like '%messi%' or lower(p.name) like '%ronaldo%'
 order by p.name, p.total_cents desc;

-- ── 5. Every contender that has a fan, and whether it is on a board twice ──
select p.name, c.name as board, p.total_cents / 100 as dollars,
       count(f.*)                                as fans,
       (select count(*) from people p2
         where lower(p2.name) = lower(p.name))   as rows_with_this_name
  from fan_totals f
  join people p on p.id = f.person_id
  join categories c on c.id = p.category_id
 group by p.id, p.name, c.name, p.total_cents
 order by p.total_cents desc;
