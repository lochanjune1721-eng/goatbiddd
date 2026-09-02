-- data/retired-rails.sql
--
-- Finds top-ups left mid-flight on PayPal or UroPay now that both rails are
-- gone, and closes them.
--
-- Paste into Supabase → SQL Editor → New query → Run. It reads first and only
-- writes what the read shows, so running it twice is safe.
--
-- ── Why this exists ─────────────────────────────────────────────────────────
--
-- Removing a rail removes the code that settles it. A payment that was already
-- open when the rail went — a payer on PayPal's page, a UroPay order still
-- clearing — can no longer be confirmed by anything. Left alone those rows sit
-- as 'pending' forever, and the money either never arrived (fine, but the row
-- lies) or arrived and was never credited (not fine at all).
--
-- Confirmed top-ups are NOT touched. Those are real payments that were really
-- credited; the rail they came through is history, not a mistake, and the
-- wallet page still names them correctly.

-- ── 1. What is stranded ─────────────────────────────────────────────────────
--
-- Check this against the PayPal and UroPay dashboards before running step 2.
-- Anything here that DID take money has to be credited by hand — with the
-- provider's own reference — rather than cancelled.

select t.id,
       u.email,
       t.provider,
       t.amount_cents / 100                                  as dollars,
       t.status,
       t.provider_order_id,
       t.provider_payment_id,
       t.created_at,
       case when t.created_at < now() - interval '2 hours'
            then 'stale — almost certainly abandoned'
            else 'RECENT — check the provider before cancelling' end as verdict
  from topups t
  left join users u on u.id = t.user_id
 where t.provider in ('paypal', 'uropay')
   and t.status = 'pending'
 order by t.created_at desc;

-- ── 2. Close them ───────────────────────────────────────────────────────────
--
-- Uncomment and run once you have checked step 1. Only touches rows that never
-- reached 'confirmed', and only ones old enough that nobody is still paying.
-- No balance changes: a pending row was never credit in the first place.
--
-- update topups
--    set status = 'failed',
--        review_note = coalesce(review_note || ' | ', '')
--                      || 'Rail retired ' || to_char(now(), 'YYYY-MM-DD') || '; never settled.'
--  where provider in ('paypal', 'uropay')
--    and status = 'pending'
--    and created_at < now() - interval '2 hours';

-- ── 3. What each rail took, all time ────────────────────────────────────────
--
-- The books do not change because the code did. Confirmed money stays counted.

select provider,
       count(*)                                                            as topups,
       count(*) filter (where status = 'confirmed')                         as confirmed,
       count(*) filter (where status = 'pending')                           as still_pending,
       coalesce(sum(coalesce(credit_cents, amount_cents))
                filter (where status = 'confirmed'), 0) / 100               as dollars_credited
  from topups
 group by provider
 order by dollars_credited desc;
