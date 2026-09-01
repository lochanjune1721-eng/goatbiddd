-- supabase-country.sql
--
-- Paste into Supabase -> SQL Editor -> New query -> Run.
--
-- Adds users.country, which decides the payment rail: India pays by UPI,
-- everywhere else by card. Taken from what the fan picks at sign-in rather than
-- from their IP, because a Cloudflare country is a guess about a network --
-- wrong for anyone travelling or on a VPN, and it can change between two clicks
-- of the same checkout.
--
-- One column and one check constraint. Existing rows get NULL and keep working:
-- the server lets an account with no country through and the checkout asks for
-- it once, the next time they pay.


-- ─────────────────────────────────────────────────────────────────────────────
-- Where the fan is, as they told us at sign-in.
--
-- This decides which payment rail they are offered, so it is not taken from
-- their IP: a Cloudflare country is a guess about a network, wrong for anyone
-- travelling or on a VPN, and it changes under them between visits. What they
-- typed does not.
--
-- Two letters, ISO-3166-1 alpha-2. Not secret and not money, so the balance
-- guard leaves it alone and a fan can correct their own.
-- ─────────────────────────────────────────────────────────────────────────────
alter table users add column if not exists country text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'users_country_check') then
    alter table users add constraint users_country_check
      check (country is null or country ~ '^[A-Z]{2}$');
  end if;
end $$;
create index if not exists users_country_idx on users (country);
