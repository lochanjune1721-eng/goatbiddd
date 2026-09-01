-- data/demo-credit.sql
--
-- Puts $50,000 of wallet credit on the operator's own accounts, so the whole
-- product can be walked through end to end: backing contenders, taking a #1
-- fan spot, watching a board move.
--
-- This belongs to the demonstration build — DEMO_MODE on, every payment rail
-- refused at the server. Credit granted without a payment is fine there because
-- nobody can pay: it is a stocked wallet in a sandbox.
--
-- It is NOT fine with the rails live. Credit spent onto a board becomes a
-- public dollar figure, and the site tells visitors that every dollar on a
-- board is one somebody actually put down. $250,000 of granted credit in front
-- of people who can pay real money makes that untrue in the way that matters.
-- Run data/demo-backing-remove.sql and skip this file before turning DEMO_MODE
-- off.
--
-- The matching topup rows carry provider 'test' so the wallet history in the UI
-- reconciles with the balance rather than showing credit from nowhere.

begin;

-- The credit is granted only where the top-up row is actually created, so the
-- two cannot drift apart. The first attempt updated the balance unconditionally
-- while the insert was guarded by the unique (provider, provider_payment_id) —
-- running it twice left the top-up history showing $50,000 against a $100,000
-- balance.
with targets as (
  select id from users where email in (
    'loch91111@gmail.com',
    'lochan@socialcap.uk',
    'lochanjune1721@gmail.com',
    'lochanmaheshwari23@gmail.com',
    'santoshmaru57@gmail.com'
  )
),
granted as (
  insert into topups (user_id, amount_cents, credit_cents, status, provider, provider_payment_id, created_at)
  select id, 5000000, 5000000, 'confirmed', 'test', 'demo-credit-' || id, now()
    from targets
    on conflict (provider, provider_payment_id) do nothing
  returning user_id
)
update users u
   set balance_cents = u.balance_cents + 5000000
  from granted g
 where u.id = g.user_id;

commit;

-- Who got it. Any address missing from this list has not signed in yet — sign
-- in once on the site, then re-run.
select email, balance_cents / 100 as credit_dollars
  from users
 where email in (
   'loch91111@gmail.com',
   'lochan@socialcap.uk',
   'lochanjune1721@gmail.com',
   'lochanmaheshwari23@gmail.com',
   'santoshmaru57@gmail.com'
 )
 order by email;
