-- supabase-offline-rail.sql
--
-- Paste this into Supabase → SQL Editor → New query → Run, before running
-- data/offline-payments.sql.
--
-- It adds one value — 'offline' — to the list of payment rails a top-up may be
-- recorded against, and adds the two columns settlement needs if this project
-- predates them. Everything is guarded, so running it twice changes nothing and
-- no existing row, balance or receipt is touched.
--
-- This is a slice of supabase.sql and of supabase-payments-migration.sql, cut
-- out so going live with offline payments does not mean re-running either of
-- those in full. If you have already run one of them since they gained the
-- offline rail, you do not need this.
--
-- Why 'offline' is its own rail and not 'test': the two make opposite claims.
-- 'test' says no money moved. 'offline' says money moved somewhere this
-- database cannot see — a bank transfer, a UPI payment, cash — and can be
-- checked against a statement using the reference stored with it. Filing a real
-- payment under 'test' would lose that distinction permanently.

-- The rail itself.
alter table topups drop constraint if exists topups_provider_check;
alter table topups add constraint topups_provider_check
  check (provider in ('paypal', 'uropay', 'upi', 'test', 'offline'));

-- What was actually granted, as distinct from what was charged — bonus tiers
-- made the two different. Settlement writes it and the wallet reads it.
alter table topups add column if not exists credit_cents int;

-- The uniqueness settlement relies on to be idempotent. Two rails can issue the
-- same transaction id — a UPI UTR and a PayPal capture share no namespace — so
-- the key is the pair, not the id alone. Without this, re-running a credit file
-- pays twice.
drop index if exists topups_provider_payment_idx;
create unique index if not exists topups_provider_payment_idx
  on topups (provider, provider_payment_id);

-- Confirms it took. Both rows should read 'yes'.
select 'offline rail allowed' as check,
       case when exists (select 1 from pg_constraint
                          where conrelid = 'topups'::regclass
                            and conname = 'topups_provider_check'
                            and pg_get_constraintdef(oid) like '%''offline''%')
            then 'yes' else 'no' end as ok
union all
select 'credit_cents column',
       case when exists (select 1 from information_schema.columns
                          where table_schema = 'public' and table_name = 'topups'
                            and column_name = 'credit_cents')
            then 'yes' else 'no' end;
