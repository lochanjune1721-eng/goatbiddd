// js/goat-corner.js — who holds the crown, and what it costs to take it.
//
// The Greatest Fan of All Time is whoever has put the most money down across
// the whole site — users.total_spent_cents, which /api/fans already ranks. It
// is the one title the site is actually about, and until now it was a row in a
// sidebar that scrolls away.
//
// So it sits in the corner instead: their face, their number, and the exact
// amount it would take to pass them. A price, not a dare.

(function(){
  if(typeof window === 'undefined') return;

  const DISMISSED = 'goat_corner_dismissed';
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function usd(n){ return '$' + Math.max(0, Math.floor(n||0)).toLocaleString('en-US'); }

  function dismissed(){ try { return sessionStorage.getItem(DISMISSED) === '1'; } catch(e){ return false; } }
  function dismiss(){ try { sessionStorage.setItem(DISMISSED, '1'); } catch(e){} }

  async function render(){
    if(dismissed() || document.getElementById('goat-corner')) return;

    let fans = [];
    try {
      const r = await fetch('/api/fans?t=' + Date.now());
      fans = (await r.json())?.fans || [];
    } catch(e){ return; }
    const leader = fans[0];
    if(!leader) return;

    // Where the viewer stands against them. Signed out, the price is simply the
    // leader's total plus a dollar — which is the honest number for someone
    // starting from nothing.
    let mine = 0, iAmLeader = false;
    try {
      const { data:{ user } } = await window.supabaseClient.auth.getUser();
      if(user){
        iAmLeader = user.id === leader.id;
        const me = fans.find(f => f.id === user.id);
        if(me) mine = me.total_spent_cents || 0;
        else {
          const { data } = await window.supabaseClient.from('users')
            .select('total_spent_cents').eq('id', user.id).maybeSingle();
          mine = data?.total_spent_cents || 0;
        }
      }
    } catch(e){}

    const leadCents = leader.total_spent_cents || 0;
    const need = Math.max(1, Math.floor((leadCents - mine) / 100) + 1);
    const anon = !!leader.is_anonymous;
    const name = anon ? 'Anonymous' : (leader.display_name || 'A backer');
    const url  = (!anon && leader.photo_path && window.GOAT?.getPhotoUrl)
      ? window.GOAT.getPhotoUrl(leader.photo_path) : null;
    const initials = window.GOAT?.initials ? window.GOAT.initials(name) : name.slice(0,2).toUpperCase();

    const face = url
      ? `<img src="${esc(url)}" alt="" loading="lazy">`
      : `<span class="goat-corner-initials">${esc(initials)}</span>`;

    const el = document.createElement('aside');
    el.id = 'goat-corner';
    el.className = 'goat-corner' + (iAmLeader ? ' is-me' : '');
    el.innerHTML = `
      <button class="goat-corner-x" aria-label="Hide">✕</button>
      <div class="goat-corner-face">${face}<span class="goat-corner-crown">👑</span></div>
      <div class="goat-corner-body">
        <div class="goat-corner-label">Greatest Fan of All Time</div>
        <div class="goat-corner-name">${esc(name)}</div>
        <div class="goat-corner-sum mono">${usd(leadCents/100)} backed${
          leader.backing ? ` · on ${esc(leader.backing.name)}` : ''}</div>
        ${iAmLeader
          ? `<div class="goat-corner-cta held">You hold it — keep backing to defend it</div>`
          : `<a class="goat-corner-cta" href="/">Back ${usd(need)} to become the Greatest Fan</a>`}
      </div>`;
    document.body.appendChild(el);
    el.querySelector('.goat-corner-x').addEventListener('click', () => { dismiss(); el.remove(); });
  }

  // After the page has drawn itself. The crown is context, not the headline,
  // and it should never be the reason the first paint is late.
  if(document.readyState === 'complete') setTimeout(render, 900);
  else window.addEventListener('load', () => setTimeout(render, 900));
})();
