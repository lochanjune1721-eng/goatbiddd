-- supabase-votes-and-bonus.sql
--
-- Paste into Supabase -> SQL Editor -> New query -> Run.
--
-- Three changes, all in the vote/payment path:
--
--   1. The "taking #1 costs at least 5 votes more than the leader" rule is
--      gone. One vote can take the top spot again.
--   2. Bonus votes. amount_cents is what a payer is charged; credit_cents is
--      what they are granted, which stops being the same number the moment $5
--      buys 6 votes. Settlement grants credit_cents.
--   3. Pay-to-vote. vote_person_id lets a payment be spent on a contender the
--      instant it settles, so nobody has to understand a wallet before backing
--      someone.
--
-- Safe to re-run; existing rows and balances are untouched. A top-up already
-- open with no credit_cents still credits exactly what was paid.

-- place_vote_for — the core. Takes the voter explicitly so a settled payment can
-- spend on someone's behalf: a webhook has no auth.uid(), and pay-to-vote has
-- to place the vote the payer already paid for.
create or replace function place_vote_for(p_user uuid, p_person_id uuid, p_votes int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := p_user;
  v_cents int := p_votes * 100;
  v_balance int;
  v_new_total int;
begin
  if p_votes is null or p_votes < 1 then raise exception 'Minimum 1 vote'; end if;
  if v_user is null then raise exception 'not authenticated'; end if;
  select balance_cents into v_balance from users where id = v_user for update;
  if not found then
    insert into users (id, balance_cents) values (v_user, 0) returning balance_cents into v_balance;
  end if;
  if v_balance < v_cents then raise exception 'Not enough votes'; end if;
  if not exists (select 1 from people where id = p_person_id) then raise exception 'person not found'; end if;

  update users set balance_cents = balance_cents - v_cents, total_spent_cents = total_spent_cents + v_cents where id = v_user;
  insert into bids (user_id, person_id, amount_cents) values (v_user, p_person_id, v_cents);
  update people set total_cents = total_cents + v_cents, first_backed_at = coalesce(first_backed_at, now()) where id = p_person_id returning total_cents into v_new_total;
  insert into fan_totals (person_id, user_id, total_cents) values (p_person_id, v_user, v_cents) on conflict (person_id, user_id) do update set total_cents = fan_totals.total_cents + v_cents;

  return jsonb_build_object('ok', true, 'new_total', v_new_total, 'balance', v_balance - v_cents);
exception when others then raise;
end $$;

-- What the browser calls. Spends the caller's own balance and nobody else's:
-- the user id comes from the JWT, never from an argument.
create or replace function place_vote(p_person_id uuid, p_votes int)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  return place_vote_for(auth.uid(), p_person_id, p_votes);
end $$;

-- place_vote_for takes the voter as an argument, so a browser holding the
-- public anon key must never reach it. Only the settlement path may.
revoke execute on function place_vote_for(uuid, uuid, int) from public, anon, authenticated;
grant execute on function place_vote_for(uuid, uuid, int) to service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- Bonus votes, and paying for a vote without keeping a balance.
--
-- amount_cents is what the payer is charged. It used to double as what they
-- were credited, which stops being true the moment $5 buys 6 votes — so the
-- credit is now its own column. The server computes it from the tier table in
-- api/_pricing.js when the checkout opens and writes it here; settlement grants
-- exactly this and never recomputes, so a repriced tier cannot change what an
-- already-open order pays out.
--
-- vote_person_id is the pay-to-vote half: someone who just wants to back Messi
-- should not have to understand a wallet first. When it is set, settlement
-- credits the votes and immediately spends them on that contender, so the money
-- lands as a vote rather than as a balance the payer never asked for.
-- ─────────────────────────────────────────────────────────────────────────────

alter table topups add column if not exists credit_cents int;
alter table topups add column if not exists vote_person_id uuid references people(id) on delete set null;
create index if not exists topups_vote_person_idx on topups (vote_person_id) where vote_person_id is not null;

create or replace function confirm_topup(p_topup_id uuid, p_user_id uuid, p_amount_cents int, p_payment_id text, p_provider text)
returns int language plpgsql security definer set search_path = public as $$
declare v_new int; v_id uuid; v_credit int; v_person uuid;
begin
  if p_user_id is null then raise exception 'Missing user'; end if;
  if p_amount_cents is null or p_amount_cents < 100 then raise exception 'Invalid top-up amount'; end if;
  if p_payment_id is null or p_payment_id = '' then raise exception 'Missing payment id'; end if;
  if p_provider is null or p_provider = '' then raise exception 'Missing provider'; end if;

  -- Already settled under this provider's payment id — change nothing. A
  -- webhook is delivered at least once and a retry must not credit twice, nor
  -- cast the pay-to-vote vote a second time.
  if exists (select 1 from topups
             where provider = p_provider and provider_payment_id = p_payment_id and status = 'confirmed') then
    select balance_cents into v_new from users where id = p_user_id;
    return v_new;
  end if;

  if p_topup_id is not null then
    update topups set status = 'confirmed', provider_payment_id = p_payment_id, provider = p_provider
      where id = p_topup_id and status <> 'confirmed'
      returning id, coalesce(credit_cents, amount_cents), vote_person_id
      into v_id, v_credit, v_person;
  end if;

  if v_id is null then
    insert into topups (user_id, amount_cents, credit_cents, provider_payment_id, provider, status)
      values (p_user_id, p_amount_cents, p_amount_cents, p_payment_id, p_provider, 'confirmed')
      on conflict (provider, provider_payment_id) do nothing
      returning id, coalesce(credit_cents, amount_cents), vote_person_id
      into v_id, v_credit, v_person;
  end if;

  -- Lost the race to a concurrent delivery of the same payment.
  if v_id is null then
    select balance_cents into v_new from users where id = p_user_id;
    return v_new;
  end if;

  -- Never grant less than was paid, whatever is in credit_cents.
  v_credit := greatest(coalesce(v_credit, p_amount_cents), p_amount_cents);

  update users set balance_cents = balance_cents + v_credit
    where id = p_user_id returning balance_cents into v_new;

  -- Pay-to-vote: spend it now, on the contender the payer chose. Inside the
  -- same transaction as the credit, so there is no window where the money is a
  -- balance the payer never wanted. If the contender has since been deleted the
  -- credit simply stays in their wallet rather than the payment failing.
  if v_person is not null and exists (select 1 from people where id = v_person) then
    perform place_vote_for(p_user_id, v_person, v_credit / 100);
    select balance_cents into v_new from users where id = p_user_id;
  end if;

  return v_new;
end $$;

revoke execute on function confirm_topup(uuid, uuid, int, text, text) from public, anon, authenticated;
grant execute on function confirm_topup(uuid, uuid, int, text, text) to service_role;
