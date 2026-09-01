-- data/demo-credit-remove.sql
--
-- Removes what data/demo-credit.sql granted, and nothing else.
--
-- Run this when the $50,000 on those five accounts should be a recorded payment
-- rather than demo credit: this file takes the demo grant back off, then
-- data/offline-payments.sql puts the same amount on as an offline payment with
-- a reference behind it. Running the second without the first leaves $100,000,
-- which is why that file refuses to start while these rows are still here.
--
-- Only the demo rows are touched. They are the 'test'-rail top-ups whose
-- reference starts 'demo-credit-', which is what data/demo-credit.sql writes and
-- nothing else does — a real top-up on any rail, on these accounts or any
-- other, is left alone.

begin;

-- The balance comes down by exactly what the removed receipts granted, summed
-- per account, so the two stay in step. credit_cents is what was actually
-- granted; it falls back to amount_cents for a row written before that column
-- existed.
with removed as (
  delete from topups t
   using users u
   where t.user_id = u.id
     and t.provider = 'test'
     and t.status = 'confirmed'
     and t.provider_payment_id like 'demo-credit-%'
     and lower(u.email) in (
       'loch91111@gmail.com',
       'lochan@socialcap.uk',
       'lochanjune1721@gmail.com',
       'lochanmaheshwari23@gmail.com',
       'santoshmaru57@gmail.com'
     )
  returning t.user_id, coalesce(t.credit_cents, t.amount_cents) as cents
),
per_user as (
  select user_id, sum(cents)::int as cents from removed group by user_id
)
-- Clamped at zero because balance_cents may not go negative. It only clamps if
-- some of the demo credit has already been spent, and then the spending itself
-- is what is left over: the bids it paid for are still on the boards, and this
-- file does not reach them. Check for them before turning DEMO_MODE off.
update users u
   set balance_cents = greatest(u.balance_cents - p.cents, 0)
  from per_user p
 where u.id = p.user_id;

commit;

-- What is left. balance_dollars should be 0 on an account that did nothing but
-- hold the demo credit; anything above that was spent from it, or came from a
-- real top-up this file correctly did not touch.
select u.email,
       u.balance_cents / 100      as balance_dollars,
       u.total_spent_cents / 100  as spent_dollars,
       (select count(*) from topups t where t.user_id = u.id) as topups_left
  from users u
 where lower(u.email) in (
   'loch91111@gmail.com',
   'lochan@socialcap.uk',
   'lochanjune1721@gmail.com',
   'lochanmaheshwari23@gmail.com',
   'santoshmaru57@gmail.com'
 )
 order by u.email;
