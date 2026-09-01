-- data/go-live-check.sql
--
-- Answers one question: is this database actually ready to take real money?
--
-- Reads only — it changes nothing, so run it as often as you like. Run it
-- before flipping DEMO_MODE to "0" and again after, because the flag and the
-- database are two separate things and only the flag is in the deploy.
--
-- Every row should read 'ok'. Any row reading 'BLOCKS GO-LIVE' names the file
-- that clears it.
--
-- Why this matters more than a tidy database: the site charges real money for
-- rank, and rules.html tells visitors "Every dollar on the board is one
-- somebody actually put down". Seeded backing is 180 invented accounts holding
-- $192,764 across the boards. Left in place with payments switched on, the
-- first genuine payer is bidding against money nobody paid, on a page that
-- tells them otherwise. That is the one state to avoid, and it is invisible
-- from the front end — the boards look identical either way.

with
seeded_backers as (
  select count(*) n from users where id::text like 'de110000-%'
),
seeded_bids as (
  select count(*) n, coalesce(sum(amount_cents), 0) cents
    from bids where user_id::text like 'de110000-%'
),
demo_credit as (
  select count(*) n, coalesce(sum(coalesce(credit_cents, amount_cents)), 0) cents
    from topups
   where provider = 'test' and provider_payment_id like 'demo-credit-%'
),
other_test as (
  select count(*) n from topups
   where provider = 'test' and coalesce(provider_payment_id, '') not like 'demo-credit-%'
),
board_money as (
  select coalesce(sum(total_cents), 0) cents from people
),
real_money as (
  select coalesce(sum(coalesce(credit_cents, amount_cents)), 0) cents
    from topups where status = 'confirmed' and provider in ('paypal', 'uropay', 'upi')
),
offline_money as (
  select coalesce(sum(coalesce(credit_cents, amount_cents)), 0) cents
    from topups where status = 'confirmed' and provider = 'offline'
)
select * from (
  select 1 as ord,
         'seeded backers' as check,
         (select n from seeded_backers)::text as count,
         '$' || ((select cents from seeded_bids) / 100)::text as amount,
         case when (select n from seeded_backers) = 0 then 'ok'
              else 'BLOCKS GO-LIVE — run data/demo-backing-remove.sql' end as verdict
  union all
  select 2, 'their bids on the boards',
         (select n from seeded_bids)::text,
         '$' || ((select cents from seeded_bids) / 100)::text,
         case when (select n from seeded_bids) = 0 then 'ok'
              else 'BLOCKS GO-LIVE — run data/demo-backing-remove.sql' end
  union all
  select 3, 'demo wallet credit',
         (select n from demo_credit)::text,
         '$' || ((select cents from demo_credit) / 100)::text,
         case when (select n from demo_credit) = 0 then 'ok'
              else 'BLOCKS GO-LIVE — run data/demo-credit-remove.sql' end
  union all
  select 4, 'other credit on the test rail',
         (select n from other_test)::text,
         '',
         case when (select n from other_test) = 0 then 'ok'
              else 'CHECK BY HAND — credit with no payment behind it' end
  union all
  -- Not a blocker, just the number to sanity-check. Once the seeded rows are
  -- gone this should equal what people have actually spent, and on a board that
  -- has taken nothing yet it should be $0.
  select 5, 'money showing on the boards', '',
         '$' || ((select cents from board_money) / 100)::text,
         'for reference'
  union all
  select 6, 'credit bought through a rail', '',
         '$' || ((select cents from real_money) / 100)::text,
         'for reference'
  union all
  select 7, 'credit recorded as paid offline', '',
         '$' || ((select cents from offline_money) / 100)::text,
         'for reference — each needs a reference that matches a statement'
) rows
order by ord;
