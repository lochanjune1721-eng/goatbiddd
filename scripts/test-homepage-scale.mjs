// scripts/test-homepage-scale.mjs — the badge at homepage scale.
//
//   node server.mjs &
//   BOARDS=400 node scripts/test-homepage-scale.mjs
//
// The two-contender test passes whatever the page does at scale, and that is
// how the homepage kept its empty crowns while every test was green. This
// builds the homepage as it really is — hundreds of boards, a thousand badges,
// and a handful of contenders carrying any money at all, which is the shape of
// the live data.
//
// What it pins down is that the cost does not grow with the page. The fans are
// read once, unfiltered, before anything renders. The previous design asked
// about every contender on the page by id and built a query string tens of
// thousands of characters long, and that is the class of bug this catches.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const BOARDS = Number(process.env.BOARDS || 200);
const uuid = (a, b) => `${String(a).padStart(8,'0')}-aaaa-4aaa-8aaa-${String(b).padStart(12,'0')}`;
const FAN = uuid(9, 900);

const cats = [], people = [], fanTotals = [];
for(let i = 0; i < BOARDS; i++){
  const cid = uuid(i + 1, 1);
  cats.push({ id: cid, slug: 'board-' + i, name: 'Board ' + i, group_name: 'Group ' + (i % 6), sort_order: i });
  for(let j = 0; j < 2; j++){
    const pid = uuid(i + 1, 100 + j);
    // Only the first board carries money, as on the live site.
    const cents = i === 0 ? (j === 0 ? 13500 : 6900) : 0;
    people.push({ id: pid, slug: `p-${i}-${j}`, category_id: cid, name: `Person ${i}-${j}`,
                  total_cents: cents, first_backed_at: cents ? '2026-01-01' : null, photo_path: null, blurb: '' });
    if(cents) fanTotals.push({ person_id: pid, user_id: FAN, total_cents: cents });
  }
}
const BACKED = people.filter(p => p.total_cents > 0).map(p => p.id);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

await page.addInitScript(({cats, people, fanTotals, FAN}) => {
  window.__reads = { fan_totals: 0, public_profiles: 0 };
  window.__idsAsked = 0;           // how many ids any query carried
  const rows = { categories: cats, people, fan_totals: fanTotals, bids: [],
                 public_profiles: [{ id: FAN, display_name: 'Alex', photo_path: null,
                                     social_handle: 'alex', social_platform: 'x' }],
                 site_stats: [{ visitor_count: 1 }] };
  const res = d => Promise.resolve({ data: d, error: null });
  function table(name){
    if(window.__reads[name] != null) window.__reads[name]++;
    if(name === 'users') return { select(){return this}, eq(){return this}, in(){return this},
      order(){return this}, limit(){return this},
      maybeSingle: () => Promise.resolve({ data:null, error:{ message:'permission denied for table users' } }),
      then: ok => ok({ data:null, error:{ message:'permission denied for table users' } }) };
    const api = { _rows: rows[name] || [] };
    for(const m of ['select','eq','order','limit','gte','lt','gt','neq','maybeSingle','single','not','filter','range','contains'])
      api[m] = () => api;
    api.in = (col, vals) => { window.__idsAsked = Math.max(window.__idsAsked, (vals||[]).length); return api; };
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
}, {cats, people, fanTotals, FAN});

await page.route('**/api/**', r => r.fulfill({ json: { ok: true } }));
await page.goto('http://127.0.0.1:3000/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);

const out = await page.evaluate(BACKED => {
  const all = [...document.querySelectorAll('.face-fan')];
  const backed = all.filter(el => {
    const t = el.getAttribute('title') || '';
    return /Greatest Fan of All Time:/.test(t);
  });
  return {
    duels: document.querySelectorAll('.duel-body').length,
    badges: all.length,
    filled: backed.length,
    sums: backed.map(el => el.querySelector('.face-fan-sum')?.textContent),
    reads: window.__reads,
    idsAsked: window.__idsAsked
  };
}, BACKED);

console.log(`${BOARDS} boards · ${out.duels} duels · ${out.badges} badges`);
console.log('fan_totals read', out.reads.fan_totals, 'time(s); largest id list in any query:', out.idsAsked);
console.log('badges showing a fan:', out.filled, out.sums.join(' '));
await browser.close();

assert.ok(out.badges > 100, `expected a badge on every contender, saw ${out.badges}`);
assert.ok(out.filled >= 2, `the two backed contenders should show a fan; ${out.filled} did`);
assert.ok(out.sums.includes('$135') && out.sums.includes('$69'), `wrong amounts: ${out.sums.join(', ')}`);

// The cost must not grow with the page. One read of the whole fan table, and no
// query carrying an id list anywhere near the size of the page — that list in
// the query string is what produced a 31,000-character URL before.
assert.equal(out.reads.fan_totals, 1, `fan_totals read ${out.reads.fan_totals} times — it should be read once`);
assert.ok(out.idsAsked < 100,
  `a query carried ${out.idsAsked} ids; ids travel in the query string, so this grows into a URL no server will accept`);

console.log('PASS — at homepage scale the fans cost one request, and the faces are there');
