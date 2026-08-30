// The True GOAT — Supabase + auth + balance
const SUPABASE_URL = "https://orzcszqpnvicreqvpncu.supabase.co";
const SUPABASE_ANON_KEY = "[REDACTED]";
window.SUPABASE_URL = SUPABASE_URL;
window.SUPABASE_ANON_KEY = SUPABASE_ANON_KEY;

const SITE_URL = "https://www.thetruegoat.com";
function getSiteUrl(){
  // In production location.origin is https://www.thetruegoat.com — use it so preview deploys also work.
  // Never return localhost: any hardcoded localhost breaks production.
  try {
    const o = window.location.origin;
    if(o && !o.includes('localhost') && !o.includes('127.0.0.1')) return o;
  } catch(e){}
  return SITE_URL;
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
    // OAuth redirect must be allowlisted in Supabase dashboard — dashboard setting outside code.
    return window.supabaseClient.auth.signInWithOAuth({ provider:'google', options:{ redirectTo: redirect } });
  }
};

async function refreshBalance(){
  const pill=document.getElementById('balance-pill');
  if(!pill) return;
  const {data:{user}}=await window.supabaseClient.auth.getUser();
  if(!user){
    // Real sign-in, not a plain link to wallet — triggers Auth
    pill.innerHTML=`<button id="signin-btn" style="background:var(--gold);color:var(--bg);border:none;padding:7px 14px;border-radius:999px;font-weight:700;cursor:pointer;font-size:13px">Sign in</button>`;
    const btn=document.getElementById('signin-btn');
    if(btn) btn.addEventListener('click', ()=>{
      window.Auth.rememberReturnTo();
      location.href='/wallet?returnTo='+encodeURIComponent(location.pathname+location.search);
    });
    return;
  }
  await ensureUserRow();
  const {data}=await window.supabaseClient.from('users').select('balance_cents').eq('id', user.id).maybeSingle();
  const bal=data? data.balance_cents:0;
  const votes=Math.floor(bal/100).toLocaleString();
  pill.innerHTML=`<span style="font-family:JetBrains Mono,monospace;font-size:12px;color:var(--muted)"> <b style="color:var(--gold)">${votes} votes</b></span> <a href="/wallet" style="margin-left:8px;background:var(--gold);color:var(--bg);padding:6px 12px;border-radius:999px;font-weight:700;font-size:12px">Add</a> <button id="signout-btn" title="Sign out" style="margin-left:6px;background:transparent;border:1px solid var(--border);color:var(--muted);padding:5px 10px;border-radius:999px;cursor:pointer;font-size:11px">Out</button>`;
  const out=document.getElementById('signout-btn');
  if(out) out.addEventListener('click', async()=>{ await window.supabaseClient.auth.signOut(); location.reload(); });
}
window.refreshBalance=refreshBalance;
document.addEventListener('DOMContentLoaded', refreshBalance);
window.supabaseClient.auth.onAuthStateChange((event)=>{
  if(event==='SIGNED_IN'){
    // land back where they were
    const rt = window.Auth.getReturnTo();
    if(rt && location.pathname==='/wallet'){
      try{ sessionStorage.removeItem('goat_returnTo'); }catch(e){}
      location.href=rt;
    }
  }
  refreshBalance();
});

// anon session helper
(function(){
  function getAnonId(){
    let m=document.cookie.match(/goat_anon=([^;]+)/);
    if(m) return m[1];
    const id='anon_'+Math.random().toString(36).slice(2,10)+Date.now().toString(36);
    document.cookie='goat_anon='+id+'; path=/; max-age=31536000; SameSite=Lax';
    return id;
  }
  window.getAnonId=getAnonId;
  window.mergeAnon=async function(){
    const anon=getAnonId();
    const {data:{user}}=await window.supabaseClient.auth.getUser();
    if(!user || !anon) return;
    try{ await window.supabaseClient.rpc('merge_anon',{p_anon_id: anon}); }catch(e){}
  }
  try{ getAnonId(); }catch(e){}
})();
