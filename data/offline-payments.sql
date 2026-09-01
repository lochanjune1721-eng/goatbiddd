-- data/offline-payments.sql
--
-- Credits five accounts $50,000 each for cash received in person.
--
-- Paste the whole file into Supabase → SQL Editor → New query → Run. There is
-- nothing to run first and nothing to fill in: it makes the schema changes it
-- needs itself, all of them guarded, so re-running it changes nothing and no
-- existing row, balance or receipt is touched.
--
-- Two statements, on purpose. Everything that writes is inside the first one, a
-- single DO block, so it is atomic wherever it runs — the SQL editor talks to
-- the database through a connection pooler, which can put two statements of the
-- same script on two different backends, and anything relying on session state
-- between them (a temporary table, an open transaction) breaks there. An earlier
-- version of this file did exactly that and failed with 'relation
-- "offline_payments" does not exist'. The second statement only reads.
--
-- The credit is recorded as a top-up like any other, so the wallet history, the
-- balance and the books agree rather than the money appearing from nowhere. The
-- rail is 'offline': not a card payment, and not 'test' — that rail says no money
-- moved at all, which is the opposite claim. The payer sees "Offline" and their
-- own reference in their wallet history.
--
-- ── How a cash payment is recorded ──────────────────────────────────────────
--
-- Cash has no transaction id, because no bank or gateway issued one. The
-- reference is therefore a receipt id of our own, 'cash-<date>-<payer>', which
-- says what it is rather than imitating a UTR. It is also the idempotency key: a
-- reference already confirmed is skipped rather than credited again, which is
-- what makes this safe to re-run. Changing one after a run makes that payment
-- look new.
--
-- The note carries what a receipt id cannot — when it was handed over, and to
-- whom. It lands in topups.review_note with topups.reviewed_at, the columns the
-- reviewed UPI rail writes when a person confirms a payment by hand. A cash
-- payment is the same kind of record, so it is stored the same way rather than
-- as a special case. Edit the notes below if you want them to name who took it.
--
-- ── Two things to know ──────────────────────────────────────────────────────
--
-- Do not run this and data/demo-credit.sql against the same database. They put
-- the same $50,000 on the same five addresses — one as a payment received, one
-- as demo credit — and together they leave $100,000 against two receipts for one
-- payment. This file stops rather than stacking; data/demo-credit-remove.sql
-- takes the demo grant back off if the cash record is the one to keep.
--
-- A cash payment is attested rather than evidenced: the operator says it was
-- received and no third party holds a copy. That is ordinary for cash, and it is
-- why the note is worth writing as if someone else will read it — it is the
-- whole audit trail these five credits will ever have.
-- data/go-live-check.sql reports this credit next to what came through a rail,
-- so the split stays visible in one place.

-- ── 1. Everything that writes ───────────────────────────────────────────────

do $$
declare
  -- The payments, as received. Amounts are in cents: 5000000 = $50,000.
  v_payments jsonb := '[
    {"email": "loch91111@gmail.com",          "reference": "cash-2026-09-01-loch91111",          "amount_cents": 5000000, "note": "Cash received in person, 1 September 2026."},
    {"email": "lochan@socialcap.uk",          "reference": "cash-2026-09-01-lochan",             "amount_cents": 5000000, "note": "Cash received in person, 1 September 2026."},
    {"email": "lochanjune1721@gmail.com",     "reference": "cash-2026-09-01-lochanjune1721",     "amount_cents": 5000000, "note": "Cash received in person, 1 September 2026."},
    {"email": "lochanmaheshwari23@gmail.com", "reference": "cash-2026-09-01-lochanmaheshwari23", "amount_cents": 5000000, "note": "Cash received in person, 1 September 2026."},
    {"email": "santoshmaru57@gmail.com",      "reference": "cash-2026-09-01-santoshmaru57",      "amount_cents": 5000000, "note": "Cash received in person, 1 September 2026."}
  ]'::jsonb;

  r        record;
  v_clash  text;
  v_values text;
  v_fn     boolean;
  v_idx    boolean;
  v_paid   int := 0;
  v_skip   int := 0;
  v_absent text;
begin
  -- ── Schema, made true rather than assumed ─────────────────────────────────

  -- 'offline' has to be a permitted rail. The existing check constraint is found
  -- by its definition rather than its name: a project that has been through the
  -- dodo_payment_id rename can carry it under a name this file cannot guess, and
  -- adding a second constraint would leave the first one still refusing. The
  -- replacement keeps every provider value already in the table, so a rail this
  -- file has never heard of is not invalidated by being unknown to it.
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

  -- What was granted as opposed to what was charged, and where a payment
  -- confirmed by a person rather than a gateway records who and when.
  execute 'alter table topups add column if not exists credit_cents int';
  execute 'alter table topups add column if not exists reviewed_at timestamptz';
  execute 'alter table topups add column if not exists review_note text';

  -- The uniqueness settlement is idempotent on. Best-effort: if it cannot be
  -- created the credit below takes the path that does not need it, rather than
  -- the whole run failing. The handler keeps that contained.
  begin
    execute 'create unique index if not exists topups_provider_payment_idx on topups (provider, provider_payment_id)';
  exception when others then
    raise notice 'could not create the (provider, provider_payment_id) unique index: %', sqlerrm;
  end;

  -- ── Refuse to stack on the demo grant ─────────────────────────────────────
  --
  -- Both credit these five addresses $50,000. One payment cannot honestly hold
  -- two receipts, and the balance would read $100,000. Raising here rolls the
  -- whole block back, schema changes included.
  select string_agg(u.email, ', ' order by u.email) into v_clash
    from topups t
    join users u on u.id = t.user_id
    join jsonb_to_recordset(v_payments) as p(email text) on lower(p.email) = lower(u.email)
   where t.provider = 'test'
     and t.status = 'confirmed'
     and t.provider_payment_id like 'demo-credit-%';

  if v_clash is not null then
    raise exception 'demo credit from data/demo-credit.sql is already on: %', v_clash
      using hint = 'Run data/demo-credit-remove.sql first, or skip this file. Together they credit $100,000.';
  end if;

  -- ── The credit ────────────────────────────────────────────────────────────
  --
  -- confirm_topup is the one path a payment becomes balance: it writes the
  -- receipt and moves the balance together, so the two cannot drift, and it is
  -- what the PayPal and UPI webhooks settle through. Used where it is available.
  -- Where it is not — an older project, or the unique index its ON CONFLICT
  -- needs could not be made — the same two writes happen inline. Both paths skip
  -- a reference already confirmed, so this is idempotent either way. Getting
  -- that wrong by hand is what once left $50,000 of history sitting against a
  -- $100,000 balance.
  v_fn := to_regprocedure('public.confirm_topup(uuid, uuid, int, text, text)') is not null;
  v_idx := exists (
    select 1 from pg_index i
     where i.indrelid = 'topups'::regclass
       and i.indisunique
       and i.indnatts = 2
       and (select attnum from pg_attribute
             where attrelid = 'topups'::regclass and attname = 'provider') = any (i.indkey::int[])
       and (select attnum from pg_attribute
             where attrelid = 'topups'::regclass and attname = 'provider_payment_id') = any (i.indkey::int[]));

  -- Addresses with no users row are not joined and so are not credited: that row
  -- is created at first sign-in and carries the Supabase Auth id, so it cannot be
  -- invented here. The report names them.
  for r in
    select u.id as uid, p.reference as ref, p.amount_cents as amt, p.note as note
      from jsonb_to_recordset(v_payments) as p(email text, reference text, amount_cents int, note text)
      join users u on lower(u.email) = lower(p.email)
  loop
    if exists (select 1 from topups
                where provider = 'offline' and provider_payment_id = r.ref and status = 'confirmed') then
      v_skip := v_skip + 1;
    else
      if v_fn and v_idx then
        perform confirm_topup(null, r.uid, r.amt, r.ref, 'offline');
      else
        insert into topups (user_id, amount_cents, credit_cents, provider, provider_payment_id, status)
          values (r.uid, r.amt, r.amt, 'offline', r.ref, 'confirmed');
        update users set balance_cents = balance_cents + r.amt where id = r.uid;
      end if;
      v_paid := v_paid + 1;
    end if;

    -- The note and the fact a person confirmed this. Applied whichever path ran,
    -- and only where it differs from what is stored, so a re-run does not
    -- restamp the time on a payment recorded weeks ago.
    update topups
       set review_note = r.note,
           reviewed_at = coalesce(reviewed_at, now())
     where provider = 'offline'
       and provider_payment_id = r.ref
       and status = 'confirmed'
       and review_note is distinct from r.note;
  end loop;

  select string_agg(p.email, ', ' order by p.email) into v_absent
    from jsonb_to_recordset(v_payments) as p(email text)
   where not exists (select 1 from users u where lower(u.email) = lower(p.email));

  raise notice 'credited % account(s), skipped % already recorded', v_paid, v_skip;
  if v_absent is not null then
    raise notice 'no account yet (sign in once on the site, then re-run): %', v_absent;
  end if;
end $$;

-- ── 2. What landed ──────────────────────────────────────────────────────────
--
-- Read back from the receipts rather than from the fact the block ran.
-- 'no account yet' means nobody has signed in with that address — sign in once
-- on the site, then re-run; addresses already credited are skipped rather than
-- paid a second time. credited_dollars is this payment alone; balance_dollars is
-- everything the account holds.

select a.email,
       case when u.id is null then 'no account yet'
            when t.id is null then 'NOT CREDITED — see the notices above'
            else 'credited' end                        as result,
       coalesce(t.credit_cents, t.amount_cents) / 100  as credited_dollars,
       coalesce(u.balance_cents, 0) / 100              as balance_dollars,
       t.provider_payment_id                           as reference,
       t.review_note                                   as note
  from unnest(array[
         'loch91111@gmail.com',
         'lochan@socialcap.uk',
         'lochanjune1721@gmail.com',
         'lochanmaheshwari23@gmail.com',
         'santoshmaru57@gmail.com'
       ]) as a(email)
  left join users u on lower(u.email) = lower(a.email)
  left join topups t on t.user_id = u.id
                    and t.provider = 'offline'
                    and t.status = 'confirmed'
                    and t.provider_payment_id like 'cash-%'
 order by a.email;
