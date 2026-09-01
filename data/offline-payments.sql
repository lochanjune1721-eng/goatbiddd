-- data/offline-payments.sql
--
-- Credits five accounts $50,000 each for money received off the payment rails:
-- a bank transfer, a UPI payment, cash — anything settled directly with the
-- operator rather than through PayPal, UroPay or the site's own UPI checkout.
--
-- The credit is recorded as a top-up like any other, so the wallet history, the
-- balance and the books agree rather than the money appearing from nowhere. The
-- rail is 'offline', which is the honest label for it: it is not a card payment,
-- and it is not 'test' — that rail says no money moved at all, which is the
-- opposite claim. The payer sees "Offline" and their own reference in their
-- wallet history.
--
-- ── Before running ──────────────────────────────────────────────────────────
--
-- 1. Run supabase-offline-rail.sql once against this database. It is four
--    statements and it is what makes 'offline' a legal rail; without it every
--    credit below is refused by a check constraint. The block after this header
--    stops with that instruction rather than letting it fail halfway.
--
-- 2. Put the real reference for each payment in the `reference` column below:
--    the bank transaction id, the UPI UTR, the receipt number. That is what
--    lets anyone check the credit against a statement afterwards, and it is
--    also what stops a re-run paying twice — settlement is idempotent on
--    (provider, reference), so a reference already confirmed is ignored rather
--    than credited again. The file runs unedited, but then the references
--    record only when the payments were entered, not what they were.
--
-- 3. Do not run this and data/demo-credit.sql against the same database. They
--    put the same $50,000 on the same five addresses — one as a payment
--    received, one as demo credit — and together they leave $100,000 against
--    two receipts for one payment. This file stops rather than stacking on top
--    of the demo credit; data/demo-credit-remove.sql takes that back off if the
--    offline record is the one to keep.
--
-- ── What this file cannot settle ────────────────────────────────────────────
--
-- The rails are open now. rules.html tells visitors "Every dollar on the board
-- is one somebody actually put down", and credit from here spends onto a public
-- board exactly like credit bought through a rail: $250,000 of it, sitting next
-- to whatever genuine payers have put in. That claim survives this file only if
-- the money behind these five payments is real and came from the people holding
-- the accounts. The file records that it was received. It cannot verify it, and
-- the reference column is the only thing that will let anyone else — which is
-- why running it with the placeholder references still in matters more now than
-- it would have in a demonstration build.
--
-- data/go-live-check.sql reports this credit next to what came through a rail,
-- so the split stays visible in one place instead of having to be reconstructed.

begin;

-- The payments, as received. Amounts are in cents: 5000000 = $50,000.
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

-- Everything this file needs from the schema, checked up front and named
-- individually, so a database that is missing a piece says which one and which
-- file supplies it — rather than failing halfway on a raw constraint violation
-- or a "function does not exist".
--
-- All three come from supabase-offline-rail.sql, which is the small paste-in
-- slice for exactly this. supabase.sql and supabase-payments-migration.sql also
-- carry them, if you would rather run one of those in full.
do $$
begin
  -- The rail. Without it every insert below violates topups_provider_check.
  if exists (select 1 from pg_constraint
              where conrelid = 'topups'::regclass
                and conname = 'topups_provider_check'
                and pg_get_constraintdef(oid) not like '%''offline''%') then
    raise exception 'the topups provider check does not allow ''offline'' yet'
      using hint = 'Run supabase-offline-rail.sql first — it is four statements and adds the offline rail.';
  end if;

  -- The settlement function, in its five-argument form. The four-argument
  -- version settled a payment without saying which rail it came from, which is
  -- the one thing this file exists to record.
  if to_regprocedure('public.confirm_topup(uuid, uuid, int, text, text)') is null then
    raise exception 'confirm_topup(uuid, uuid, int, text, text) is not in this database'
      using hint = 'Run supabase-payments-migration.sql — it installs the settlement function this file credits through.';
  end if;

  -- What was granted, as opposed to what was charged. The closing report reads
  -- it back.
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'topups'
                    and column_name = 'credit_cents') then
    raise exception 'topups.credit_cents does not exist in this database'
      using hint = 'Run supabase-offline-rail.sql — it adds the column.';
  end if;
end $$;

-- Stop if data/demo-credit.sql has already run. Both files credit these five
-- addresses $50,000; one payment cannot honestly hold two receipts, and the
-- balance would read $100,000. Aborting the transaction leaves the database
-- exactly as it was.
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

-- confirm_topup is the one path a payment becomes balance. It writes the
-- receipt and moves the balance together, so the two cannot drift, and it is
-- idempotent on (provider, reference), so running this file twice credits
-- nothing the second time. Doing the insert and the update by hand instead is
-- what once left $50,000 of history sitting against a $100,000 balance.
--
-- Addresses with no users row are simply not joined: that row is created at
-- first sign-in and carries the Supabase Auth id, so it cannot be invented
-- here. The report below names them.
do $$
declare r record;
begin
  for r in select u.id, p.amount_cents, p.reference
             from offline_payments p
             join users u on lower(u.email) = lower(p.email)
  loop
    perform confirm_topup(null, r.id, r.amount_cents, r.reference, 'offline');
  end loop;
end $$;

-- What landed, read back from the receipts rather than from the fact that the
-- file ran. 'no account yet' means nobody has signed in with that address — sign
-- in once on the site, then re-run; addresses already credited are skipped
-- rather than paid a second time. credited_dollars is this payment alone;
-- balance_dollars is everything the account holds, so the two differ wherever
-- there was already credit on it.
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
