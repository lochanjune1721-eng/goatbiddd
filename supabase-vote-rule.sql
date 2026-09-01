-- supabase-vote-rule.sql
--
-- Paste into Supabase -> SQL Editor -> New query -> Run.
--
-- Fixes a false promise. place_vote refused a vote that would take #1 for less
-- than 5 votes over the leader, but tested `new_total > leader_total` -- so a
-- vote that landed exactly ON the leader's total skipped the check. Boards are
-- ordered (total_cents desc, first_backed_at asc), so a tie puts you FIRST when
-- you were backed earlier: #1 could be taken for nothing over the leader, which
-- is precisely what the error message said was impossible.
--
-- The check now asks "would this vote put them top of the board", using the
-- board's own ordering, and only charges the gap for TAKING the top spot --
-- a contender already at #1 can be topped up by a single vote, which the old
-- rule wrongly blocked whenever their lead was under 5 votes.
--
-- Replaces one function. Safe to re-run; nothing else is touched.

create or replace function place_vote(p_person_id uuid, p_votes int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_cents int := p_votes * 100;
  v_balance int;
  v_new_total int;
  v_leader_total int;
  v_leader_first timestamptz;
  v_my_first timestamptz;
  v_now_first boolean;
  v_was_first boolean;
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

  -- Taking #1 costs at least 5 votes (500 cents) more than the current leader.
  --
  -- This used to test `v_new_total > v_leader_total`, which let a tie straight
  -- through — and a tie is not second place. Boards are ordered
  -- (total_cents desc, first_backed_at asc), so matching the leader's total
  -- puts you FIRST when you were backed earlier. #1 could therefore be taken
  -- for nothing over the leader, which is exactly what the error message
  -- promised was impossible.
  --
  -- So the test is now "would this vote put them top of the board", evaluated
  -- with the board's own ordering, rather than a total comparison that ignores
  -- the tiebreak.
  select total_cents, coalesce(first_backed_at, 'infinity'::timestamptz)
    into v_leader_total, v_leader_first
    from people
    where category_id = (select category_id from people where id = p_person_id)
      and id <> p_person_id
    order by total_cents desc, first_backed_at asc nulls last
    limit 1;

  if v_leader_total is not null then
    select coalesce(first_backed_at, 'infinity'::timestamptz) into v_my_first
      from people where id = p_person_id;

    -- Rank after this vote, and rank before it. The gap is only charged for
    -- *taking* the top spot: a contender already at #1 can be topped up by a
    -- single vote, which the old rule also blocked.
    v_now_first := v_new_total > v_leader_total
      or (v_new_total = v_leader_total and v_my_first < v_leader_first);
    v_was_first := (v_new_total - v_cents) > v_leader_total
      or ((v_new_total - v_cents) = v_leader_total and v_my_first < v_leader_first);

    if v_now_first and not v_was_first and v_new_total < v_leader_total + 500 then
      raise exception 'taking #1 costs at least 5 votes more than the current leader';
    end if;
  end if;

  return jsonb_build_object('ok', true, 'new_total', v_new_total, 'balance', v_balance - v_cents);
exception when others then raise;
end $$;
