// js/supabase.js — The True GOAT Auth, Balance & Supabase Client
const SUPABASE_URL = "https://orzcszqpnvicreqvpncu.supabase.co";
const SUPABASE_ANON_KEY = "[REDACTED]";
window.SUPABASE_URL = SUPABASE_URL;
window.SUPABASE_ANON_KEY = SUPABASE_ANON_KEY;

const PRODUCTION_DOMAIN = "https://www.thetruegoat.com";

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
  cents: (c)=> `$${(c/100).toLocaleString()}`,
  votes: (c)=> `${Math.floor((c||0)/100).toLocaleString()} votes`,
  votesShort: (c)=> `${Math.floor((c||0)/100).toLocaleString()}`,
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
    const {data: ins}=await window.supabaseClient.from('users').insert({id:user.id, email:user.email, display_name: display, is_anonymous: anon}).select('*').maybeSingle();
    data=ins;
  }
  return data;
}
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
  async signInWithEmail(email, displayName, isAnon){
    window.Auth.rememberReturnTo();
    const returnTo = window.Auth.getReturnTo();
    const redirect = getSiteUrl() + '/wallet' + (returnTo ? '?returnTo='+encodeURIComponent(returnTo) : '');
    return window.supabaseClient.auth.signInWithOtp({
      email,
      options:{ data:{ display_name: displayName||email.split('@')[0], is_anonymous: !!isAnon }, emailRedirectTo: redirect }
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
        <p class="mono" style="font-size:12px;color:var(--muted);margin-bottom:14px">Back your GOAT with one tap. $1 = 1 vote.</p>
        <button id="modal-google-btn" class="btn-primary" style="background:#fff;color:#111;border:1px solid var(--border);display:flex;align-items:center;gap:8px;justify-content:center;width:100%;font-weight:700">
          <span style="font-size:16px">G</span> Continue with Google
        </button>
        <div class="mono" style="text-align:center;color:var(--muted);font-size:11px;margin:12px 0">— or email magic link —</div>
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

    document.getElementById('modal-google-btn').addEventListener('click', async()=>{
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
      if(!email) {
        m.style.display='block'; m.style.color='#e55'; m.textContent='Please enter your email';
        return;
      }
      m.style.display='block'; m.style.color='var(--gold)'; m.textContent='Sending magic link…';
      const {error} = await window.Auth.signInWithEmail(email, name, false);
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
  const votes=Math.floor(bal/100).toLocaleString();
  
  pill.innerHTML=`<span style="font-family:JetBrains Mono,monospace;font-size:12px;color:var(--muted)"><b style="color:var(--gold)">${votes} votes</b></span> <a href="/wallet" style="margin-left:6px;background:var(--gold);color:var(--bg);padding:5px 11px;border-radius:999px;font-weight:700;font-size:11px">+ Add</a> <button id="signout-btn" title="Sign out" style="margin-left:5px;background:transparent;border:1px solid var(--border);color:var(--muted);padding:4px 8px;border-radius:999px;cursor:pointer;font-size:11px">Out</button>`;
  
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
