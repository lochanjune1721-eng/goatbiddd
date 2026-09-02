// scripts/test-top-fans.mjs — /api/top-fans against a database where the
// fan_totals cache is stale.
//
// The bug this pins down: a contender can carry real dollars and still have no
// fan_totals row. people.total_cents is recomputed from bids in more than one
// place (data/demo-backing-remove.sql among them) and the cache is not, so the
// money is right and the cache has nothing to name the backer from. On the site
// that showed as Ronaldo at $135 with a crown instead of a face.
//
// Ronaldo here has bids and no cache row; Messi has a cache row; Pelé has
// neither. All three have to come out right.
//
//   node scripts/test-top-fans.mjs
import assert from 'node:assert/strict';

const RONALDO = '11111111-1111-4111-8111-111111111111';
const MESSI   = '22222222-2222-4222-8222-222222222222';
const PELE    = '33333333-3333-4333-8333-333333333333';
const PHILIP  = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SMALLER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DANA    = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

globalThis.__db = {
  people: [
    { id: RONALDO, name: 'Cristiano Ronaldo', total_cents: 13500 },
    { id: MESSI,   name: 'Lionel Messi',      total_cents:  6900 },
    { id: PELE,    name: 'Pelé',              total_cents:   500 }
  ],
  // Only Messi is in the cache. Ronaldo's money is in bids alone, and Pelé's
  // $5 has no backer on record at all.
  fan_totals: [
    { id: 'ft1', person_id: MESSI, user_id: DANA, total_cents: 6900 }
  ],
  bids: [
    { id: 'b1', person_id: RONALDO, user_id: PHILIP,  amount_cents: 5000 },
    { id: 'b2', person_id: RONALDO, user_id: PHILIP,  amount_cents: 5000 },
    { id: 'b3', person_id: RONALDO, user_id: SMALLER, amount_cents: 3500 },
    { id: 'b4', person_id: MESSI,   user_id: DANA,    amount_cents: 6900 }
  ],
  users: [
    { id: PHILIP,  display_name: 'Philip', photo_path: 'p/philip.jpg', social_handle: 'philip', social_platform: 'x' },
    { id: SMALLER, display_name: 'Smaller Backer', photo_path: null, social_handle: null, social_platform: null },
    { id: DANA,    display_name: 'Dana',   photo_path: null, social_handle: 'dana', social_platform: 'instagram' }
  ]
};

process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

const { default: handler } = await import('../api/top-fans.js');

async function call(query){
  let payload = null, status = 0;
  const res = {
    setHeader(){},
    status(code){ status = code; return res; },
    json(body){ payload = body; return res; },
    end(){}
  };
  await handler({ method: 'GET', url: '/api/top-fans', query }, res);
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(payload)}`);
  return payload;
}

// ── 1. The answer the page asks for ─────────────────────────────────────────
const out = await call({ ids: [RONALDO, MESSI, PELE].join(',') });

assert.ok(out.fans[RONALDO], 'Ronaldo has $135 of real bids — he must have a Greatest Fan');
assert.equal(out.fans[RONALDO].display_name, 'Philip', 'the biggest backer by summed bids, not the first row');
assert.equal(out.fans[RONALDO].total_cents, 10000, 'two $50 bids from one person are one $100 fan');
assert.equal(out.fans[RONALDO].photo_path, 'p/philip.jpg');
assert.equal(out.fans[RONALDO].social_handle, 'philip');

assert.equal(out.fans[MESSI].display_name, 'Dana', 'the cache still answers where it has a row');
assert.equal(out.fans[MESSI].total_cents, 6900);

assert.equal(out.fans[PELE], undefined, 'no backer means no fan, and the crown is the honest badge');

// ── 2. The diagnostic says which source answered ────────────────────────────
const diag = await call({});
const byName = Object.fromEntries(diag.contenders.map(c => [c.contender, c]));

assert.equal(byName['Cristiano Ronaldo'].from, 'bids', 'a stale cache has to be visible, not silently papered over');
assert.equal(byName['Cristiano Ronaldo'].greatest_fan, 'Philip');
assert.equal(byName['Cristiano Ronaldo'].fan_dollars, 100);
assert.equal(byName['Cristiano Ronaldo'].has_photo, true);
assert.equal(byName['Lionel Messi'].from, 'fan_totals');
assert.equal(byName['Pelé'].greatest_fan, 'NO BACKER AT ALL — the crown is correct');
assert.equal(byName['Pelé'].from, null);
assert.equal(diag.fan_totals_rows, 1);
assert.equal(diag.bid_rows, 4);

// ── 3. Junk in the query string reaches no query ────────────────────────────
const junk = await call({ ids: "'; drop table users; --,not-a-uuid" });
assert.deepEqual(junk.fans ?? {}, {}, 'non-uuid input is dropped, not passed to the database');

console.log('PASS — top fan resolved from bids when the cache is stale, from the cache when it is not');
