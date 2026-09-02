// scripts/test-homepage-scale.mjs — the badge at homepage scale.
//
//   node server.mjs &
//   node scripts/test-homepage-scale.mjs
//
// scripts/test-fan-badge.mjs renders two contenders in one category and passes.
// The live homepage renders a hundred boards at once, and there the same badge
// stayed empty on contenders that /why proved have a nameable fan. So this
// builds the homepage as it really is: many boards, almost all of them on $0
// with no fan, and a handful carrying real money — the same shape the live
// database has.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const BOARDS = Number(process.env.BOARDS || 60);   // boards on the page
const uuid = (a, b) => `${String(a).padStart(8,'0')}-aaaa-4aaa-8aaa-${String(b).padStart(12,'0')}`;

const cats = [], people = [], fanTotals = [], apiFans = {};
for(let i = 0; i < BOARDS; i++){
  const cid = uuid(i + 1, 1);
  cats.push({ id: cid, slug: 'board-' + i, name: 'Board ' + i, group_name: 'Group ' + (i % 6), sort_order: i });
  for(let j = 0; j < 2; j++){
    const pid = uuid(i + 1, 100 + j);
    // Only the first board carries money — exactly like the live data, where
    // seven contenders out of thousands have anything on them.
    const cents = i === 0 ? (j === 0 ? 13500 : 6900) : 0;
    people.push({ id: pid, slug: `p-${i}-${j}`, category_id: cid, name: `Person ${i}-${j}`,
                  total_cents: cents, first_backed_at: cents ? '2026-01-01' : null, photo_path: null, blurb: '' });
    if(cents){
      const uid = uuid(9, 900 + j);
      fanTotals.push({ person_id: pid, user_id: uid, total_cents: cents });
      apiFans[pid] = { user_id: uid, total_cents: cents, display_name: j === 0 ? 'Alex' : 'Philip',
                       photo_path: null, social_handle: j === 0 ? 'alex' : 'philip', social_platform: 'x' };
    }
  }
}
const BACKED = people.filter(p => p.total_cents > 0).map(p => p.id);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const logs = [];
page.on('console', m => logs.push(m.type() + ': ' + m.text()));

await page.addInitScript(({cats, people, fanTotals}) => {
  const rows = { categories: cats, people, fan_totals: fanTotals, bids: [],
                 public_profiles: [], site_stats: [{ visitor_count: 1 }] };
  const res = data => Promise.resolve({ data, error: null });
  function table(name){
    if(name === 'users') return { select(){return this}, eq(){return this}, in(){return this},
      order(){return this}, limit(){return this},
      maybeSingle: () => Promise.resolve({ data:null, error:{ message:'permission denied for table users' } }),
      then: ok => ok({ data:null, error:{ message:'permission denied for table users' } }) };
    const api = { _rows: rows[name] || [] };
    for(const m of ['select','eq','in','order','limit','gte','lt','gt','neq','maybeSingle','single','not','filter','range','contains'])
      api[m] = () => api;
    api.then = ok => ok({ data: api._rows, error: null });
    api.maybeSingle = () => res((rows[name] || [])[0] || null);
    return api;
  }
  window.supabase = { createClient: () => ({
    from: table, rpc: () => res(null),
    auth: { getUser: () => Promise.resolve({ data:{ user:null } }),
            getSession: () => Promise.resolve({ data:{ session:null } }),
            onAuthStateChange: () => ({ data:{ subscription:{ unsubscribe(){} } } }),
            signOut: () => Promise.resolve({}) },
    channel: () => ({ on(){return this}, subscribe(){return this} }), removeChannel(){} }) };
}, {cats, people, fanTotals});

// Record what the page actually asks the endpoint for — how many ids, how long
// the URL is, how many times it asks. That is where scale bites.
const calls = [];
await page.route('**/api/**',    r => r.fulfill({ json:{ ok:true } }));
await page.route('**/api/fans*', r => r.fulfill({ json:{ ok:true, fans:[] } }));
await page.route('**/api/top-fans*', r => {
  const u = new URL(r.request().url());
  const asked = (u.searchParams.get('ids') || '').split(',').filter(Boolean);
  calls.push({ urlLength: u.href.length, asked: asked.length });
  const fans = {};
  for(const id of asked) if(apiFans[id]) fans[id] = apiFans[id];
  r.fulfill({ json: { ok: true, fans } });
});

await page.goto('http://127.0.0.1:3000/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(9000);

const out = await page.evaluate(BACKED => {
  const all = [...document.querySelectorAll('.face-fan[data-face-fan]')];
  const read = el => ({
    person: el.dataset.faceFan,
    empty: /\bnone\b/.test(el.className),
    sum: el.querySelector('.face-fan-sum')?.textContent || null,
    initials: el.querySelector('.face-fan-initials')?.textContent || null,
    tries: el.dataset.gfoatTries || null,
    done: el.dataset.gfoatDone || null
  });
  return {
    duels: document.querySelectorAll('.duel-body').length,
    badges: all.length,
    backedOnPage: all.filter(el => BACKED.includes(el.dataset.faceFan)).map(read)
  };
}, BACKED);

console.log('duels on page:', out.duels, '| badges:', out.badges);
console.log('calls to /api/top-fans:', calls.length,
  calls.map(c => `${c.asked} ids / ${c.urlLength} chars`).join('  ·  ') || '(none)');
console.log('badges for the contenders that HAVE a fan:');
for(const b of out.backedOnPage) console.log('  ', JSON.stringify(b));

const noise = logs.filter(l => /gfoat/i.test(l));
if(noise.length){ console.log('--- badge log ---'); noise.slice(0, 8).forEach(l => console.log('  ' + l)); }

await browser.close();

// The bug this test was written for. Ids travel in the query string, and asking
// about every contender at once built a 31,000-character URL — which Cloudflare
// refuses, so every fan lookup on the homepage failed while the same code inside
// one board, asking about a handful, worked. A stub happily answers a URL that
// long, so only this assertion catches it.
assert.ok(calls.length > 0, 'the page never asked for any fans');
for(const c of calls){
  assert.ok(c.urlLength < 4096,
    `a request URL of ${c.urlLength} chars (${c.asked} ids) — real infrastructure refuses this; ask in batches`);
}

assert.ok(out.badges > 50, `expected a badge on every contender, saw ${out.badges}`);
assert.ok(out.backedOnPage.length, 'the backed contenders never rendered on the homepage');
for(const b of out.backedOnPage){
  assert.equal(b.empty, false,
    `contender ${b.person} has a fan but the badge still shows the unclaimed crown (tries=${b.tries}, done=${b.done})`);
  assert.notEqual(b.sum, '$1 · be first');
}
console.log('PASS — at homepage scale, every contender with a fan shows one');
