// scripts/test-fan-badge.mjs — does the Greatest Fan's face reach the frame?
//
//   node server.mjs &            # serves the repo at :3000
//   node scripts/test-fan-badge.mjs
//
// Loads the real index.html against a stubbed database and reads the badge in
// the corner of the contender's frame. It exists because "the face is not
// showing" was asked and answered four times from screenshots, and a screenshot
// cannot tell a broken page from an empty table. This can.
//
// Two scenarios, because the badge has two ways to find a fan and both have
// failed in production:
//
//   1. The server answers. /api/top-fans runs with the service key and returns
//      the fan whole — name, picture, handle. users is refused throughout, as it
//      really is, so the page can never depend on reading it.
//
//   2. The server does not answer, and the cache is empty. /api/top-fans is
//      down, top_fans was never installed, public_profiles does not exist, and
//      fan_totals holds nothing — but bids do. This is the live failure: bids
//      is the record and fan_totals only a cache of it, and anything that
//      recomputes totals outside place_bid leaves the cache behind. A contender
//      showed $135 wearing an unclaimed crown. The badge has to fall back to
//      the record and show the money, even when it cannot learn the name.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const MESSI='11111111-aaaa-4aaa-8aaa-000000000001', RONALDO='11111111-aaaa-4aaa-8aaa-000000000002';
const CAT='22222222-bbbb-4bbb-8bbb-000000000001';
const PHILIP='33333333-cccc-4ccc-8ccc-000000000001';
const SMALLER='33333333-cccc-4ccc-8ccc-000000000002';
const FACE='data:image/svg+xml;utf8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#2b6"/><circle cx="20" cy="15" r="8" fill="#fff"/><rect x="8" y="26" width="24" height="20" rx="8" fill="#fff"/></svg>');

const browser = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium' });

async function readBadges({ apiFans, fanTotals, bids, publicProfiles }){
  const page = await browser.newPage({ viewport:{width:1400,height:1000} });
  const logs = [];
  page.on('console', m => logs.push(m.type()+': '+m.text()));

  // Stub the database before any of the site's scripts run.
  await page.addInitScript(({MESSI,RONALDO,CAT,fanTotals,bids,publicProfiles}) => {
    const rows = {
      categories: [{ id:CAT, slug:'greatest-footballer', name:'Greatest Footballer', group_name:'Sport', sort_order:1 }],
      people: [
        { id:MESSI,   slug:'lionel-messi', category_id:CAT, name:'Lionel Messi',      total_cents:9800, first_backed_at:'2026-01-01', photo_path:null, blurb:'' },
        { id:RONALDO, slug:'cristiano-ronaldo', category_id:CAT, name:'Cristiano Ronaldo', total_cents:5000, first_backed_at:'2026-01-02', photo_path:null, blurb:'' }],
      fan_totals: fanTotals,
      public_profiles: publicProfiles,
      bids,
      site_stats: [{ visitor_count: 1 }]
    };
    const res = data => Promise.resolve({ data, error:null });
    function table(name){
      // users is self-read only on the real database: any read of it is refused.
      // The page must never depend on one.
      if(name === 'users') return { select(){ return this; }, eq(){ return this; },
        in(){ return this; }, order(){ return this; }, limit(){ return this; },
        maybeSingle: () => Promise.resolve({ data:null, error:{ message:'permission denied for table users' } }),
        then: (ok) => ok({ data:null, error:{ message:'permission denied for table users' } }) };
      // public_profiles is absent unless the scenario installs it, and absent
      // means an error rather than an empty list — that is what PostgREST says.
      if(name === 'public_profiles' && !publicProfiles) return { select(){ return this; }, eq(){ return this; },
        in(){ return this; }, order(){ return this; }, limit(){ return this; },
        then: (ok) => ok({ data:null, error:{ message:'relation "public_profiles" does not exist' } }) };
      const api = { _rows: rows[name] || [] };
      for (const m of ['select','eq','in','order','limit','gte','lt','gt','neq','maybeSingle','single','not','filter','range','contains'])
        api[m] = () => api;
      api.then = (ok) => ok({ data: api._rows, error: null });
      api.maybeSingle = () => res((rows[name]||[])[0] || null);
      return api;
    }
    const client = {
      from: table,
      rpc: () => res(null),   // top_fans: pretend it was never installed
      auth: { getUser: () => Promise.resolve({ data:{ user:null } }),
              getSession: () => Promise.resolve({ data:{ session:null } }),
              onAuthStateChange: () => ({ data:{ subscription:{ unsubscribe(){} } } }),
              signOut: () => Promise.resolve({}) },
      channel: () => ({ on(){ return this; }, subscribe(){ return this; } }),
      removeChannel(){}
    };
    window.supabase = { createClient: () => client };
  }, {MESSI,RONALDO,CAT,fanTotals,bids,publicProfiles});

  // Playwright gives precedence to the LAST route registered, so the catch-all
  // goes first and the specific ones after it.
  await page.route('**/api/**',    r => r.fulfill({ json:{ ok:true } }));
  await page.route('**/api/fans*', r => r.fulfill({ json:{ ok:true, fans:[] } }));
  await page.route('**/api/top-fans*', r => apiFans
    ? r.fulfill({ json:{ ok:true, fans: apiFans } })
    : r.fulfill({ status:500, json:{ error:'Missing environment variable(s): SUPABASE_SERVICE_ROLE_KEY' } }));

  await page.goto('http://127.0.0.1:3000/index.html', { waitUntil:'domcontentloaded' });
  await page.waitForTimeout(7000);

  const out = await page.evaluate(() => {
    const read = el => el && ({
      classes: el.className,
      href: el.getAttribute('href'),
      title: el.getAttribute('title'),
      hasImg: !!el.querySelector('img'),
      initials: el.querySelector('.face-fan-initials')?.textContent || null,
      sum: el.querySelector('.face-fan-sum')?.textContent || null
    });
    const all = [...document.querySelectorAll('.face-fan[data-face-fan]')];
    return {
      duels: document.querySelectorAll('.duel-body').length,
      badges: all.length,
      byPerson: Object.fromEntries(all.map(el => [el.dataset.faceFan, read(el)]))
    };
  });
  await page.close();
  return { out, logs: logs.filter(l => /gfoat/i.test(l)) };
}

// ── 1. The server answers ───────────────────────────────────────────────────
{
  const { out } = await readBadges({
    apiFans: { [MESSI]: { user_id:PHILIP, total_cents:9800, display_name:'Philip',
                          photo_path:FACE, social_handle:'philip', social_platform:'x' } },
    fanTotals: [], bids: [], publicProfiles: []
  });
  const messi = out.byPerson[MESSI];
  assert.ok(out.badges >= 2, `expected a badge per contender, saw ${out.badges}`);
  assert.ok(messi, 'no badge rendered for Messi');
  assert.equal(messi.hasImg, true, "the fan's picture is the badge");
  assert.equal(messi.href, 'https://x.com/philip', "clicking it goes to the fan's own social account");
  assert.match(messi.title, /Greatest Fan of All Time: Philip/);
  assert.equal(messi.sum, '$98');
  assert.ok(!/\bnone\b/.test(messi.classes), 'a contender with a fan must not show the unclaimed crown');
  console.log("PASS 1/2 — server answers: the top backer's picture is on the contender, linking to their social");
}

// ── 2. No server, no cache — only the record ────────────────────────────────
{
  const { out, logs } = await readBadges({
    apiFans: null,          // /api/top-fans is 500
    fanTotals: [],          // the cache has nothing, as it did live
    publicProfiles: null,   // supabase-public-profiles.sql never run
    bids: [                 // …but the bids are there, and they are public
      { person_id: MESSI,   user_id: PHILIP,  amount_cents: 5000 },
      { person_id: MESSI,   user_id: PHILIP,  amount_cents: 4800 },
      { person_id: MESSI,   user_id: SMALLER, amount_cents: 1000 },
      { person_id: RONALDO, user_id: SMALLER, amount_cents: 5000 }
    ]
  });
  const messi = out.byPerson[MESSI], ronaldo = out.byPerson[RONALDO];
  assert.ok(messi && ronaldo, 'both contenders need a badge');
  assert.ok(!/\bnone\b/.test(messi.classes),
    'Messi has $98 of bids — the badge must not say "$1 · be first"');
  assert.equal(messi.sum, '$98', 'two bids from one backer are one $98 fan, not the largest single bid');
  assert.equal(ronaldo.sum, '$50');
  assert.equal(messi.initials, 'AB', 'no readable name, so the badge shows initials rather than a crown');
  assert.equal(messi.hasImg, false);
  assert.equal(messi.href, null, 'no handle to link to, so it links nowhere rather than to the wrong person');
  console.log('PASS 2/2 — no endpoint and an empty cache: the badge still reads the money off the bids');
  if(logs.length){ console.log('--- badge log ---'); logs.forEach(l => console.log('  '+l)); }
}

await browser.close();
console.log('PASS — the Greatest Fan reaches the frame from the server and from the record');
