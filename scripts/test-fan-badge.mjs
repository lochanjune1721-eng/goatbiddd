// scripts/test-fan-badge.mjs — does the Greatest Fan's face reach the frame?
//
//   node server.mjs &            # serves the repo at :3000
//   node scripts/test-fan-badge.mjs
//
// Loads the real index.html with the database stubbed to one situation: a board
// with Messi and Ronaldo on it, and Messi backed hardest by Philip, who has a
// picture and an X handle. Then it reads the badge in the corner of the frame
// and says what is in it.
//
// top_fans is stubbed to return nothing on purpose, so this exercises the
// fallback that reads fan_totals directly — the path a project that has never
// run supabase-top-fans.sql is on.
//
// It exists because "the face is not showing" was asked and answered four times
// from screenshots, and a screenshot cannot tell a broken page from an empty
// table. This can.
import { chromium } from 'playwright-core';
const MESSI='11111111-aaaa-4aaa-8aaa-000000000001', RONALDO='11111111-aaaa-4aaa-8aaa-000000000002';
const CAT='22222222-bbbb-4bbb-8bbb-000000000001';
const PHILIP='33333333-cccc-4ccc-8ccc-000000000001';
const FACE='data:image/svg+xml;utf8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#2b6"/><circle cx="20" cy="15" r="8" fill="#fff"/><rect x="8" y="26" width="24" height="20" rx="8" fill="#fff"/></svg>');

const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport:{width:1400,height:1000} });
const logs=[]; p.on('console', m => logs.push(m.type()+': '+m.text()));

// Stub the database before any of the site's scripts run.
await p.addInitScript(({MESSI,RONALDO,CAT,PHILIP,FACE}) => {
  const rows = {
    categories: [{ id:CAT, slug:'greatest-footballer', name:'Greatest Footballer', group_name:'Sport', sort_order:1 }],
    people: [
      { id:MESSI,   slug:'lionel-messi', category_id:CAT, name:'Lionel Messi',      total_cents:9800, first_backed_at:'2026-01-01', photo_path:null, blurb:'' },
      { id:RONALDO, slug:'cristiano-ronaldo', category_id:CAT, name:'Cristiano Ronaldo', total_cents:5000, first_backed_at:'2026-01-02', photo_path:null, blurb:'' }],
    fan_totals: [
      { person_id:MESSI, user_id:PHILIP, total_cents:9800,
        users:{ display_name:'Philip', is_anonymous:false, photo_path:FACE, social_handle:'philip', social_platform:'x' } }],
    bids: [], site_stats: [{ visitor_count: 1 }]
  };
  const res = data => Promise.resolve({ data, error:null });
  function table(name){
    const api = { _rows: rows[name] || [] };
    for (const m of ['select','eq','in','order','limit','gte','lt','gt','neq','maybeSingle','single','not','filter','range','contains'])
      api[m] = () => api;
    api.then = (ok) => ok({ data: api._rows, error: null });
    api.maybeSingle = () => res((rows[name]||[])[0] || null);
    return api;
  }
  const client = {
    from: table,
    rpc: (fn) => { if(fn==='top_fans') return res(null); return res(null); },   // pretend it was never installed
    auth: { getUser: () => Promise.resolve({ data:{ user:null } }),
            getSession: () => Promise.resolve({ data:{ session:null } }),
            onAuthStateChange: () => ({ data:{ subscription:{ unsubscribe(){} } } }),
            signOut: () => Promise.resolve({}) },
    channel: () => ({ on(){ return this; }, subscribe(){ return this; } }),
    removeChannel(){}
  };
  window.supabase = { createClient: () => client };
}, {MESSI,RONALDO,CAT,PHILIP,FACE});

await p.route('**/api/fans*', r => r.fulfill({ json:{ ok:true, fans:[] } }));
await p.route('**/api/**',   r => r.fulfill({ json:{ ok:true } }));
await p.goto('http://127.0.0.1:3000/index.html', { waitUntil:'domcontentloaded' });
await p.waitForTimeout(7000);

const out = await p.evaluate(() => {
  const f = document.querySelector('.face-fan');
  if(!f) return { found:false, duels: document.querySelectorAll('.duel-body').length };
  return { found:true, duels: document.querySelectorAll('.duel-body').length,
    classes:f.className, html:f.innerHTML.slice(0,220), href:f.getAttribute('href'),
    hasImg: !!f.querySelector('img'), title:f.getAttribute('title'),
    done:f.dataset.gfoatDone, tries:f.dataset.gfoatTries };
});
console.log(JSON.stringify(out,null,1));
const pass = out.found && out.hasImg && out.href === 'https://x.com/philip';
console.log(pass
  ? 'PASS — the top backer\'s picture is on the contender, linking to their social'
  : 'FAIL — the badge did not receive the fan');
const noise = logs.filter(l => /gfoat/i.test(l));
if(noise.length){ console.log('--- badge log ---'); noise.forEach(l => console.log('  '+l)); }
await b.close();
process.exit(pass ? 0 : 1);
