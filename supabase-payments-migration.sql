-- supabase-payments-migration.sql
--
-- Paste this into Supabase → SQL Editor → New query → Run.
--
-- It brings an existing project's payment tables up to what the site's code
-- expects. Everything here is guarded, so running it twice changes nothing and
-- no existing row, balance or receipt is touched.
--
-- This is the payments slice of supabase.sql. Running the whole of that file
-- instead does all of this and the rest of the schema; if you have already run
-- it, you do not need this.

-- ── topups: which provider took the money ────────────────────────────────────

-- Pre-PayPal projects called this dodo_payment_id. Renamed rather than replaced
-- so settled receipts keep their payment ids.
do $$ begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'topups'
               and column_name = 'dodo_payment_id') then
    alter table topups rename column dodo_payment_id to provider_payment_id;
  end if;
end $$;

-- The PayPal order, which exists from the moment checkout opens and is how a
-- returning payer's order is matched back to their row.
alter table topups add column if not exists provider_order_id text;
create index if not exists topups_provider_order_idx on topups (provider_order_id);

-- Which rail issued the payment. Existing rows predate the other rails, so they
-- are PayPal.
alter table topups add column if not exists provider text not null default 'paypal';

-- What the provider was actually charged. The wallet is USD cents; a UPI order
-- is rupees. Kept separately so settlement compares like with like.
alter table topups add column if not exists provider_amount numeric(12,2);
alter table topups add column if not exists provider_currency text;

-- Direct UPI has no callback, so it cannot auto-credit: the payer submits the
-- UTR, the top-up parks in 'review', and a human approves it against the bank
-- statement.
alter table topups add column if not exists claimed_at timestamptz;
alter table topups add column if not exists reviewed_at timestamptz;
alter table topups add column if not exists review_note text;

create index if not exists topups_review_idx on topups (status, claimed_at desc)
  where status = 'review';

-- The $1 minimum the checkout advertises has to be a legal row; the old >= 500
-- check rejected every top-up under five votes at the database.
alter table topups drop constraint if exists topups_amount_cents_check;
alter table topups add constraint topups_amount_cents_check check (amount_cents >= 100);

alter table topups drop constraint if exists topups_status_check;
alter table topups add constraint topups_status_check
  check (status in ('pending','review','confirmed','failed'));

alter table topups drop constraint if exists topups_provider_check;
alter table topups add constraint topups_provider_check
  check (provider in ('paypal','uropay','upi','test'));

-- ── idempotency key: (provider, payment id), not payment id alone ────────────
--
-- Two providers can legitimately issue the same transaction id — a UPI UTR, a
-- UroPay order id and a PayPal capture id share no namespace — and a collision
-- must not swallow a payment.
--
-- The old unique is dropped by its column set rather than by name. A project
-- that came through the dodo_payment_id rename still has it called
-- topups_dodo_payment_id_key, because RENAME COLUMN does not rename the
-- constraint; naming it literally would miss it on exactly the databases that
-- have it.
do $$ declare r record; begin
  for r in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'topups'::regclass
      and con.contype = 'u'
      and con.conkey = array[(select attnum from pg_attribute
                              where attrelid = 'topups'::regclass
                                and attname = 'provider_payment_id')]
  loop
    execute format('alter table topups drop constraint %I', r.conname);
  end loop;
end $$;

-- And any bare unique index on that column, which carries no constraint row.
do $$ declare r record; begin
  for r in
    select cls.relname
    from pg_index idx
    join pg_class cls on cls.oid = idx.indexrelid
    where idx.indrelid = 'topups'::regclass
      and idx.indisunique and not idx.indisprimary
      and idx.indnatts = 1
      and idx.indkey[0] = (select attnum from pg_attribute
                           where attrelid = 'topups'::regclass
                             and attname = 'provider_payment_id')
  loop
    execute format('drop index %I', r.relname);
  end loop;
end $$;

-- Not a partial index: ON CONFLICT cannot infer one without repeating its
-- predicate, and confirm_topup relies on this for idempotency. Pending rows are
-- unaffected — provider_payment_id is null until settlement, and Postgres treats
-- nulls as distinct, so any number of them coexist.
drop index if exists topups_provider_payment_idx;
create unique index if not exists topups_provider_payment_idx
  on topups (provider, provider_payment_id);

create index if not exists topups_provider_idx on topups (provider, created_at desc);

-- ── settlement: the one way a payment becomes balance ────────────────────────

-- The four-argument version is dropped rather than left in place: an overload
-- that still resolves would let a caller settle a payment without saying where
-- it came from.
drop function if exists confirm_topup(uuid, uuid, int, text);

create or replace function confirm_topup(p_topup_id uuid, p_user_id uuid, p_amount_cents int, p_payment_id text, p_provider text)
returns int language plpgsql security definer set search_path = public as $$
declare v_new int; v_id uuid;
begin
  if p_user_id is null then raise exception 'Missing user'; end if;
  if p_amount_cents is null or p_amount_cents < 100 then raise exception 'Invalid top-up amount'; end if;
  if p_payment_id is null or p_payment_id = '' then raise exception 'Missing payment id'; end if;
  if p_provider is null or p_provider = '' then raise exception 'Missing provider'; end if;

  -- Already settled under this provider's payment id — change nothing. A
  -- webhook is delivered at least once and a retry must not credit twice.
  if exists (select 1 from topups
             where provider = p_provider and provider_payment_id = p_payment_id and status = 'confirmed') then
    select balance_cents into v_new from users where id = p_user_id;
    return v_new;
  end if;

  if p_topup_id is not null then
    update topups set status = 'confirmed', provider_payment_id = p_payment_id, provider = p_provider
      where id = p_topup_id and status <> 'confirmed'
      returning id into v_id;
  end if;

  if v_id is null then
    insert into topups (user_id, amount_cents, provider_payment_id, provider, status)
      values (p_user_id, p_amount_cents, p_payment_id, p_provider, 'confirmed')
      on conflict (provider, provider_payment_id) do nothing
      returning id into v_id;
  end if;

  -- Lost the race to a concurrent delivery of the same payment.
  if v_id is null then
    select balance_cents into v_new from users where id = p_user_id;
    return v_new;
  end if;

  update users set balance_cents = balance_cents + p_amount_cents
    where id = p_user_id returning balance_cents into v_new;
  return v_new;
end $$;

-- credit_balance minted balance for an arbitrary user id, and its insert was
-- idempotent while its balance update was not — a replayed payment id deduped
-- the receipt and credited the wallet again. Delegate, so there is one path.
create or replace function credit_balance(p_user_id uuid, p_amount_cents int, p_payment_id text)
returns int language plpgsql security definer set search_path = public as $$
begin
  return confirm_topup(null, p_user_id, p_amount_cents, p_payment_id, 'test');
end $$;

-- PostgREST publishes every function in `public` as an RPC and Supabase grants
-- EXECUTE to anon/authenticated by default. Both of these take the user id as an
-- argument, so that grant let any visitor holding the (public) anon key POST
-- /rest/v1/rpc/credit_balance and top up their own wallet. Only the service
-- role — the webhook — may settle a payment.
revoke execute on function confirm_topup(uuid, uuid, int, text, text) from public, anon, authenticated;
revoke execute on function credit_balance(uuid, int, text) from public, anon, authenticated;
grant execute on function confirm_topup(uuid, uuid, int, text, text) to service_role;
grant execute on function credit_balance(uuid, int, text) to service_role;

-- ── the balance columns themselves ───────────────────────────────────────────

alter table users add column if not exists total_spent_cents int not null default 0;

-- RLS is row-level, not column-level, so a "users self update" policy lets any
-- signed-in caller PATCH /rest/v1/users and set their own balance_cents to
-- anything they like. This trigger is the column-level half of that policy.
--
-- It keys off current_user, not auth.uid(): PostgREST runs a browser's request
-- as the `authenticated` (or `anon`) role, while the SECURITY DEFINER money
-- functions above run as the function owner. So votes and settled payments still
-- move the balance; a direct table write never does.
create or replace function guard_balance_columns()
returns trigger language plpgsql as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  -- "users self insert" is equally column-blind, so a brand-new row could be
  -- created with a balance already in it. Force the opening balance to zero
  -- rather than rejecting the insert, since ensureUserRow() runs on every first
  -- sign-in and must keep working.
  if tg_op = 'INSERT' then
    new.balance_cents := 0;
    new.total_spent_cents := 0;
    return new;
  end if;

  if new.balance_cents is distinct from old.balance_cents
     or new.total_spent_cents is distinct from old.total_spent_cents then
    raise exception 'balance_cents and total_spent_cents can only change through a payment or a vote';
  end if;
  return new;
end $$;

drop trigger if exists guard_balance_columns on users;
create trigger guard_balance_columns
  before insert or update on users
  for each row execute function guard_balance_columns();

-- PostgREST caches the schema; this tells it to pick the new columns up now
-- rather than on its next reload.
notify pgrst, 'reload schema';
