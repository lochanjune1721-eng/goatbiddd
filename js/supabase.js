// js/supabase.js — The True GOAT Auth, Balance & Supabase Client
const SUPABASE_URL = "https://orzcszqpnvicreqvpncu.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9yemNzenFwbnZpY3JlcXZwbmN1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc2NDIwNDIsImV4cCI6MjEwMzIxODA0Mn0.ayMlWauR_XCT2lWV_Pg2PZTq_CuTS-bch8KdoxslvIs";
window.SUPABASE_URL = SUPABASE_URL;
window.SUPABASE_ANON_KEY = SUPABASE_ANON_KEY;

// The apex. www.thetruegoat.com has no DNS record, so a magic link built
// against it lands the signer on a browser error instead of their session.
// Only reached when the page is served from localhost — in production the real
// origin below wins — but that is exactly when someone is testing sign-in.
const PRODUCTION_DOMAIN = "https://thetruegoat.com";

function getSiteUrl(){
  try {
    const o = window.location.origin;
    if(o && !o.includes('localhost') && !o.includes('127.0.0.1') && !o.includes('0.0.0.0')) return o;
  } catch(e){}
  return PRODUCTION_DOMAIN;
}
window.getSiteUrl = getSiteUrl;

try {
  window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
} catch (e) {
  console.warn('Supabase client unavailable — running without live data', e);
  const noop = () => stub;
  const stub = { select:noop, order:noop, eq:noop, in:noop, gte:noop, lt:noop,
    limit:noop, range:noop, insert:noop, update:noop,
    maybeSingle: () => Promise.resolve({ data:null, error:null }),
    then: r => r({ data: [], error: null }) };
  window.supabaseClient = {
    from: () => stub,
    rpc: () => Promise.resolve({ data:null, error:{ message:'offline' } }),
    auth: { getUser: () => Promise.resolve({ data:{ user:null } }),
            onAuthStateChange: () => ({ data:{ subscription:{unsubscribe:()=>{}} } }), signOut: () => Promise.resolve({}),
            signInWithOtp: () => Promise.resolve({ error:null }), signInWithOAuth: () => Promise.resolve({ error:null }) },
    channel: () => ({ on(){ return this; }, subscribe(){ return this; } }),
    storage: { from: () => ({ upload: () => Promise.resolve({ error:{message:'offline'}}), getPublicUrl: ()=>({data:{publicUrl:''}}) }) }
  };
}

// Money totals tick rather than snap, so a live change is noticed. Counts up
// from whatever is on screen to the new figure; the element is the source of
// truth for the start value, so two rapid changes chain instead of fighting.
window.tickMoney = function(el, toCents, ms){
  if(!el) return;
  const parse = t => { const n = Number(String(t||'').replace(/[^0-9]/g,'')); return Number.isFinite(n)?n:0; };
  const from = parse(el.textContent), to = Math.floor((toCents||0)/100);
  const fmt = v => '$' + Math.round(v).toLocaleString('en-US');
  if(from === to){ el.textContent = fmt(to); return; }
  el.classList.add('goat-ticking');
  setTimeout(()=> el.classList.remove('goat-ticking'), 360);
  const dur = ms || 520, t0 = performance.now();
  (function step(now){
    const k = Math.min(1, (now - t0) / dur);
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(from + (to - from) * eased);
    if(k < 1) requestAnimationFrame(step);
  })(t0);
};

// One toast, so every surface confirms a backing the same way: what you put
// down, and what it did to the gap. "Voted!" tells you nothing you did not
// already know; the gap is the thing that moved.
window.goatToast = function(html, ms){
  document.getElementById('goat-toast')?.remove();
  const el = document.createElement('div');
  el.id = 'goat-toast';
  el.className = 'goat-toast';
  el.innerHTML = html;
  document.body.appendChild(el);
  requestAnimationFrame(()=> el.classList.add('in'));
  setTimeout(()=>{ el.classList.remove('in'); setTimeout(()=> el.remove(), 260); }, ms || 3800);
};

// "You put $5 behind Messi. Gap is now $33." Built here so the wording cannot
// drift between the home board, a category board and a person's page.
window.backedMessage = function(name, spentCents, myCents, rivalCents, rivalName){
  const money = c => '$' + Math.floor((c||0)/100).toLocaleString('en-US');
  const put = `You put <b>${money(spentCents)}</b> behind ${name}.`;
  if(rivalCents == null) return put;
  const diff = Math.floor((myCents||0)/100) - Math.floor((rivalCents||0)/100);
  if(diff === 0) return `${put} Dead level with ${rivalName||'the leader'}.`;
  if(diff > 0)  return `${put} Now <b>${money(diff*100)}</b> ahead.`;
  return `${put} Gap is now <b>${money(-diff*100)}</b>.`;
};

window.GOAT = {
  SUPABASE_URL,
  getPhotoUrl: (path) => {
    if(!path || typeof path !== 'string') return null;
    const trimmed = path.trim();
    if(!trimmed) return null;
    if(trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('data:')) {
      return trimmed;
    }
    const cleanPath = trimmed.replace(/^\/+/, '');
    return `${SUPABASE_URL}/storage/v1/object/public/people/${cleanPath}`;
  },
  getVideoUrl: (path) => {
    if(!path || typeof path !== 'string') return null;
    const trimmed = path.trim();
    if(!trimmed) return null;
    if(trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('data:')) return trimmed;
    return `${SUPABASE_URL}/storage/v1/object/public/people/${trimmed.replace(/^\/+/, '')}`;
  },
  // ── The scoreboard speaks in dollars ──────────────────────────────────────
  //
  // $1 of credit buys one vote and always has; nothing below changes that. What
  // changes is what the board SAYS. "472 votes" reads like a free poll —
  // clicks, which cost nothing and mean nothing. "$472" is the same fact and
  // the only one worth putting on a scoreboard: it is what people actually put
  // down.
  //
  // Whole dollars, no cents: the product cannot produce a fractional vote, so a
  // decimal place would only ever be ".00". Separators from four digits up,
  // which toLocaleString already does.
  money: (c)=> `$${Math.floor((c||0)/100).toLocaleString('en-US')}`,
  moneyShort: (c)=> `$${Math.floor((c||0)/100).toLocaleString('en-US')}`,
  // The gap between two contenders, in dollars. On a fight card this is the
  // number that matters — it is the price of taking the lead.
  moneyGap: (c1,c2)=> `$${Math.abs(Math.floor((c1||0)/100)-Math.floor((c2||0)/100)).toLocaleString('en-US')}`,
  // Private surfaces only — a fan's own wallet and history, where the vote
  // count is a real thing they hold rather than a score being advertised.
  moneyAndVotes: (c)=> {
    const v = Math.floor((c||0)/100);
    return `$${v.toLocaleString('en-US')} · ${v.toLocaleString('en-US')} vote${v===1?'':'s'}`;
  },

  cents: (c)=> `$${Math.floor((c||0)/100).toLocaleString('en-US')}`,
  // Legacy name. Every caller is a public surface, so it renders money now
  // rather than being chased through a dozen templates; new code should say
  // money() and mean it.
  votes: (c)=> `$${Math.floor((c||0)/100).toLocaleString('en-US')}`,
  votesShort: (c)=> `${Math.floor((c||0)/100).toLocaleString('en-US')}`,
  votesGap: (c1,c2)=> Math.abs(Math.floor((c1||0)/100)-Math.floor((c2||0)/100)),
  fmtAgo: (iso)=>{
    if(!iso) return "—";
    const s=Math.floor((Date.now()-new Date(iso).getTime())/1000);
    if(s<60) return `${s}s ago`;
    const m=Math.floor(s/60); if(m<60) return `${m} min ago`;
    const h=Math.floor(m/60); if(h<24) return `${h}h ago`;
    const d=Math.floor(h/24); return `${d}d ago`;
  },
  qs: (k)=> new URLSearchParams(location.search).get(k),
  initials: (name)=> {
    if(!name) return '?';
    const parts = name.trim().split(/\s+/);
    if(parts.length === 1) return parts[0].slice(0,2).toUpperCase();
    return (parts[0][0] + parts[parts.length-1][0]).toUpperCase();
  }
};

async function ensureUserRow(){
  const {data:{user}}=await window.supabaseClient.auth.getUser();
  if(!user) return null;
  let {data}=await window.supabaseClient.from('users').select('*').eq('id', user.id).maybeSingle();
  if(!data){
    const display = user.user_metadata?.display_name || user.user_metadata?.full_name || (user.email ? user.email.split('@')[0] : 'Fan');
    const anon = !!user.user_metadata?.is_anonymous;
    // The country was chosen before the magic link was sent, so it arrives in
    // the auth metadata rather than in this session.
    let country = user.user_metadata?.country || null;
    if(!country){ try { country = localStorage.getItem('goat_country'); } catch(e){} }
    if(!/^[A-Z]{2}$/.test(String(country||''))) country = null;
    const {data: ins}=await window.supabaseClient.from('users')
      .insert({id:user.id, email:user.email, display_name: display, is_anonymous: anon, country})
      .select('*').maybeSingle();
    data=ins;
  }
  // Signed up before we asked, or signed in with Google, which carries no
  // country: fill it from the choice made on this device rather than leaving
  // the account unable to pay.
  if(data && !data.country){
    let pending = null;
    try { pending = localStorage.getItem('goat_country'); } catch(e){}
    if(/^[A-Z]{2}$/.test(String(pending||''))){
      await window.supabaseClient.from('users').update({ country: pending }).eq('id', data.id);
      data.country = pending;
    }
  }
  return data;
}

// ── Country ──────────────────────────────────────────────────────────────────
// Asked at sign-in because it decides which payment rail a fan is offered, and
// a guess from their IP is wrong for anyone travelling or on a VPN — and can
// differ between two clicks of the same checkout.
window.GOAT_COUNTRIES = [
  ['IN','India'],['US','United States'],['GB','United Kingdom'],['CA','Canada'],
  ['AU','Australia'],['AE','United Arab Emirates'],['SG','Singapore'],['DE','Germany'],
  ['FR','France'],['ES','Spain'],['IT','Italy'],['NL','Netherlands'],['IE','Ireland'],
  ['PT','Portugal'],['BR','Brazil'],['MX','Mexico'],['AR','Argentina'],['ZA','South Africa'],
  ['NG','Nigeria'],['KE','Kenya'],['EG','Egypt'],['SA','Saudi Arabia'],['QA','Qatar'],
  ['PK','Pakistan'],['BD','Bangladesh'],['LK','Sri Lanka'],['NP','Nepal'],['ID','Indonesia'],
  ['MY','Malaysia'],['PH','Philippines'],['TH','Thailand'],['VN','Vietnam'],['JP','Japan'],
  ['KR','South Korea'],['CN','China'],['NZ','New Zealand'],['SE','Sweden'],['NO','Norway'],
  ['DK','Denmark'],['FI','Finland'],['PL','Poland'],['CH','Switzerland'],['AT','Austria'],
  ['BE','Belgium'],['TR','Turkey'],['IL','Israel'],['RU','Russia'],['UA','Ukraine']
];
window.countryOptions = function(selected){
  return '<option value="">Select your country…</option>' + window.GOAT_COUNTRIES
    .map(([code,name]) => '<option value="'+code+'"'+(code===selected?' selected':'')+'>'+name+'</option>')
    .join('');
};
// Only ever a hint for the dropdown's initial value — never what we store.
window.guessCountry = async function(){
  try {
    const h = await fetch('/api/health').then(r=>r.json());
    return h?.country || null;
  } catch(e){ return null; }
};
window.saveCountry = async function(code){
  const c = String(code||'').trim().toUpperCase();
  if(!/^[A-Z]{2}$/.test(c)) return null;
  const {data:{user}} = await window.supabaseClient.auth.getUser();
  if(!user) return null;
  await window.supabaseClient.from('users').update({ country: c }).eq('id', user.id);
  try { localStorage.setItem('goat_country', c); } catch(e){}
  return c;
};

window.ensureUserRow=ensureUserRow;

// Auth helpers — real sign-in (email magic link + Google OAuth), return-to-where-you-were
window.Auth = {
  getReturnTo(){
    try {
      const rt = new URLSearchParams(location.search).get('returnTo') || sessionStorage.getItem('goat_returnTo');
      if(rt && rt.startsWith('/') && !rt.includes('localhost')) return rt;
    } catch(e){}
    return null;
  },
  rememberReturnTo(){
    try {
      const cur = location.pathname + location.search;
      if(cur !== '/wallet' && !cur.includes('/wallet')) sessionStorage.setItem('goat_returnTo', cur);
    } catch(e){}
  },
  async signInWithEmail(email, displayName, isAnon, country){
    window.Auth.rememberReturnTo();
    const returnTo = window.Auth.getReturnTo();
    const redirect = getSiteUrl() + '/wallet' + (returnTo ? '?returnTo='+encodeURIComponent(returnTo) : '');
    return window.supabaseClient.auth.signInWithOtp({
      email,
      options:{ data:{ display_name: displayName||email.split('@')[0], is_anonymous: !!isAnon,
                       country: /^[A-Z]{2}$/.test(String(country||'')) ? country : null },
                emailRedirectTo: redirect }
    });
  },
  async signInWithGoogle(){
    window.Auth.rememberReturnTo();
    const returnTo = window.Auth.getReturnTo();
    const redirect = getSiteUrl() + '/wallet' + (returnTo ? '?returnTo='+encodeURIComponent(returnTo) : '');
    return window.supabaseClient.auth.signInWithOAuth({ provider:'google', options:{ redirectTo: redirect } });
  },
  openAuthModal(){
    const existing = document.getElementById('auth-modal');
    if(existing) { existing.style.display='flex'; return; }

    window.Auth.rememberReturnTo();
    const modal = document.createElement('div');
    modal.id = 'auth-modal';
    modal.className = 'inline-topup';
    modal.innerHTML = `
      <div class="inline-topup-card" style="max-width:380px;text-align:left;position:relative">
        <button id="modal-close-btn" style="position:absolute;right:14px;top:14px;background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer">✕</button>
        <h2 class="display" style="font-size:22px;margin-bottom:6px">Sign in to The True GOAT</h2>
        <p class="mono" style="font-size:12px;color:var(--muted);margin-bottom:14px">Back your GOAT with one tap. $1 = 1 vote — the score is real money.</p>
        <button id="modal-google-btn" class="btn-primary" style="background:#fff;color:#111;border:1px solid var(--border);display:flex;align-items:center;gap:8px;justify-content:center;width:100%;font-weight:700">
          <span style="font-size:16px">G</span> Continue with Google
        </button>
        <div class="mono" style="text-align:center;color:var(--muted);font-size:11px;margin:12px 0">— or email magic link —</div>
        <div class="field" style="margin-bottom:8px">
          <label style="font-size:11px;text-transform:uppercase;color:var(--muted)">Country</label>
          <select id="modal-country"></select>
        </div>
        <div class="field" style="margin-bottom:8px">
          <label style="font-size:11px;text-transform:uppercase;color:var(--muted)">Email</label>
          <input id="modal-email" type="email" placeholder="you@example.com" style="width:100%;height:38px;border-radius:999px;border:1px solid var(--border);background:var(--bg);color:var(--ink);padding:0 12px;font-size:13px">
        </div>
        <div class="field" style="margin-bottom:8px">
          <label style="font-size:11px;text-transform:uppercase;color:var(--muted)">Display name</label>
          <input id="modal-name" placeholder="e.g. Alex" style="width:100%;height:38px;border-radius:999px;border:1px solid var(--border);background:var(--bg);color:var(--ink);padding:0 12px;font-size:13px">
        </div>
        <button id="modal-send-link" class="btn-primary" style="width:100%;margin-top:6px">Send magic link →</button>
        <div id="modal-msg" style="display:none;margin-top:10px;font-size:12px;text-align:center" class="mono"></div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener('click', (e)=> { if(e.target===modal) modal.style.display='none'; });
    document.getElementById('modal-close-btn').addEventListener('click', ()=> modal.style.display='none');

    // Populate the country list, pre-selecting the network's guess only as a
    // starting point.
    (async function(){
      const sel=document.getElementById('modal-country');
      if(!sel) return;
      let pre=null; try{ pre=localStorage.getItem('goat_country'); }catch(e){}
      sel.innerHTML=window.countryOptions(pre);
      if(!pre){ const g=await window.guessCountry(); if(g) sel.value=g; }
      sel.addEventListener('change',()=>{ try{ localStorage.setItem('goat_country', sel.value); }catch(e){} });
    })();

    function modalCountry(){
      const c=document.getElementById('modal-country')?.value||'';
      if(!c){
        const m=document.getElementById('modal-msg');
        m.style.display='block'; m.style.color='#e55';
        m.textContent='Pick your country — it decides how you pay.';
        return null;
      }
      try{ localStorage.setItem('goat_country', c); }catch(e){}
      return c;
    }

    document.getElementById('modal-google-btn').addEventListener('click', async()=>{
      if(!modalCountry()) return;
      const {error} = await window.Auth.signInWithGoogle();
      if(error) {
        const m = document.getElementById('modal-msg');
        m.style.display='block'; m.style.color='#e55'; m.textContent=error.message;
      }
    });

    document.getElementById('modal-send-link').addEventListener('click', async()=>{
      const email = document.getElementById('modal-email').value.trim();
      const name = document.getElementById('modal-name').value.trim();
      const m = document.getElementById('modal-msg');
      const country = modalCountry();
      if(!country) return;
      if(!email) {
        m.style.display='block'; m.style.color='#e55'; m.textContent='Please enter your email';
        return;
      }
      m.style.display='block'; m.style.color='var(--gold)'; m.textContent='Sending magic link…';
      const {error} = await window.Auth.signInWithEmail(email, name, false, country);
      if(error) {
        m.style.color='#e55'; m.textContent=error.message;
      } else {
        m.style.color='var(--live)'; m.textContent='Magic link sent! Check your email to sign in.';
      }
    });
  }
};

async function refreshBalance(){
  const pill=document.getElementById('balance-pill');
  if(!pill) return;
  const {data:{user}}=await window.supabaseClient.auth.getUser();
  if(!user){
    pill.innerHTML=`<button id="signin-btn" style="background:var(--gold);color:var(--bg);border:none;padding:6px 14px;border-radius:999px;font-weight:700;cursor:pointer;font-size:12px">Sign in</button>`;
    const btn=document.getElementById('signin-btn');
    if(btn) btn.addEventListener('click', ()=>{
      window.Auth.openAuthModal();
    });
    return;
  }
  const u = await ensureUserRow();
  const {data}=await window.supabaseClient.from('users').select('balance_cents,display_name,photo_path').eq('id', user.id).maybeSingle();
  const bal=data? data.balance_cents:0;
  // The header pill is the fan's own credit, shown as money like everything
  // else on screen — the vote count lives on the wallet page, where it belongs.
  const credit=window.GOAT.money(bal);

  // The face doubles as the way in to the profile. A backer's name and picture
  // are shown on every board they lead, so the place to change them is wherever
  // they are looking at themselves — not buried on a settings page.
  const face = (data && data.photo_path && window.GOAT.getPhotoUrl(data.photo_path))
    ? `<img src="${data.photo_path.replace(/"/g,'&quot;')}" alt="" style="width:100%;height:100%;object-fit:cover">`
    : `<span style="font-family:Anton,sans-serif;font-size:11px;color:var(--gold)">${
        (data?.display_name || user.email || '?').trim().slice(0,2).toUpperCase()}</span>`;

  pill.innerHTML=`<button id="profile-btn" title="Your profile" style="margin-right:8px;width:26px;height:26px;border-radius:50%;overflow:hidden;border:1px solid var(--border);background:var(--surface-3);padding:0;cursor:pointer;display:inline-grid;place-items:center;vertical-align:middle">${face}</button><span style="font-family:JetBrains Mono,monospace;font-size:12px;color:var(--muted)"><b style="color:var(--gold)">${credit}</b></span> <a href="/wallet" style="margin-left:6px;background:var(--gold);color:var(--bg);padding:5px 11px;border-radius:999px;font-weight:700;font-size:11px">+ Add</a> <button id="signout-btn" title="Sign out" style="margin-left:5px;background:transparent;border:1px solid var(--border);color:var(--muted);padding:4px 8px;border-radius:999px;cursor:pointer;font-size:11px">Out</button>`;

  const prof=document.getElementById('profile-btn');
  // Only wired where the editor is loaded; elsewhere it goes to the wallet,
  // which is the one page that has always shown a fan their own details.
  if(prof) prof.addEventListener('click', ()=>{
    if(window.GoatProfile) window.GoatProfile.edit();
    else location.href='/wallet';
  });

  const out=document.getElementById('signout-btn');
  if(out) out.addEventListener('click', async()=>{ await window.supabaseClient.auth.signOut(); location.reload(); });
}
window.refreshBalance=refreshBalance;
document.addEventListener('DOMContentLoaded', refreshBalance);

window.supabaseClient.auth.onAuthStateChange((event)=>{
  if(event==='SIGNED_IN'){
    const rt = window.Auth.getReturnTo();
    if(rt && location.pathname==='/wallet'){
      try{ sessionStorage.removeItem('goat_returnTo'); }catch(e){}
      location.href=rt;
    }
  }
  refreshBalance();
});
