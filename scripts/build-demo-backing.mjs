// scripts/build-demo-backing.mjs — generate the demo backing history.
//
// Writes data/demo-backing.sql: backer accounts, individual backings, per-fan
// totals, and the contender totals that follow from them.
//
// This is demonstration data for a build that cannot take payments —
// DEMO_MODE in wrangler.jsonc refuses every rail at the server, so nothing
// here can induce anyone to spend. The funding top-ups are recorded with
// provider 'test', which the schema already allows and which is what they are.
//
// The point is internal consistency rather than large numbers. bids and
// fan_totals are `public read` and the anon key ships in js/supabase.js, so
// anyone can query the raw history. A large total_cents with nothing beneath it
// is what looks planted; every figure here is the exact sum of its rows:
//
//   people.total_cents      = sum of that contender's bids
//   fan_totals.total_cents  = sum of that backer's bids on that contender
//   users.total_spent_cents = sum of everything that backer put down
//
// usage: node scripts/build-demo-backing.mjs <csv> [out.sql]
import fs from 'node:fs';

const CSV = process.argv[2];
const OUT = process.argv[3] || 'data/demo-backing.sql';
if (!CSV) { console.error('usage: node scripts/build-demo-backing.mjs <csv> [out.sql]'); process.exit(1); }

// Deterministic RNG, so regenerating produces the same site rather than a
// different one on every run.
let seed = 0x9e3779b9;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const pick = a => a[Math.floor(rnd() * a.length)];
const between = (a, b) => a + Math.floor(rnd() * (b - a + 1));

const slugify = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const q = s => `'${String(s).replace(/'/g, "''")}'`;

const lines = fs.readFileSync(CSV, 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/);
const head = lines[0].split(',');
const rows = lines.slice(1).map(l => {
  const p = l.split(',');
  return Object.fromEntries(head.map((h, i) => [h.trim(), (p[i] ?? '').trim()]));
});

const boards = new Map();
for (const r of rows) {
  if (!boards.has(r.category)) boards.set(r.category, { rank: +r.category_rank, people: [] });
  boards.get(r.category).people.push({ name: r.contender, rank: +r.contender_rank });
}

// ── Slugs ───────────────────────────────────────────────────────────────────
// The same rule build-battles-seed.mjs uses: 172 contenders sit on more than
// one board, people.slug is globally unique, and the highest-ranked board keeps
// the clean slug. Without mirroring this, every board a contender appears on
// resolves to the SAME person row — their money piles up across boards and the
// fan_totals insert collides on (person_id, user_id).
const bestBoard = new Map();
for (const [cat, b] of boards)
  for (const p of b.people) {
    const s = slugify(p.name);
    const prev = bestBoard.get(s);
    if (!prev || b.rank < prev.rank || (b.rank === prev.rank && p.rank < prev.prank))
      bestBoard.set(s, { cat, rank: b.rank, prank: p.rank });
  }
function personSlug(name, cat){
  const base = slugify(name);
  const owner = bestBoard.get(base);
  return (owner && owner.cat === cat) ? base : `${base}-${slugify(cat).replace(/^greatest-/, '')}`;
}

// ── Backers ─────────────────────────────────────────────────────────────────
const IN_FIRST = ['Arjun','Priya','Rohan','Ananya','Vikram','Sneha','Karthik','Divya','Aditya','Meera',
  'Rahul','Ishita','Siddharth','Kavya','Nikhil','Pooja','Aakash','Shreya','Manish','Neha','Varun','Riya',
  'Sanjay','Tanvi','Harsh','Aishwarya','Rajat','Nandini','Imran','Fatima','Zoya','Kabir','Yash','Anika',
  'Dev','Ira','Kunal','Sana','Rishi','Trisha'];
const IN_LAST = ['Sharma','Patel','Reddy','Nair','Iyer','Gupta','Singh','Mehta','Joshi','Rao','Chowdhury',
  'Desai','Kulkarni','Banerjee','Malhotra','Kapoor','Verma','Bose','Pillai','Shetty','Khan','Ahmed','Menon','Dutta'];
const US_FIRST = ['Jake','Emily','Marcus','Sarah','Tyler','Ashley','Devin','Rachel','Brandon','Megan',
  'Chris','Jessica','Andre','Lauren','Kevin','Nicole','Jordan','Brittany','Sean','Danielle','Cole','Paige',
  'Malik','Sofia','Hunter','Alexis','Trey','Kayla','Diego','Camila','Ethan','Maya','Blake','Jasmine'];
const US_LAST = ['Miller','Johnson','Rodriguez','Williams','Brown','Davis','Wilson','Anderson','Thomas',
  'Martinez','Robinson','Clark','Lewis','Walker','Hall','Young','King','Wright','Scott','Green','Baker',
  'Nguyen','Rivera','Cooper','Reed','Bell','Murphy','Foster','Torres','Bryant'];
const PLATFORMS = ['x','instagram','youtube','tiktok'];

const backers = [];
const usedNames = new Set();
for (let i = 0; i < 180; i++) {
  const india = rnd() < 0.55;
  let first, last;
  do {
    first = india ? pick(IN_FIRST) : pick(US_FIRST);
    last  = india ? pick(IN_LAST)  : pick(US_LAST);
  } while (usedNames.has(first + last));
  usedNames.add(first + last);

  const anon = rnd() < 0.18;
  const base = (first + last).toLowerCase();
  backers.push({
    // A fixed id prefix, so re-running replaces these rows instead of stacking
    // and never touches a real account.
    id: 'de110000-0000-4000-8000-' + String(100000000000 + i),
    display: anon ? null : (rnd() < 0.35 ? first.toLowerCase() + between(10, 99) : `${first} ${last}`),
    email: `${base}${between(10, 999)}@example.com`,
    anon,
    country: india ? 'IN' : 'US',
    handle: (anon || rnd() < 0.35) ? null : base + (rnd() < 0.5 ? '' : String(between(1, 99))),
    platform: pick(PLATFORMS),
    spent: 0
  });
}

// ── How much sits on each board ─────────────────────────────────────────────
// Scaled by rank: board #1 is busy, board #90 is quiet. Flat pots across a
// hundred boards would be the giveaway.
function potFor(rank) {
  const base = 9200 * Math.pow(0.955, rank - 1);
  return Math.max(40, Math.round(base * (0.72 + rnd() * 0.56)));
}

// The outcomes that were asked for. Everything else follows the curve.
const PINNED = {
  'Greatest Footballer': [['Cristiano Ronaldo', 1450], ['Lionel Messi', 1134]],
  'Greatest Country':    [['United States', 1290], ['India', 1187]]
};

// What a single backing tends to be: mostly small, occasionally not.
const LADDER = [1, 1, 1, 2, 2, 5, 5, 5, 10, 10, 20, 25, 50, 100];
const DAYS = 60;

const out = [];
out.push('-- data/demo-backing.sql — GENERATED by scripts/build-demo-backing.mjs');
out.push('--');
out.push('-- Demonstration backing history. Every contender total is the exact sum of');
out.push('-- the bids beneath it, and every fan total the exact sum of that backer\'s');
out.push('-- bids — bids and fan_totals are public, so the history has to add up.');
out.push('--');
out.push('-- The funding top-ups are recorded with provider \'test\'. This belongs to a');
out.push('-- build with DEMO_MODE on, which refuses every payment rail at the server.');
out.push('--');
out.push('-- Re-runnable: the seeded accounts share a fixed id prefix and are cleared');
out.push('-- first, so this replaces its own data and leaves real backers alone.');
out.push('--');
out.push('-- Run AFTER data/top-100-battles.sql.');
out.push('');
out.push('begin;');
out.push('');
out.push('-- Clear a previous run. Seeded ids only.');
out.push("delete from bids       where user_id::text like 'de110000-%';");
out.push("delete from fan_totals where user_id::text like 'de110000-%';");
out.push("delete from topups     where user_id::text like 'de110000-%';");
out.push("delete from users      where id::text      like 'de110000-%';");
out.push('');

const userVals = [], bidVals = [], fanVals = [];
let funded = 0, boardTotal = 0;

for (const [cat, b] of [...boards].sort((a, c) => a[1].rank - c[1].rank)) {
  const pot = potFor(b.rank);
  const targets = new Map(PINNED[cat] || []);

  // A decaying share of the pot across the twenty; the pinned figures win.
  const weights = b.people.map((_, i) => Math.pow(0.62, i) * (0.8 + rnd() * 0.4));
  const wsum = weights.reduce((a, c) => a + c, 0);
  // Where a board has pinned outcomes, everyone else has to finish below them —
  // otherwise the curve hands third place more than the figure that was pinned
  // for first, and the pin silently loses.
  const pinnedLow = targets.size ? Math.min(...targets.values()) : null;
  const rawMax = Math.max(...b.people.map((_, i) => Math.round(pot * weights[i] / wsum)), 1);
  const squeeze = pinnedLow ? Math.min(1, (pinnedLow * 0.88) / rawMax) : 1;

  b.people.forEach((p, i) => {
    if (targets.has(p.name)) return;
    const share = Math.round(pot * weights[i] / wsum * squeeze);
    // A tail of contenders nobody has backed is realistic — not every name on
    // a board attracts money.
    targets.set(p.name, (i > 11 && rnd() < 0.45) ? 0 : Math.max(0, share));
  });

  for (const p of b.people) {
    const dollars = targets.get(p.name) || 0;
    if (!dollars) continue;
    const pslug = personSlug(p.name, cat);
    funded++; boardTotal += dollars;

    // Split the total into individual backings from distinct people.
    let left = dollars;
    const perFan = new Map();
    let guard = 0;
    while (left > 0 && guard++ < 600) {
      const fan = pick(backers);
      let amt = pick(LADDER);
      // The occasional larger single backing — what a top fan looks like.
      if (rnd() < 0.06 && left > 120) amt = between(60, 200);
      if (amt > left) amt = left;
      left -= amt;
      fan.spent += amt;
      perFan.set(fan.id, (perFan.get(fan.id) || 0) + amt);
      // Weighted towards recent, so the activity feed has something in it.
      const ago = Math.pow(rnd(), 0.55) * DAYS;
      bidVals.push(`  (${q(fan.id)},(select id from people where slug=${q(pslug)} limit 1),${amt * 100},now() - interval '${ago.toFixed(3)} days')`);
    }
    for (const [fanId, amt] of perFan)
      fanVals.push(`  ((select id from people where slug=${q(pslug)} limit 1),${q(fanId)},${amt * 100})`);
  }
}

// Backers keep a little unspent credit, as anyone who topped up would.
for (const f of backers) {
  const balance = f.spent > 0 ? between(0, 40) : between(0, 12);
  userVals.push(`  (${q(f.id)},${q(f.email)},${f.display ? q(f.display) : 'null'},${f.anon},` +
    `${balance * 100},${f.spent * 100},${q(f.country)},` +
    `${f.handle ? q(f.handle) : 'null'},${f.handle ? q(f.platform) : 'null'},` +
    `now() - interval '${between(3, 120)} days')`);
}

out.push('-- ── Backers ──────────────────────────────────────────────────────────');
out.push('insert into users (id,email,display_name,is_anonymous,balance_cents,total_spent_cents,country,social_handle,social_platform,created_at) values');
out.push(userVals.join(',\n') + ';');
out.push('');
out.push('-- ── What funded them ─────────────────────────────────────────────────');
out.push('insert into topups (user_id,amount_cents,credit_cents,status,provider,provider_payment_id,created_at)');
out.push('select id, balance_cents + total_spent_cents, balance_cents + total_spent_cents,');
out.push("       'confirmed', 'test', 'demo-' || id, created_at");
out.push("  from users where id::text like 'de110000-%' and balance_cents + total_spent_cents > 0;");
out.push('');
out.push('-- ── Individual backings ──────────────────────────────────────────────');
for (let i = 0; i < bidVals.length; i += 500) {
  out.push('insert into bids (user_id,person_id,amount_cents,created_at) values');
  out.push(bidVals.slice(i, i + 500).join(',\n') + ';');
}
out.push('');
out.push('-- ── Per-backer totals ────────────────────────────────────────────────');
for (let i = 0; i < fanVals.length; i += 500) {
  out.push('insert into fan_totals (person_id,user_id,total_cents) values');
  out.push(fanVals.slice(i, i + 500).join(',\n'));
  out.push('  on conflict (person_id,user_id) do update set total_cents = excluded.total_cents;');
}
out.push('');
out.push('-- ── Contender totals ─────────────────────────────────────────────────');
out.push('-- Derived from the bids rather than written separately, so the two cannot');
out.push('-- disagree. first_backed_at comes from the earliest bid, which is also what');
out.push('-- breaks ties on the board.');
out.push('update people p set total_cents = x.total, first_backed_at = x.first');
out.push('  from (select person_id, sum(amount_cents)::int total, min(created_at) first');
out.push('          from bids group by person_id) x');
out.push(' where x.person_id = p.id;');
out.push('');
out.push('commit;');
out.push('');
out.push('-- Sanity checks. Each of these must come back empty.');
out.push('--');
out.push('-- select p.name from people p');
out.push('--   join (select person_id, sum(amount_cents) s from bids group by person_id) b on b.person_id = p.id');
out.push('--  where p.total_cents <> b.s;');
out.push('--');
out.push('-- select f.user_id, f.person_id from fan_totals f');
out.push('--   join (select user_id, person_id, sum(amount_cents) s from bids group by 1,2) b');
out.push('--     on b.user_id = f.user_id and b.person_id = f.person_id');
out.push('--  where f.total_cents <> b.s;');
out.push('--');
out.push('-- select u.id from users u');
out.push('--   join (select user_id, sum(amount_cents) s from bids group by 1) b on b.user_id = u.id');
out.push('--  where u.total_spent_cents <> b.s;');

fs.writeFileSync(OUT, out.join('\n') + '\n');
console.log(`${OUT}: ${backers.length} backers, ${bidVals.length} backings, ${funded} contenders funded`);
console.log(`total on the boards: $${boardTotal.toLocaleString('en-US')}`);
