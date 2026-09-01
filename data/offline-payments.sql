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
-- 1. Put the real reference for each payment in the `reference` column below:
--    the bank transaction id, the UPI UTR, the receipt number. That is what
--    lets anyone check the credit against a statement afterwards, and it is
--    also what stops a re-run paying twice — settlement is idempotent on
--    (provider, reference), so a reference already confirmed is ignored rather
--    than credited again. The file runs unedited, but then the references
--    record only when the payments were entered, not what they were.
--
-- 2. Do not run this and data/demo-credit.sql against the same database. They
--    put the same $50,000 on the same five addresses — one as a payment
--    received, one as demo credit — and together they leave $100,000 against
--    two receipts for one payment. This file stops rather than stacking on top
--    of the demo credit; data/demo-credit-remove.sql takes that back off if the
--    offline record is the one to keep.
--
-- ── What this file cannot settle ────────────────────────────────────────────
--
-- rules.html tells visitors "Every dollar on the board is one somebody actually
-- put down", and credit from here spends onto a public board exactly like
-- credit bought through a rail — $250,000 of it, against a seeded backing
-- history of $192,764. That claim holds only if the money behind these five
-- payments is real and came from the people holding the accounts. This file
-- records that it was received; it cannot verify it, and the reference column
-- is the only thing that will let anyone else.

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

-- The 'offline' rail has to be a legal provider value before any of this can be
-- written. Checked here so a database that has not had the migration says which
-- file to run, rather than failing on a raw check-constraint violation.
do $$
begin
  if exists (select 1 from pg_constraint
              where conrelid = 'topups'::regclass
                and conname = 'topups_provider_check'
                and pg_get_constraintdef(oid) not like '%''offline''%') then
    raise exception 'the topups provider check does not allow ''offline'' yet'
      using hint = 'Run supabase-payments-migration.sql first (or supabase.sql) — it adds the offline rail.';
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
