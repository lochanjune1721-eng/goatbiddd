-- data/offline-payments.sql
--
-- Credits five accounts $50,000 each for money received off the payment rails:
-- a bank transfer, a UPI payment, cash — anything settled directly with the
-- operator rather than through PayPal, UroPay or the site's own UPI checkout.
--
-- Paste the whole file into Supabase → SQL Editor → New query → Run. There is
-- nothing to run first: it makes the schema changes it needs itself, and all of
-- them are guarded, so re-running it changes nothing and no existing row,
-- balance or receipt is touched.
--
-- The credit is recorded as a top-up like any other, so the wallet history, the
-- balance and the books agree rather than the money appearing from nowhere. The
-- rail is 'offline', which is the honest label: it is not a card payment, and it
-- is not 'test' — that rail says no money moved at all, which is the opposite
-- claim. The payer sees "Offline" and their own reference in their wallet.
--
-- ── Worth doing before you run it ───────────────────────────────────────────
--
-- Put the real reference for each payment in the `reference` column below: the
-- bank transaction id, the UPI UTR, the receipt number. That is what lets anyone
-- check the credit against a statement afterwards, and it is also what stops a
-- re-run paying twice — a reference already confirmed is skipped, not credited
-- again. The file runs unedited, but then the references record only when the
-- payments were entered, not what they were.
--
-- Do not run this and data/demo-credit.sql against the same database. They put
-- the same $50,000 on the same five addresses — one as a payment received, one
-- as demo credit — and together they leave $100,000 against two receipts for one
-- payment. This file stops rather than stacking; data/demo-credit-remove.sql
-- takes the demo grant back off if the offline record is the one to keep.
--
-- ── What this file cannot settle ────────────────────────────────────────────
--
-- The rails are open now. rules.html tells visitors "Every dollar on the board
-- is one somebody actually put down", and credit from here spends onto a public
-- board exactly like credit bought through a rail: $250,000 of it, sitting next
-- to whatever genuine payers have put in. That claim survives this file only if
-- the money behind these five payments is real and came from the people holding
-- the accounts. The file records that it was received. It cannot verify it, and
-- the reference column is the only thing that will let anyone else.
--
-- data/go-live-check.sql reports this credit next to what came through a rail,
-- so the split stays visible in one place instead of having to be reconstructed.

begin;

-- ── The schema this needs, made true rather than assumed ────────────────────
--
-- An earlier version of this file checked these and told you which migration to
-- run. That was one round trip too many for a change this small, so it now just
-- makes them.

-- 1. 'offline' has to be a permitted rail. The existing check constraint is
--    found by its definition rather than by name, because a database that has
--    been through a rename can be carrying it under one this file cannot guess,
--    and adding a second constraint would leave the first one still refusing.
--    The replacement keeps every provider value already present in the table, so
--    a rail this file has never heard of cannot be invalidated by it.
do $$
declare r record; v_values text;
begin
  for r in select con.conname
             from pg_constraint con
            where con.conrelid = 'topups'::regclass
              and con.contype = 'c'
              and pg_get_constraintdef(con.oid) ilike '%provider%'
              and pg_get_constraintdef(con.oid) ilike '%paypal%'
  loop
    execute format('alter table topups drop constraint %I', r.conname);
  end loop;

  select string_agg(distinct quote_literal(v), ', ' order by quote_literal(v))
    into v_values
    from (select unnest(array['paypal','uropay','upi','test','offline']) as v
          union
          select provider from topups where provider is not null) s;

  execute format('alter table topups add constraint topups_provider_check check (provider in (%s))', v_values);
end $$;

-- 2. What was granted, as opposed to what was charged. Bonus tiers made the two
--    different; the wallet and the report below both read it.
alter table topups add column if not exists credit_cents int;

-- 3. The uniqueness settlement is idempotent on. Best-effort: if it cannot be
--    created the credit below falls back to a path that does not need it, rather
--    than the whole file failing. The handler keeps that contained instead of
--    aborting the transaction.
do $$
begin
  create unique index if not exists topups_provider_payment_idx
    on topups (provider, provider_payment_id);
exception when others then
  raise notice 'could not create the (provider, provider_payment_id) unique index: %', sqlerrm;
end $$;

-- ── The payments, as received ───────────────────────────────────────────────
--
-- Amounts are in cents: 5000000 = $50,000.
create temporary table offline_payments (
  email        text primary key,
  reference    text not null,
  amount_cents int  not null
) on commit drop;

insert into offline_payments (email, reference, amount_cents) values
  ('loch91111@gmail.com',          'offline-2026-09-01-loch91111',          5000000),
  ('lochan@socialcap.uk',          'offline-2026-09-01-lochan',             5000000),
  ('lochanjune1721@gmail.com',     'offline-2026-09-01-lochanjune1721',     5000000),
  ('lochanmaheshwari23@gmail.com', 'offline-2026-09-01-lochanmaheshwari23', 5000000),
  ('santoshmaru57@gmail.com',      'offline-2026-09-01-santoshmaru57',      5000000);

-- Stop if data/demo-credit.sql has already run. Both files credit these five
-- addresses $50,000; one payment cannot honestly hold two receipts, and the
-- balance would read $100,000. Aborting leaves the database exactly as it was,
-- schema changes above included.
do $$
declare v_clash text;
begin
  select string_agg(u.email, ', ' order by u.email) into v_clash
    from topups t
    join users u on u.id = t.user_id
    join offline_payments p on lower(p.email) = lower(u.email)
   where t.provider = 'test'
     and t.status = 'confirmed'
     and t.provider_payment_id like 'demo-credit-%';

  if v_clash is not null then
    raise exception 'demo credit from data/demo-credit.sql is already on: %', v_clash
      using hint = 'Run data/demo-credit-remove.sql first, or skip this file. Together they credit $100,000.';
  end if;
end $$;

-- ── The credit ──────────────────────────────────────────────────────────────
--
-- confirm_topup is the one path a payment becomes balance: it writes the receipt
-- and moves the balance together, so the two cannot drift, and it is what the
-- PayPal and UPI webhooks settle through. Used wherever it is available.
--
-- Where it is not — an older project, or the unique index it needs for its
-- ON CONFLICT could not be created — the same two writes are done inline. Both
-- paths skip an address whose reference is already confirmed, so this file is
-- idempotent either way. Getting that wrong by hand is what once left $50,000 of
-- history sitting against a $100,000 balance.
--
-- Addresses with no users row are simply not joined: that row is created at
-- first sign-in and carries the Supabase Auth id, so it cannot be invented here.
do $$
declare
  r record;
  v_fn  boolean := to_regprocedure('public.confirm_topup(uuid, uuid, int, text, text)') is not null;
  v_idx boolean := exists (
    select 1
      from pg_index i
     where i.indrelid = 'topups'::regclass
       and i.indisunique
       and i.indnatts = 2
       and (select attnum from pg_attribute
             where attrelid = 'topups'::regclass and attname = 'provider') = any (i.indkey::int[])
       and (select attnum from pg_attribute
             where attrelid = 'topups'::regclass and attname = 'provider_payment_id') = any (i.indkey::int[]));
begin
  for r in select u.id as uid, p.amount_cents as amt, p.reference as ref
             from offline_payments p
             join users u on lower(u.email) = lower(p.email)
  loop
    if exists (select 1 from topups
                where provider = 'offline' and provider_payment_id = r.ref and status = 'confirmed') then
      continue;
    end if;

    if v_fn and v_idx then
      perform confirm_topup(null, r.uid, r.amt, r.ref, 'offline');
    else
      insert into topups (user_id, amount_cents, credit_cents, provider, provider_payment_id, status)
        values (r.uid, r.amt, r.amt, 'offline', r.ref, 'confirmed');
      update users set balance_cents = balance_cents + r.amt where id = r.uid;
    end if;
  end loop;
end $$;

-- What landed, read back from the receipts rather than from the fact the file
-- ran. 'no account yet' means nobody has signed in with that address — sign in
-- once on the site, then re-run; addresses already credited are skipped rather
-- than paid a second time. credited_dollars is this payment alone;
-- balance_dollars is everything the account holds.
select p.email,
       case when u.id is null then 'no account yet'
            when t.id is null then 'NOT CREDITED — see above'
            else 'credited' end                        as result,
       coalesce(t.credit_cents, t.amount_cents) / 100  as credited_dollars,
       coalesce(u.balance_cents, 0) / 100              as balance_dollars,
       p.reference
  from offline_payments p
  left join users u on lower(u.email) = lower(p.email)
  left join topups t on t.provider = 'offline'
                    and t.provider_payment_id = p.reference
                    and t.status = 'confirmed'
 order by p.email;

commit;
