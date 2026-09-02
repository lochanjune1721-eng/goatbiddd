// scripts/test-fan-badge.mjs — is the Greatest Fan's face in the frame?
//
//   node server.mjs &
//   node scripts/test-fan-badge.mjs
//
// The badge is drawn by duelHtml from GFOAT, which index.html loads once with
// the rest of the page: the whole of fan_totals in one unfiltered request, then
// the handful of profiles behind it. So these run the real index.html against a
// stubbed database and read what ends up in the corner of the card.
//
// users is refused throughout, exactly as the real policy refuses it, so the
// page can never quietly depend on reading it.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const MESSI='11111111-aaaa-4aaa-8aaa-000000000001', RONALDO='11111111-aaaa-4aaa-8aaa-000000000002';
const CAT='22222222-bbbb-4bbb-8bbb-000000000001';
const PHILIP='33333333-cccc-4ccc-8ccc-000000000001';
const FACE='data:image/svg+xml;utf8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#2b6"/><circle cx="20" cy="15" r="8" fill="#fff"/><rect x="8" y="26" width="24" height="20" rx="8" fill="#fff"/></svg>');

const browser = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium' });

async function badges({ fanTotals, publicProfiles }){
  const page = await browser.newPage({ viewport:{ width:1400, height:1000 } });
  const logs = [];
  page.on('console', m => logs.push(m.type()+': '+m.text()));

  await page.addInitScript(({MESSI,RONALDO,CAT,fanTotals,publicProfiles}) => {
    window.__reads = { fan_totals: 0, public_profiles: 0 };
    const rows = {
      categories:[{ id:CAT, slug:'greatest-footballer', name:'Greatest Footballer', group_name:'Sport', sort_order:1 }],
      people:[
        { id:MESSI,   slug:'lionel-messi', category_id:CAT, name:'Lionel Messi', total_cents:9800, first_backed_at:'2026-01-01', photo_path:null, blurb:'' },
        { id:RONALDO, slug:'cristiano-ronaldo', category_id:CAT, name:'Cristiano Ronaldo', total_cents:5000, first_backed_at:'2026-01-02', photo_path:null, blurb:'' }],
      fan_totals: fanTotals,
      public_profiles: publicProfiles || [],
      bids: [], site_stats:[{ visitor_count:1 }]
    };
    const res = d => Promise.resolve({ data:d, error:null });
    const refuse = msg => { const a = {};
      for(const m of ['select','eq','in','order','limit','gt','gte','lt','neq','not','filter','range','contains']) a[m] = () => a;
      a.maybeSingle = () => Promise.resolve({ data:null, error:{ message:msg } });
      a.then = ok => ok({ data:null, error:{ message:msg } });
      return a; };
    function table(name){
      if(window.__reads[name] != null) window.__reads[name]++;
      if(name === 'users') return refuse('permission denied for table users');
      // Absent means an error, not an empty list — that is what PostgREST says.
      if(name === 'public_profiles' && !publicProfiles) return refuse('relation "public_profiles" does not exist');
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
      channel: () => ({ on(){ return this; }, subscribe(){ return this; } }), removeChannel(){} }) };
  }, {MESSI,RONALDO,CAT,fanTotals,publicProfiles});

  await page.route('**/api/**', r => r.fulfill({ json:{ ok:true } }));
  await page.goto('http://127.0.0.1:3000/index.html', { waitUntil:'domcontentloaded' });
  await page.waitForTimeout(4000);

  const out = await page.evaluate(() => {
    const read = el => el && ({
      classes: el.className, href: el.getAttribute('href'), title: el.getAttribute('title'),
      hasImg: !!el.querySelector('img'),
      initials: el.querySelector('.face-fan-initials')?.textContent || null,
      sum: el.querySelector('.face-fan-sum')?.textContent || null
    });
    const all = [...document.querySelectorAll('.face-fan')];
    return {
      duels: document.querySelectorAll('.duel-body').length,
      badges: all.length,
      byPerson: Object.fromEntries(all.map(el => {
        const tile = el.closest('.duel-side');
        return [tile?.classList.contains('a') ? 'left' : 'right', read(el)];
      })),
      first: read(all[0]),
      crownButtons: [...document.querySelectorAll('[data-back-more]')].map(b => b.textContent.trim()).filter(t => t.startsWith('👑')),
      reads: window.__reads
    };
  });
  await page.close();
  return { out, logs: logs.filter(l => /gfoat/i.test(l)) };
}

// ── 1. A fan with a name, a picture and an account ──────────────────────────
{
  const { out } = await badges({
    fanTotals: [{ person_id: MESSI, user_id: PHILIP, total_cents: 9800 }],
    publicProfiles: [{ id: PHILIP, display_name:'Philip', photo_path: FACE, social_handle:'philip', social_platform:'x' }]
  });
  const b = out.first;
  assert.ok(out.badges >= 2, `a badge on every contender; saw ${out.badges}`);
  assert.equal(b.hasImg, true, "the fan's own picture is the badge");
  assert.equal(b.href, 'https://x.com/philip', "clicking it goes to the fan's account");
  assert.match(b.title, /Greatest Fan of All Time: Philip/);
  assert.equal(b.sum, '$98');
  assert.ok(!/\bnone\b/.test(b.classes), 'a contender with a fan must not show the unclaimed crown');
  assert.ok(out.crownButtons.some(t => t.includes('$99')), `the crown should be priced at $99; buttons said ${JSON.stringify(out.crownButtons)}`);
  assert.equal(out.reads.fan_totals, 1, 'the whole table is read once, not per contender');
  console.log('PASS 1/3 — the fan\'s picture is in the frame, linking to their account');
}

// ── 2. A fan the page cannot name — public_profiles was never installed ─────
{
  const { out } = await badges({
    fanTotals: [{ person_id: MESSI, user_id: PHILIP, total_cents: 9800 }],
    publicProfiles: null
  });
  const b = out.first;
  assert.ok(!/\bnone\b/.test(b.classes), 'the money is known even when the name is not');
  assert.equal(b.sum, '$98');
  assert.equal(b.initials, 'AB', 'initials stand in for a name that cannot be read');
  assert.equal(b.href, null, 'no handle, so it links nowhere rather than to the wrong person');
  console.log('PASS 2/3 — no readable profile: initials and the real amount, never a crown');
}

// ── 3. Nobody has backed them ───────────────────────────────────────────────
{
  const { out } = await badges({ fanTotals: [], publicProfiles: [] });
  const b = out.first;
  assert.ok(/\bnone\b/.test(b.classes), 'no backer means the unclaimed crown, which is the honest badge');
  assert.equal(b.sum, '$1 · be first');
  assert.equal(b.initials, '👑');
  console.log('PASS 3/3 — no backer: the crown, offered at a dollar');
}

await browser.close();
console.log('PASS — the Greatest Fan is drawn into the card');
