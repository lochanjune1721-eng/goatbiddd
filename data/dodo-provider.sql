-- data/dodo-provider.sql
--
-- Lets top-ups be recorded against Dodo Payments.
--
-- Paste the whole file into Supabase → SQL Editor → New query → Run. Run it
-- before the first Dodo payment: topups carries a check constraint listing the
-- rails it accepts, and an insert naming a rail that is not on the list fails —
-- which, on a checkout, is a payer who cannot pay.
--
-- Adds 'dodo' and keeps every value already in the table, so no existing rail
-- is invalidated by being unknown to this file. Re-running it changes nothing.
--
-- One DO block on purpose: the SQL editor talks to the database through a
-- connection pooler, which can put two statements of one script on different
-- backends, so anything relying on session state between them breaks there.

do $$
declare
  r        record;
  v_values text;
begin
  -- Found by its definition rather than its name: a project that has been
  -- through the dodo_payment_id rename can carry this constraint under a name
  -- no file can guess, and adding a second one would leave the first refusing.
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
    from (select unnest(array['paypal','uropay','upi','test','offline','dodo']) as v
          union
          select provider from topups where provider is not null) s;

  execute format('alter table topups add constraint topups_provider_check check (provider in (%s))', v_values);

  -- Written by the rails that quote in a second currency; Dodo bills in the
  -- same cents the board counts in, but the columns are shared.
  execute 'alter table topups add column if not exists provider_amount numeric';
  execute 'alter table topups add column if not exists provider_currency text';
  execute 'alter table topups add column if not exists provider_order_id text';
  execute 'alter table topups add column if not exists credit_cents int';

  -- Settlement is idempotent on this: a webhook and a browser return can arrive
  -- for the same payment, and only one of them may credit it.
  begin
    execute 'create unique index if not exists topups_provider_payment_idx on topups (provider, provider_payment_id)';
  exception when others then
    raise notice 'could not create the (provider, provider_payment_id) unique index: %', sqlerrm;
  end;

  raise notice 'topups now accepts: %', v_values;
end $$;

-- What the rail column holds now, so a run can be read back rather than assumed.
select provider,
       count(*)                                          as topups,
       count(*) filter (where status = 'confirmed')       as confirmed,
       sum(coalesce(credit_cents, amount_cents)) filter (where status = 'confirmed') / 100 as dollars_credited
  from topups
 group by provider
 order by provider;
