-- data/rebuild-fan-totals.sql
--
-- Rebuilds fan_totals from bids, so every contender who has been backed has a
-- Greatest Fan of All Time the site can actually name.
--
-- Paste the whole file into Supabase → SQL Editor → New query → Run. Nothing to
-- run first, nothing to fill in, and it is safe to run again — it computes what
-- the table should hold and settles it there, so a second run changes nothing.
--
-- ── Why this is needed ──────────────────────────────────────────────────────
--
-- bids is the record: one row per dollar-amount somebody put down. fan_totals
-- is a cache of it — how much each person has put behind each contender — and
-- place_bid keeps the two in step as bids arrive.
--
-- They come apart when anything writes bids or recomputes totals without going
-- through place_bid. data/demo-backing-remove.sql is the clearest case: it
-- recomputes people.total_cents from the bids that remain, exactly as it should,
-- and leaves fan_totals holding only whatever was not deleted. Any bid placed
-- before place_bid maintained the cache never wrote a row either.
--
-- The visible symptom is a contender showing real money with no fan: Ronaldo at
-- $135 wearing a crown instead of his biggest backer's face. The money was real
-- and the backer was real; the cache had no row to name them from.
--
-- ── What it does and does not touch ─────────────────────────────────────────
--
-- Writes only fan_totals, and only what bids say. It does not touch people,
-- bids, users or balances — in particular it does not recompute
-- people.total_cents, because a board whose totals were seeded rather than bid
-- would lose that money, and that is not this file's decision to make. The
-- read-back at the end reports where the two disagree so the difference is
-- visible without being acted on.
--
-- Rows removed are cache entries for a contender who HAS bids but where that
-- particular backer has none — stale cache, contradicted by the record. A
-- contender with no bids at all is left alone, because there is nothing to
-- check them against and deleting would only destroy information.
--
-- Everything that writes is one DO block on purpose. The SQL editor talks to
-- the database through a connection pooler, which can put two statements of one
-- script on two different backends, so anything relying on session state
-- between them — a temporary table, an open transaction — breaks there.

-- ── 1. Everything that writes ───────────────────────────────────────────────

do $$
declare
  v_orphans_before int;
  v_orphans_after  int;
  v_inserted       int := 0;
  v_corrected      int := 0;
  v_removed        int := 0;
begin
  -- Contenders carrying money that the badge cannot put a face to. This is the
  -- number the whole file exists to bring down.
  select count(*) into v_orphans_before
    from people p
   where p.total_cents > 0
     and not exists (select 1 from fan_totals f where f.person_id = p.id and f.total_cents > 0);

  -- The upsert below needs the uniqueness the schema declares. A project built
  -- from an older file may not have it, in which case duplicates are folded
  -- together first — otherwise creating the index fails and takes the run with it.
  if not exists (
    select 1 from pg_index i
     where i.indrelid = 'fan_totals'::regclass
       and i.indisunique
       and i.indnatts = 2
       and (select attnum from pg_attribute
             where attrelid = 'fan_totals'::regclass and attname = 'person_id') = any (i.indkey::int[])
       and (select attnum from pg_attribute
             where attrelid = 'fan_totals'::regclass and attname = 'user_id') = any (i.indkey::int[]))
  then
    delete from fan_totals a using fan_totals b
     where a.person_id = b.person_id and a.user_id = b.user_id and a.ctid > b.ctid;
    execute 'create unique index fan_totals_person_user_idx on fan_totals (person_id, user_id)';
  end if;

  -- What the record says, settled into the cache. The WHERE on the conflict
  -- clause means a row already correct is not rewritten, so the counts below
  -- report what actually changed rather than how many rows were considered.
  with truth as (
    select b.person_id, b.user_id, sum(b.amount_cents)::int as cents
      from bids b
     where b.user_id is not null
       and b.person_id is not null
     group by b.person_id, b.user_id
    having sum(b.amount_cents) > 0
  ), written as (
    insert into fan_totals (person_id, user_id, total_cents)
    select person_id, user_id, cents from truth
    on conflict (person_id, user_id) do update
       set total_cents = excluded.total_cents
     where fan_totals.total_cents is distinct from excluded.total_cents
    returning (xmax = 0) as was_insert
  )
  select count(*) filter (where was_insert),
         count(*) filter (where not was_insert)
    into v_inserted, v_corrected
    from written;

  -- Cache rows the record contradicts: this backer has no bid on this
  -- contender, and the contender has bids, so the record is complete enough to
  -- say so. Contenders with no bids at all are left untouched.
  delete from fan_totals f
   where not exists (select 1 from bids b
                      where b.person_id = f.person_id and b.user_id = f.user_id)
     and exists (select 1 from bids b2 where b2.person_id = f.person_id);
  get diagnostics v_removed = row_count;

  select count(*) into v_orphans_after
    from people p
   where p.total_cents > 0
     and not exists (select 1 from fan_totals f where f.person_id = p.id and f.total_cents > 0);

  raise notice 'fan_totals: % inserted, % corrected, % stale removed', v_inserted, v_corrected, v_removed;
  raise notice 'contenders with money but no nameable fan: % before, % after', v_orphans_before, v_orphans_after;
  if v_orphans_after > 0 then
    raise notice 'the remaining % carry money that no bid accounts for — see the read-back below', v_orphans_after;
  end if;
end $$;

-- ── 2. What is left over ────────────────────────────────────────────────────
--
-- Contenders still showing money with no fan the badge can name. For each, the
-- crown on their card is the honest badge, and the reason is here:
--
--   'money not backed by any bid'  — people.total_cents was seeded, or set by
--     something other than place_bid. The dollars on the board are not dollars
--     anybody put down. data/go-live-check.sql covers this across the whole site.
--   'bids name no account'         — the bids exist but carry no user_id, so
--     there is nobody to show. Nothing on the site can place one; a bid like
--     this was inserted by hand.
--
-- No rows means every backed contender now has a fan with a name.

select p.name                                             as contender,
       p.total_cents / 100                                as board_dollars,
       coalesce(b.bid_cents, 0) / 100                     as dollars_from_bids,
       case when coalesce(b.bid_cents, 0) = 0
            then 'money not backed by any bid'
            else 'bids name no account' end               as why_no_fan
  from people p
  left join (select person_id, sum(amount_cents)::int as bid_cents
               from bids group by person_id) b on b.person_id = p.id
 where p.total_cents > 0
   and not exists (select 1 from fan_totals f where f.person_id = p.id and f.total_cents > 0)
 order by p.total_cents desc
 limit 50;
