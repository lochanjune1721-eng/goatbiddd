-- The True GOAT — schema + place_bid RPC + RLS. Run in Supabase SQL editor.
create extension if not exists "pgcrypto";

-- users (Supabase Auth id)
create table if not exists users (
  id uuid primary key,
  email text unique,
  display_name text,
  is_anonymous boolean default false,
  balance_cents int default 0 check (balance_cents >= 0),
  total_spent_cents int default 0 check (total_spent_cents >= 0),
  created_at timestamptz default now()
);

create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null, name text not null, group_name text not null, sort_order int
);

create table if not exists people (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  category_id uuid references categories(id) on delete cascade,
  name text not null,
  blurb text,
  wikipedia_url text,
  photo_path text,
  photo_credit text,
  photo_license text,
  total_cents int default 0 check (total_cents >= 0),
  backer_count int default 0,
  first_backed_at timestamptz,
  created_at timestamptz default now()
);
create index if not exists people_category_rank_idx on people (category_id, total_cents desc, first_backed_at asc);
create index if not exists people_slug_idx on people (slug);

create table if not exists bids (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  person_id uuid references people(id) on delete cascade,
  amount_cents int not null check (amount_cents >= 100),
  created_at timestamptz default now()
);
create index if not exists bids_person_idx on bids (person_id, created_at desc);
create index if not exists bids_user_idx on bids (user_id, created_at desc);
create index if not exists bids_created_idx on bids (created_at desc);

create table if not exists topups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  amount_cents int not null check (amount_cents >= 500),
  provider_payment_id text unique,
  status text default 'pending' check (status in ('pending','confirmed','failed')),
  created_at timestamptz default now()
);

create table if not exists fan_totals (
  id uuid primary key default gen_random_uuid(),
  person_id uuid references people(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,
  total_cents int default 0 check (total_cents >= 0),
  unique (person_id, user_id)
);
create index if not exists fan_totals_person_idx on fan_totals (person_id, total_cents desc);

create table if not exists site_stats (
  id int primary key default 1,
  visitor_count int default 0,
  launched_at timestamptz default now()
);
insert into site_stats (id) values (1) on conflict (id) do nothing;

-- storage for 800x800 photos
insert into storage.buckets (id, name, public) values ('people','people', true) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('logos','logos', true) on conflict (id) do nothing;

-- place_bid RPC — the only way to spend credit
create or replace function place_bid(p_person_id uuid, p_amount_cents int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_balance int;
  v_slug text;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;
  if p_amount_cents is null or p_amount_cents < 100 or p_amount_cents % 100 != 0 then
    raise exception 'minimum $1, whole dollars only';
  end if;

  -- lock user row
  select balance_cents into v_balance from users where id = v_user_id for update;
  if not found then
    insert into users (id, balance_cents) values (v_user_id, 0) returning balance_cents into v_balance;
  end if;
  if v_balance < p_amount_cents then
    raise exception 'insufficient balance';
  end if;

  -- check #1 +$5 rule
  select slug into v_slug from people where id = p_person_id;
  if not found then raise exception 'person not found'; end if;

  -- deduct, insert bid, update totals in one txn
  update users set balance_cents = balance_cents - p_amount_cents, total_spent_cents = total_spent_cents + p_amount_cents where id = v_user_id;
  insert into bids (user_id, person_id, amount_cents) values (v_user_id, p_person_id, p_amount_cents);
  update people set total_cents = total_cents + p_amount_cents,
    backer_count = (select count(distinct user_id) from bids where person_id = p_person_id),
    first_backed_at = coalesce(first_backed_at, now())
    where id = p_person_id;

  insert into fan_totals (person_id, user_id, total_cents)
    values (p_person_id, v_user_id, p_amount_cents)
    on conflict (person_id, user_id) do update set total_cents = fan_totals.total_cents + excluded.total_cents;

  -- enforce #1 +$5 at app layer is advisory; DB does not reject lower bids that would still be #2+
  -- but if this bid would make p_person #1 and gap <500, we reject here
  -- compute leader totals
  declare v_new_total int; v_leader_total int;
  begin
    select total_cents into v_new_total from people where id = p_person_id;
    select max(total_cents) into v_leader_total from people where category_id = (select category_id from people where id = p_person_id) and id <> p_person_id;
    if v_leader_total is not null and v_new_total > v_leader_total and v_new_total < v_leader_total + 500 then
      raise exception 'taking #1 costs at least $5 more than the current leader';
    end if;
  end;

  return jsonb_build_object('ok', true, 'new_total', (select total_cents from people where id = p_person_id));
exception when others then
  raise;
end;
$$;

-- add person to board (costs $1 from balance) — if not exists create with $0, else just bid
create or replace function add_person(p_category_id uuid, p_name text, p_blurb text, p_wikipedia_url text, p_photo_path text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  -- verify name has wikipedia entry (basic URL check)
  if p_wikipedia_url is null or p_wikipedia_url !~ '^https://' then raise exception 'wikipedia url required'; end if;
  insert into people (slug, category_id, name, blurb, wikipedia_url, photo_path) values (
    lower(regexp_replace(p_name, '[^a-z0-9]+', '-', 'gi')) || '-' || substr(md5(random()::text),1,4),
    p_category_id, p_name, p_blurb, p_wikipedia_url, p_photo_path
  ) returning id into v_id;
  return v_id;
end;
$$;

-- visitor counter
create or replace function inc_visitor() returns void as $$ begin update site_stats set visitor_count = visitor_count + 1 where id=1; end; $$ language plpgsql;

-- RLS
alter table users enable row level security;
alter table categories enable row level security;
alter table people enable row level security;
alter table bids enable row level security;
alter table topups enable row level security;
alter table fan_totals enable row level security;
alter table site_stats enable row level security;

drop policy if exists "public read categories" on categories;
create policy "public read categories" on categories for select using (true);
drop policy if exists "public read people" on people;
create policy "public read people" on people for select using (true);
drop policy if exists "public read bids" on bids;
create policy "public read bids" on bids for select using (true);
drop policy if exists "public read fan_totals" on fan_totals;
create policy "public read fan_totals" on fan_totals for select using (true);
drop policy if exists "public read site_stats" on site_stats;
create policy "public read site_stats" on site_stats for select using (true);
drop policy if exists "users self read" on users;
create policy "users self read" on users for select using (auth.uid() = id);
drop policy if exists "users self insert" on users;
create policy "users self insert" on users for insert with check (auth.uid() = id);
drop policy if exists "users self update" on users;
create policy "users self update" on users for update using (auth.uid() = id);
drop policy if exists "topups self read" on topups;
create policy "topups self read" on topups for select using (auth.uid() = user_id);
-- no public writes on people/bids/fan_totals — only via RPC or service key
-- no public insert on users except self; balance only via RPC/webhook

drop policy if exists "public read people photos" on storage.objects;
create policy "public read people photos" on storage.objects for select using (bucket_id in ('people','logos'));

-- Fan avatar uploads (wallet.html "Save profile"): a signed-in user may write
-- only under avatars/<their own uid>_*, in the existing public 'people' bucket.
-- Without this, sb.storage.from('people').upload(...) is rejected by RLS and
-- wallet.html's upload silently no-ops (it catches the error and continues).
drop policy if exists "users upload own avatar" on storage.objects;
create policy "users upload own avatar" on storage.objects for insert
  with check (
    bucket_id = 'people'
    and name like 'avatars/' || auth.uid()::text || '_%'
  );
drop policy if exists "users update own avatar" on storage.objects;
create policy "users update own avatar" on storage.objects for update
  using (
    bucket_id = 'people'
    and name like 'avatars/' || auth.uid()::text || '_%'
  );

-- seed categories (~65) — minimal starter, seed script fills people
insert into categories (slug,name,group_name,sort_order) values
  ('footballers','Footballers','Football',1),('managers','Managers','Football',2),('clubs','Clubs','Football',3),('goalkeepers','Goalkeepers','Football',4),
  ('batsmen','Batsmen','Cricket',5),('bowlers','Bowlers','Cricket',6),('all-rounders','All-rounders','Cricket',7),('captains','Captains','Cricket',8),('ipl-players','IPL Players','Cricket',9),('wicketkeepers','Wicketkeepers','Cricket',10),
  ('basketball-players','Basketball Players','Basketball',11),('basketball-teams','Basketball Teams','Basketball',12),
  ('tennis-men','Tennis — Men','Tennis',13),('tennis-women','Tennis — Women','Tennis',14),
  ('boxers','Boxers','Combat',15),('mma-fighters','MMA Fighters','Combat',16),('wrestlers','Wrestlers','Combat',17),
  ('f1-drivers','F1 Drivers','Motorsport',18),('f1-teams','F1 Teams','Motorsport',19),('motogp-riders','MotoGP Riders','Motorsport',20),
  ('track-athletes','Track Athletes','Other Sport',21),('swimmers','Swimmers','Other Sport',22),('golfers','Golfers','Other Sport',23),('hockey-players','Hockey Players','Other Sport',24),('gymnasts','Gymnasts','Other Sport',25),('cyclists','Cyclists','Other Sport',26),
  ('chess-players','Chess Players','Mind Sports',27),('esports-players','Esports Players','Mind Sports',28),('poker-players','Poker Players','Mind Sports',29),
  ('hollywood-actors','Hollywood Actors','Screen',30),('hollywood-actresses','Hollywood Actresses','Screen',31),('bollywood-actors','Bollywood Actors','Screen',32),('bollywood-actresses','Bollywood Actresses','Screen',33),('korean-actors','Korean Actors','Screen',34),('directors','Directors','Screen',35),('films','Films','Screen',36),('tv-shows','TV Shows','Screen',37),('animated-films','Animated Films','Screen',38),('villains','Villains','Screen',39),('comedians','Comedians','Screen',40),
  ('singers','Singers','Music',41),('rappers','Rappers','Music',42),('bands','Bands','Music',43),('guitarists','Guitarists','Music',44),('drummers','Drummers','Music',45),('composers','Composers','Music',46),('producers','Producers','Music',47),('djs','DJs','Music',48),('albums','Albums','Music',49),('playback-singers','Playback Singers','Music',50),('kpop-groups','K-pop Groups','Music',51),
  ('scientists','Scientists','Mind',52),('physicists','Physicists','Mind',53),('mathematicians','Mathematicians','Mind',54),('chemists','Chemists','Mind',55),('biologists','Biologists','Mind',56),('philosophers','Philosophers','Mind',57),('economists','Economists','Mind',58),('inventors','Inventors','Mind',59),('astronauts','Astronauts','Mind',60),
  ('novelists','Novelists','Words',61),('poets','Poets','Words',62),('playwrights','Playwrights','Words',63),('books','Books','Words',64),
  ('us-presidents','US Presidents','Power',65),('indian-pms','Indian PMs','Power',66),('emperors','Emperors','Power',67),('generals','Generals','Power',68),('revolutionaries','Revolutionaries','Power',69),
  ('founders','Founders','Business',70),('investors','Investors','Business',71),('ceos','CEOs','Business',72),('companies','Companies','Business',73),
  ('painters','Painters','Culture',74),('photographers','Photographers','Culture',75),('architects','Architects','Culture',76),('chefs','Chefs','Culture',77),('fashion-designers','Fashion Designers','Culture',78),('dancers','Dancers','Culture',79),
  ('youtubers','YouTubers','Internet',80),('streamers','Streamers','Internet',81),('podcasters','Podcasters','Internet',82),('ai-startups','AI Startups','Internet',83)
on conflict (slug) do nothing;

-- seed one person per spec note (empty boards where $1 takes #1 is better, but seed one for smoke)
do $$ declare cat uuid; begin
  select id into cat from categories where slug='footballers' limit 1;
  if cat is not null and not exists (select 1 from people where slug='lionel-messi') then
    insert into people (slug, category_id, name, blurb, wikipedia_url, photo_credit, photo_license, total_cents) values
      ('lionel-messi', cat, 'Lionel Messi', 'Eight-time Ballon d''Or winner.', 'https://en.wikipedia.org/wiki/Lionel_Messi', 'Photo: Wikimedia Commons', 'CC BY-SA 4.0', 0);
  end if;
end $$;
-- PART 6 — schema additions
alter table users
  add column if not exists photo_path text,
  add column if not exists social_handle text,
  add column if not exists social_platform text check (social_platform in ('x','instagram','tiktok','youtube','other')),
  add column if not exists photo_status text default 'none' check (photo_status in ('none','pending','approved','flagged','rejected')),
  add column if not exists anon_session_id text unique;

create index if not exists fan_totals_person_idx on fan_totals (person_id, total_cents desc);
create index if not exists people_category_total_idx on people (category_id, total_cents desc, first_backed_at asc);

-- storage for fan photos (reuse people bucket, but add policy already exists)

-- credit_balance — legacy settlement entry point, superseded by confirm_topup below
create or replace function credit_balance(p_user_id uuid, p_amount_cents int, p_payment_id text)
returns int language plpgsql security definer set search_path = public as $$
declare v_new int;
begin
  if p_amount_cents < 500 then raise exception 'Minimum is 5 votes'; end if;
  -- idempotency via provider_payment_id
  insert into topups (user_id, amount_cents, provider_payment_id, status) values (p_user_id, p_amount_cents, p_payment_id, 'confirmed') on conflict (provider_payment_id) do nothing;
  update users set balance_cents = balance_cents + p_amount_cents where id = p_user_id returning balance_cents into v_new;
  return v_new;
end $$;

-- place_vote — new canonical name, keeps cents internally, 1 vote = 100 cents. Wrapper keeps place_bid for back-compat.
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

-- keep place_bid as wrapper for old callers
create or replace function place_bid(p_person_id uuid, p_amount_cents int)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  return place_vote(p_person_id, p_amount_cents / 100);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Payments are PayPal. topups.dodo_payment_id predates that switch; it holds
-- the provider's id for the settled payment (now a PayPal capture id), so it
-- is renamed rather than replaced. provider_order_id holds the PayPal order,
-- which exists from the moment checkout opens and is how a returning payer's
-- order is matched back to the row.
do $$ begin
  if exists (select 1 from information_schema.columns
             where table_name = 'topups' and column_name = 'dodo_payment_id') then
    alter table topups rename column dodo_payment_id to provider_payment_id;
  end if;
end $$;
alter table topups add column if not exists provider_order_id text;
create index if not exists topups_provider_order_idx on topups (provider_order_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Money guards. Everything below closes a path that let a signed-in browser,
-- or an unauthenticated POST, give itself credit for free.
-- ─────────────────────────────────────────────────────────────────────────────

-- The $1 minimum the checkout advertises has to be a legal row: the old
-- >= 500 check rejected every top-up under five votes at the database.
alter table topups drop constraint if exists topups_amount_cents_check;
alter table topups add constraint topups_amount_cents_check check (amount_cents >= 100);

-- RLS is row-level, not column-level, so "users self update" let any signed-in
-- caller PATCH /rest/v1/users and set their own balance_cents to anything they
-- liked. This trigger is the column-level half of that policy.
--
-- It keys off current_user, not auth.uid(): PostgREST executes a browser's
-- request as the `authenticated` (or `anon`) role, while the SECURITY DEFINER
-- money functions below run as the function owner. So votes and settled
-- payments still move the balance; a direct table write never does.
create or replace function guard_balance_columns()
returns trigger language plpgsql as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  -- "users self insert" is equally column-blind, so a brand-new row could be
  -- created with a balance already in it. Force the opening balance to zero
  -- rather than rejecting the insert, since ensureUserRow() runs on every
  -- first sign-in and must keep working.
  if tg_op = 'INSERT' then
    new.balance_cents := 0;
    new.total_spent_cents := 0;
    return new;
  end if;

  if new.balance_cents is distinct from old.balance_cents
     or new.total_spent_cents is distinct from old.total_spent_cents then
    raise exception 'balance_cents and total_spent_cents can only change through a payment or a vote';
  end if;
  return new;
end $$;

drop trigger if exists guard_balance_columns on users;
create trigger guard_balance_columns
  before insert or update on users
  for each row execute function guard_balance_columns();

-- confirm_topup — the one way a payment turns into balance.
--
-- Idempotent on provider_payment_id, because a webhook is delivered at least once
-- and a retry must not credit twice. Settles the pending row the checkout
-- created when there is one, rather than leaving a second row behind.
create or replace function confirm_topup(p_topup_id uuid, p_user_id uuid, p_amount_cents int, p_payment_id text)
returns int language plpgsql security definer set search_path = public as $$
declare v_new int; v_id uuid;
begin
  if p_user_id is null then raise exception 'Missing user'; end if;
  if p_amount_cents is null or p_amount_cents < 100 then raise exception 'Invalid top-up amount'; end if;
  if p_payment_id is null or p_payment_id = '' then raise exception 'Missing payment id'; end if;

  -- Already settled under this payment id — return the balance, change nothing.
  if exists (select 1 from topups where provider_payment_id = p_payment_id and status = 'confirmed') then
    select balance_cents into v_new from users where id = p_user_id;
    return v_new;
  end if;

  if p_topup_id is not null then
    update topups set status = 'confirmed', provider_payment_id = p_payment_id
      where id = p_topup_id and status <> 'confirmed'
      returning id into v_id;
  end if;

  if v_id is null then
    insert into topups (user_id, amount_cents, provider_payment_id, status)
      values (p_user_id, p_amount_cents, p_payment_id, 'confirmed')
      on conflict (provider_payment_id) do nothing
      returning id into v_id;
  end if;

  -- Lost the race to a concurrent delivery of the same payment.
  if v_id is null then
    select balance_cents into v_new from users where id = p_user_id;
    return v_new;
  end if;

  update users set balance_cents = balance_cents + p_amount_cents
    where id = p_user_id returning balance_cents into v_new;
  return v_new;
end $$;

-- credit_balance() minted balance for an arbitrary user id, and its insert was
-- idempotent while its balance update was not — a replayed payment id deduped
-- the receipt and credited the wallet again. Delegate to confirm_topup so
-- there is a single settlement path.
create or replace function credit_balance(p_user_id uuid, p_amount_cents int, p_payment_id text)
returns int language plpgsql security definer set search_path = public as $$
begin
  return confirm_topup(null, p_user_id, p_amount_cents, p_payment_id);
end $$;

-- PostgREST publishes every function in `public` as an RPC, and Supabase grants
-- EXECUTE to anon/authenticated by default. Both of these take the user id as
-- an argument, so leaving that grant in place meant any visitor holding the
-- (public) anon key could POST /rest/v1/rpc/credit_balance and top up their own
-- wallet. Only the service role — the webhook — may settle a payment.
revoke execute on function confirm_topup(uuid, uuid, int, text) from public, anon, authenticated;
revoke execute on function credit_balance(uuid, int, text) from public, anon, authenticated;
grant execute on function confirm_topup(uuid, uuid, int, text) to service_role;
grant execute on function credit_balance(uuid, int, text) to service_role;

-- place_vote reads auth.uid() and can only spend the caller's own balance, so
-- it stays callable from the browser. Restated here so a future default-grant
-- sweep does not quietly take it away.
grant execute on function place_vote(uuid, int) to authenticated;
grant execute on function place_bid(uuid, int) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Multiple payment providers.
--
-- topups recorded provider_payment_id but never which provider issued it, so a
-- receipt could not say whether it was a card or a UPI transfer, and the
-- idempotency key was globally unique across providers rather than per
-- provider. Both matter as soon as there is more than one.
-- ─────────────────────────────────────────────────────────────────────────────

alter table topups add column if not exists provider text not null default 'paypal';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'topups_provider_check') then
    alter table topups add constraint topups_provider_check
      check (provider in ('paypal', 'uropay', 'test'));
  end if;
end $$;

-- Uniqueness belongs on (provider, id): two providers can legitimately issue
-- the same transaction id, and a collision must not silently swallow a payment.
--
-- Dropped by shape, not by name. A project that predates the PayPal switch had
-- this column as dodo_payment_id, and ALTER TABLE ... RENAME COLUMN renames the
-- column but leaves the constraint called topups_dodo_payment_id_key. Naming it
-- literally only worked on databases created after the rename; on a migrated
-- one the old global unique survived, and the first payment whose transaction
-- id already existed under another provider failed with a duplicate key instead
-- of crediting the wallet.
do $$ declare r record; begin
  for r in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'topups'::regclass
      and con.contype = 'u'
      and con.conkey = array[(select attnum from pg_attribute
                              where attrelid = 'topups'::regclass
                                and attname = 'provider_payment_id')]
  loop
    execute format('alter table topups drop constraint %I', r.conname);
  end loop;
end $$;

-- Same again for a bare unique index, which carries no constraint row.
do $$ declare r record; begin
  for r in
    select cls.relname
    from pg_index idx
    join pg_class cls on cls.oid = idx.indexrelid
    where idx.indrelid = 'topups'::regclass
      and idx.indisunique and not idx.indisprimary
      and idx.indnatts = 1
      and idx.indkey[0] = (select attnum from pg_attribute
                           where attrelid = 'topups'::regclass
                             and attname = 'provider_payment_id')
  loop
    execute format('drop index %I', r.relname);
  end loop;
end $$;
-- Not a partial index: ON CONFLICT cannot infer one without repeating its
-- predicate, and confirm_topup relies on this constraint for idempotency.
-- Pending rows are unaffected — provider_payment_id is null until settlement,
-- and Postgres treats nulls as distinct, so any number of them coexist.
drop index if exists topups_provider_payment_idx;
create unique index if not exists topups_provider_payment_idx
  on topups (provider, provider_payment_id);

create index if not exists topups_provider_idx on topups (provider, created_at desc);

-- confirm_topup gains the provider. The four-argument version is dropped rather
-- than left in place: an overload that still resolves would let a caller settle
-- a payment without saying where it came from.
drop function if exists confirm_topup(uuid, uuid, int, text);

create or replace function confirm_topup(p_topup_id uuid, p_user_id uuid, p_amount_cents int, p_payment_id text, p_provider text)
returns int language plpgsql security definer set search_path = public as $$
declare v_new int; v_id uuid;
begin
  if p_user_id is null then raise exception 'Missing user'; end if;
  if p_amount_cents is null or p_amount_cents < 100 then raise exception 'Invalid top-up amount'; end if;
  if p_payment_id is null or p_payment_id = '' then raise exception 'Missing payment id'; end if;
  if p_provider is null or p_provider = '' then raise exception 'Missing provider'; end if;

  -- Already settled under this provider's payment id — change nothing.
  if exists (select 1 from topups
             where provider = p_provider and provider_payment_id = p_payment_id and status = 'confirmed') then
    select balance_cents into v_new from users where id = p_user_id;
    return v_new;
  end if;

  if p_topup_id is not null then
    update topups set status = 'confirmed', provider_payment_id = p_payment_id, provider = p_provider
      where id = p_topup_id and status <> 'confirmed'
      returning id into v_id;
  end if;

  if v_id is null then
    insert into topups (user_id, amount_cents, provider_payment_id, provider, status)
      values (p_user_id, p_amount_cents, p_payment_id, p_provider, 'confirmed')
      on conflict (provider, provider_payment_id) do nothing
      returning id into v_id;
  end if;

  -- Lost the race to a concurrent delivery of the same payment.
  if v_id is null then
    select balance_cents into v_new from users where id = p_user_id;
    return v_new;
  end if;

  update users set balance_cents = balance_cents + p_amount_cents
    where id = p_user_id returning balance_cents into v_new;
  return v_new;
end $$;

create or replace function credit_balance(p_user_id uuid, p_amount_cents int, p_payment_id text)
returns int language plpgsql security definer set search_path = public as $$
begin
  return confirm_topup(null, p_user_id, p_amount_cents, p_payment_id, 'test');
end $$;

revoke execute on function confirm_topup(uuid, uuid, int, text, text) from public, anon, authenticated;
grant execute on function confirm_topup(uuid, uuid, int, text, text) to service_role;

-- The wallet is denominated in USD cents (100 cents = 1 vote), but a UPI order
-- is charged in rupees. Record what the provider was actually asked for, so
-- settlement can check the captured amount against it in the provider's own
-- currency instead of comparing rupees to cents.
alter table topups add column if not exists provider_amount numeric(12,2);
alter table topups add column if not exists provider_currency text;

-- ─────────────────────────────────────────────────────────────────────────────
-- Direct UPI (pay straight to the site's own VPA).
--
-- Unlike a gateway, a UPI transfer to a VPA has no callback: nothing can tell
-- the server the money arrived. So this rail cannot auto-credit. The payer
-- submits the UTR from their bank app, the top-up parks in 'review', and it is
-- approved against the bank statement in the admin page. Crediting on an
-- unverified claim would be free money for anyone who typed twelve digits.
-- ─────────────────────────────────────────────────────────────────────────────

alter table topups drop constraint if exists topups_status_check;
alter table topups add constraint topups_status_check
  check (status in ('pending','review','confirmed','failed'));

alter table topups drop constraint if exists topups_provider_check;
alter table topups add constraint topups_provider_check
  check (provider in ('paypal', 'uropay', 'upi', 'test'));

-- The UTR a payer claims is stored in provider_payment_id while the top-up is
-- still in review, so the (provider, provider_payment_id) unique index does
-- double duty: it stops the same reference being claimed twice.
alter table topups add column if not exists claimed_at timestamptz;
alter table topups add column if not exists reviewed_at timestamptz;
alter table topups add column if not exists review_note text;

create index if not exists topups_review_idx on topups (status, claimed_at desc)
  where status = 'review';

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

-- ─────────────────────────────────────────────────────────────────────────────
-- Editorial starting order.
--
-- A fresh board is 20 contenders on $0 each, so total_cents cannot order it and
-- first_backed_at is null for all of them — the board would come back in
-- whatever order Postgres felt like, and the homepage fight would be a random
-- pair rather than #1 vs #2. seed_rank carries the curated order until money
-- starts moving it, and it is the LAST tiebreak: a single dollar still outranks
-- any amount of editorial opinion.
-- ─────────────────────────────────────────────────────────────────────────────
alter table people add column if not exists seed_rank int;
create index if not exists people_board_order_idx
  on people (category_id, total_cents desc, first_backed_at asc nulls last, seed_rank asc nulls last);
