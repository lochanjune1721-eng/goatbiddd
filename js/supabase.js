// GOAT.lol — Supabase + auth + balance
const SUPABASE_URL = "https://orzcszqpnvicreqvpncu.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9yemNzenFwbnZpY3JlcXZwbmN1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc2NDIwNDIsImV4cCI6MjEwMzIxODA0Mn0.ayMlWauR_XCT2lWV_Pg2PZTq_CuTS-bch8KdoxslvIs";
window.SUPABASE_URL = SUPABASE_URL;
window.SUPABASE_ANON_KEY = SUPABASE_ANON_KEY;
window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

window.GOAT = {
  SUPABASE_URL,
  getPhotoUrl: (path) => {
    if(!path || typeof path !== 'string') return null;
    const trimmed = path.trim();
    if(!trimmed) return null;
    if(trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('data:')) {
      return trimmed;
    }
    // Clean leading slashes
    const cleanPath = trimmed.replace(/^\/+/, '');
    return `${SUPABASE_URL}/storage/v1/object/public/people/${cleanPath}`;
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
    const display = user.user_metadata?.display_name || user.email.split('@')[0];
    const anon = !!user.user_metadata?.is_anonymous;
    const {data: ins}=await window.supabaseClient.from('users').insert({id:user.id, email:user.email, display_name: display, is_anonymous: anon}).select('*').maybeSingle();
    data=ins;
  }
  return data;
}
window.ensureUserRow=ensureUserRow;

async function refreshBalance(){
  const pill=document.getElementById('balance-pill');
  if(!pill) return;
  const {data:{user}}=await window.supabaseClient.auth.getUser();
  if(!user){ pill.innerHTML=`<a href="wallet.html">Sign in</a>`; return; }
  const {data}=await window.supabaseClient.from('users').select('balance_cents').eq('id', user.id).maybeSingle();
  const bal=data? data.balance_cents:0;
  pill.innerHTML=`<b>${Math.floor(bal/100).toLocaleString()} votes</b> <a href="wallet.html">Add</a>`;
}
window.refreshBalance=refreshBalance;
document.addEventListener('DOMContentLoaded', refreshBalance);
window.supabaseClient.auth.onAuthStateChange(()=> refreshBalance());

// anon session helper — create users row with anon_session_id cookie before sign-in, merge on sign-in
(function(){
  function getAnonId(){
    let m=document.cookie.match(/goat_anon=([^;]+)/);
    if(m) return m[1];
    const id='anon_'+Math.random().toString(36).slice(2,10)+Date.now().toString(36);
    document.cookie='goat_anon='+id+'; path=/; max-age=31536000; SameSite=Lax';
    return id;
  }
  window.getAnonId=getAnonId;
  // On auth, merge anon row if exists (callable from wallet)
  window.mergeAnon=async function(){
    const anon=getAnonId();
    const {data:{user}}=await window.supabaseClient.auth.getUser();
    if(!user || !anon) return;
    try{ await window.supabaseClient.rpc('merge_anon',{p_anon_id: anon}); }catch(e){}
  }
  try{ getAnonId(); }catch(e){}
})();
