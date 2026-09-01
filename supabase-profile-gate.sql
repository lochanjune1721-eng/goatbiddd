-- supabase-profile-gate.sql
--
-- Paste into Supabase → SQL Editor → New query → Run. Guarded throughout, so
-- running it twice changes nothing.
--
-- Nobody backs a contender without a name and an email on their account.
--
-- The check lives here rather than only in the page because the anon key ships
-- in the browser: a hand-made POST to /rest/v1/rpc/place_vote reaches the same
-- function a button does. A rule the page enforces alone is a suggestion.
--
-- A photo is not required — it is asked for at sign-in, filled in automatically
-- from Google where that is how someone signed in, and can be added later. It is
-- not part of the gate.

-- Where an uploaded avatar lives. Public read, like the contender portraits:
-- a fan's face is shown on every board they lead.
do $$ begin
  insert into storage.buckets (id, name, public) values ('avatars','avatars', true)
    on conflict (id) do nothing;
exception when undefined_table or insufficient_privilege then
  -- No storage schema (a plain Postgres, not a Supabase project). The gate
  -- below is what matters and does not depend on it.
  raise notice 'storage.buckets not available here — skipping the avatars bucket';
end $$;

-- Anyone may see a face; only its owner may put one there or replace it. The
-- first path segment is the user's id, which is what ties an object to a person.
do $$ begin
  if to_regclass('storage.objects') is null then return; end if;
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='avatars public read') then
    create policy "avatars public read" on storage.objects
      for select using (bucket_id = 'avatars');
  end if;
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='avatars owner write') then
    create policy "avatars owner write" on storage.objects
      for insert to authenticated
      with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='avatars owner update') then
    create policy "avatars owner update" on storage.objects
      for update to authenticated
      using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
end $$;

-- ── The gate itself ─────────────────────────────────────────────────────────

-- Name and email, both actually filled in. A row of spaces is not a name, which
-- is why this trims before testing rather than checking for null.
create or replace function profile_ready(p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(nullif(btrim(u.display_name), '') is not null
              and nullif(btrim(u.email), '')        is not null, false)
    from users u where u.id = p_user;
$$;

do $$ begin
  grant execute on function profile_ready(uuid) to anon, authenticated, service_role;
exception when undefined_object then
  raise notice 'anon/authenticated/service_role not present — skipping grants on profile_ready';
end $$;

-- place_vote is what the page calls. The user comes from the JWT, never from an
-- argument, so this cannot be pointed at someone else's wallet.
create or replace function place_vote(p_person_id uuid, p_votes int)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not coalesce(profile_ready(auth.uid()), false) then
    raise exception 'profile incomplete'
      using hint = 'Add your name and email to your account before backing a contender.';
  end if;
  return place_vote_for(auth.uid(), p_person_id, p_votes);
end $$;

do $$ begin
  revoke execute on function place_vote(uuid, int) from public;
  grant  execute on function place_vote(uuid, int) to authenticated, service_role;
exception when undefined_object then
  raise notice 'authenticated/service_role not present — skipping grants on place_vote';
end $$;

-- place_bid is the older entry point the pages still fall back to when
-- place_vote is missing. Gated identically, so the fallback is not a way around
-- the rule. The body is otherwise the original: balance locked, bid recorded,
-- totals and fan totals updated in one transaction.
create or replace function place_bid(p_person_id uuid, p_amount_cents int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_balance int;
begin
  if v_user_id is null then raise exception 'not authenticated'; end if;
  if not coalesce(profile_ready(v_user_id), false) then
    raise exception 'profile incomplete'
      using hint = 'Add your name and email to your account before backing a contender.';
  end if;
  if p_amount_cents is null or p_amount_cents < 100 or p_amount_cents % 100 != 0 then
    raise exception 'minimum $1, whole dollars only';
  end if;

  select balance_cents into v_balance from users where id = v_user_id for update;
  if not found then
    insert into users (id, balance_cents) values (v_user_id, 0) returning balance_cents into v_balance;
  end if;
  if v_balance < p_amount_cents then raise exception 'insufficient balance'; end if;
  if not exists (select 1 from people where id = p_person_id) then raise exception 'person not found'; end if;

  update users set balance_cents = balance_cents - p_amount_cents,
                   total_spent_cents = total_spent_cents + p_amount_cents
   where id = v_user_id;
  insert into bids (user_id, person_id, amount_cents) values (v_user_id, p_person_id, p_amount_cents);
  update people set total_cents = total_cents + p_amount_cents,
                    backer_count = (select count(distinct user_id) from bids where person_id = p_person_id),
                    first_backed_at = coalesce(first_backed_at, now())
   where id = p_person_id;
  insert into fan_totals (person_id, user_id, total_cents)
    values (p_person_id, v_user_id, p_amount_cents)
    on conflict (person_id, user_id) do update set total_cents = fan_totals.total_cents + excluded.total_cents;

  return jsonb_build_object('ok', true, 'new_total', (select total_cents from people where id = p_person_id));
end $$;

do $$ begin
  revoke execute on function place_bid(uuid, int) from public;
  grant  execute on function place_bid(uuid, int) to authenticated, service_role;
exception when undefined_object then
  raise notice 'authenticated/service_role not present — skipping grants on place_bid';
end $$;

-- Confirms the gate is live. Both rows should read 'yes'.
select 'place_vote gated' as check,
       case when pg_get_functiondef('place_vote(uuid,int)'::regprocedure) like '%profile_ready%'
            then 'yes' else 'no' end as ok
union all
select 'place_bid gated',
       case when pg_get_functiondef('place_bid(uuid,int)'::regprocedure) like '%profile_ready%'
            then 'yes' else 'no' end;
