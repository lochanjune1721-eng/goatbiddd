-- supabase-seed-rank.sql
--
-- Paste into Supabase -> SQL Editor -> New query -> Run, BEFORE
-- data/top-100-battles.sql.
--
-- A fresh board is 20 contenders on $0 each, so total_cents cannot order it and
-- first_backed_at is null for all of them — the board would come back in
-- whatever order Postgres felt like, and the homepage fight would be a random
-- pair rather than #1 vs #2. seed_rank carries the curated order until money
-- starts moving it, and it is the LAST tiebreak: a single dollar still outranks
-- any amount of editorial opinion.
--
-- One column and one index. Existing rows get NULL and sort last among ties,
-- which is the right place for a contender nobody ranked.

alter table people add column if not exists seed_rank int;
create index if not exists people_board_order_idx
  on people (category_id, total_cents desc, first_backed_at asc nulls last, seed_rank asc nulls last);
