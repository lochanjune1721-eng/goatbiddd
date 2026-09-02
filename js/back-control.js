// js/back-control.js — one backing control, used on every page that shows a
// contender.
//
// Three ways to put money on someone, in one place so they cannot drift apart
// between the homepage, a board and a contender's own page:
//
//   $1            — the one-tap vote, unchanged.
//   any amount    — type it. Whole dollars, no ceiling but your balance.
//   Greatest Fan  — the exact amount that takes the #1 fan spot on this
//                   contender, which is a dollar more than the current leader
//                   has down. Shown with the number in it, so it is a price
//                   rather than a dare.
//
// The #1 fan is whoever has paid the most toward one contender — fan_totals
// holds that sum per (person, fan). Taking the spot costs the difference plus a
// dollar; defending it costs nothing until someone passes you.

(function(){
  if(typeof window === 'undefined') return;

  function sb(){ return window.supabaseClient; }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function dollars(cents){ return Math.floor((cents||0)/100); }
  function usd(n){ return '$' + Number(n||0).toLocaleString('en-US'); }

  // ── What it costs to be the Greatest Fan of All Time ──────────────────────
  //
  // Read straight from fan_totals, which is public, so the price is on the page
  // for a signed-out visitor too — that is the whole invitation.
  async function goatFan(personId){
    const client = sb();
    const out = { topTotal:0, secondTotal:0, myTotal:0, need:1, topName:null, isTop:false, fans:0 };
    if(!client || !personId) return out;

    const { data, error } = await client
      .from('fan_totals')
      .select('user_id,total_cents,users(display_name)')
      .eq('person_id', personId)
      .order('total_cents', { ascending:false })
      .limit(50);
    if(error || !data) return out;

    out.fans = data.length;
    const top = data[0];
    out.topTotal = top ? (top.total_cents||0) : 0;
    out.secondTotal = data[1] ? (data[1].total_cents||0) : 0;
    out.topName = top ? (top.users?.display_name || 'a fan') : null;

    let me = null;
    try { const { data:{ user } } = await client.auth.getUser(); if(user) me = user.id; } catch(e){}
    if(me){
      const mine = data.find(f => f.user_id === me);
      out.myTotal = mine ? (mine.total_cents||0) : 0;
      out.isTop = !!(top && top.user_id === me);
    }
    // A dollar more than the leader. Never less than a dollar, which is what an
    // empty board costs.
    out.need = Math.max(1, dollars(out.topTotal - out.myTotal) + 1);
    return out;
  }

  // ── Spending ──────────────────────────────────────────────────────────────
  //
  // Every path in and out of a vote: signed out, profile incomplete, short of
  // credit, or it worked. Returns null when nothing was spent, so a caller can
  // roll back an optimistic total without having to read the error.
  async function place(personId, votes, opts){
    const o = opts || {};
    const client = sb();
    if(!client || !personId) return null;
    votes = Math.max(1, Math.floor(Number(votes)||0));

    const { data:{ user } } = await client.auth.getUser();
    if(!user){ window.Auth?.openAuthModal?.(); return null; }

    // Name and email first. The database refuses without them; asking here means
    // a form instead of an error.
    if(window.GoatProfile && !(await window.GoatProfile.require())) return null;

    async function call(){
      let res = await client.rpc('place_vote', { p_person_id: personId, p_votes: votes });
      if(res.error && String(res.error.message||'').includes('Could not find function')){
        res = await client.rpc('place_bid', { p_person_id: personId, p_amount_cents: votes * 100 });
      }
      return res;
    }

    try{
      let res = await call();

      // The page thought the profile was complete and the database disagreed.
      // Ask once, then try again rather than making them find the button.
      if(res.error && /profile incomplete/i.test(String(res.error.message||''))){
        if(window.GoatProfile && await window.GoatProfile.repair()) res = await call();
        else return null;
      }
      if(res.error) throw res.error;
      if(typeof o.onBacked === 'function') o.onBacked(res.data || null);
      if(window.refreshBalance) await window.refreshBalance();
      return res.data || { ok:true };
    }catch(err){
      const m = String(err?.message || err).toLowerCase();
      if(m.includes('not enough') || m.includes('insufficient') || m.includes('balance')){
        // Short of credit is not a failure, it is the checkout. Open it on this
        // contender so the money lands as the vote they were trying to cast.
        if(window.GoatCheckout){
          window.GoatCheckout.vote
            ? window.GoatCheckout.vote({ personId, personName:o.personName, votes,
                personPhoto:o.personPhoto, onVoted:o.onBacked })
            : window.GoatCheckout.open({ personId, personName:o.personName, personPhoto:o.personPhoto });
        } else {
          location.href = '/wallet?returnTo=' + encodeURIComponent(location.pathname + location.search);
        }
        return null;
      }
      if(typeof o.onError === 'function') o.onError(err); else alert(String(err?.message || err));
      return null;
    }
  }

  // ── The control ───────────────────────────────────────────────────────────

  async function mount(el, opts){
    if(!el) return null;
    const o = opts || {};
    const personId = o.personId;
    let state = await goatFan(personId);

    function paint(){
      const crowned = state.isTop;
      el.innerHTML = `
        <div class="back-control">
          <div class="back-row">
            <span class="stepper">
              <button type="button" data-back-dec aria-label="Less">−</button>
              <input data-back-amount type="text" inputmode="numeric" value="1" aria-label="Dollars"
                     style="width:64px;height:28px;border:none;background:transparent;color:var(--ink);text-align:center;font-weight:700">
              <button type="button" data-back-inc aria-label="More">+</button>
            </span>
            <button type="button" data-back-go class="btn-back">Back $1</button>
            <span class="stakes mono" data-back-stakes></span>
          </div>
          ${crowned ? `
            <div class="goat-fan-card is-top">
              <span class="goat-fan-crown">👑</span>
              <div>
                <div class="goat-fan-title">You are the Greatest Fan of All Time</div>
                <div class="goat-fan-sub mono">${usd(dollars(state.myTotal))} down${state.fans>1?` · ${usd(dollars(state.topTotal - state.secondTotal))} clear of the next fan`:''} — back again to defend it</div>
              </div>
            </div>`
          : `
            <button type="button" data-back-goat class="goat-fan-btn">
              <span class="goat-fan-crown">👑</span>
              <span class="goat-fan-copy">
                <span class="goat-fan-title">Become the Greatest Fan of All Time</span>
                <span class="goat-fan-sub mono">${state.topName
                    ? `${esc(state.topName)} leads with ${usd(dollars(state.topTotal))}`
                    : 'Nobody has backed this one yet'} · takes ${usd(state.need)}</span>
              </span>
              <span class="goat-fan-price">${usd(state.need)}</span>
            </button>`}
        </div>`;
      wire();
    }

    function wire(){
      const input = el.querySelector('[data-back-amount]');
      const go    = el.querySelector('[data-back-go]');
      const stakes= el.querySelector('[data-back-stakes]');

      const read = () => Math.max(1, Math.floor(Number(String(input.value).replace(/[^0-9]/g,'')) || 0));
      function sync(){
        const v = read();
        input.value = String(v);
        go.textContent = `Back ${usd(v)}`;
        if(stakes && typeof o.getTotal === 'function'){
          stakes.textContent = `${usd(v)} → ${usd(dollars(o.getTotal()) + v)}`;
        }
      }
      // Typed freely, corrected only on the way out — clamping every keystroke
      // makes a number impossible to edit in the middle.
      input.addEventListener('input', () => {
        const cleaned = String(input.value).replace(/[^0-9]/g,'');
        if(cleaned !== input.value) input.value = cleaned;
        const v = Number(cleaned)||0;
        go.textContent = `Back ${usd(Math.max(1,v))}`;
        if(stakes && typeof o.getTotal === 'function') stakes.textContent = `${usd(Math.max(1,v))} → ${usd(dollars(o.getTotal()) + Math.max(1,v))}`;
      });
      input.addEventListener('blur', sync);
      input.addEventListener('keydown', e => { if(e.key === 'Enter'){ sync(); go.click(); } });
      el.querySelector('[data-back-dec]').addEventListener('click', () => { input.value = String(Math.max(1, read()-1)); sync(); });
      el.querySelector('[data-back-inc]').addEventListener('click', () => { input.value = String(read()+1); sync(); });

      go.addEventListener('click', async () => {
        const v = read();
        go.disabled = true; const label = go.textContent; go.textContent = 'Backing…';
        const r = await place(personId, v, forward());
        go.disabled = false; go.textContent = label;
        if(r) await refresh();
      });

      const goat = el.querySelector('[data-back-goat]');
      if(goat){
        goat.addEventListener('click', async () => {
          goat.disabled = true;
          const r = await place(personId, state.need, forward());
          goat.disabled = false;
          if(r) await refresh();
        });
      }
      sync();
    }

    function forward(){
      return { personName:o.personName, personPhoto:o.personPhoto,
               onBacked:(data)=>{ if(typeof o.onBacked === 'function') o.onBacked(data); },
               onError:o.onError };
    }

    async function refresh(){ state = await goatFan(personId); paint(); }

    paint();
    return { refresh, price: () => state.need, state: () => state };
  }

  // ── The same control, as a sheet ──────────────────────────────────────────
  //
  // For places too tight to carry the control inline — the homepage runs about
  // a hundred duels, and pricing the crown on each of them up front would be two
  // hundred queries before anything paints. Opened on demand, it costs one.
  async function sheet(personId, opts){
    const o = opts || {};
    document.getElementById('goat-back-sheet')?.remove();

    const el = document.createElement('div');
    el.id = 'goat-back-sheet';
    el.className = 'inline-topup';
    el.innerHTML = `
      <div class="inline-topup-card" style="max-width:360px;text-align:left;position:relative">
        <button data-sheet-close style="position:absolute;right:14px;top:14px;background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer">✕</button>
        <h2 class="display" style="font-size:20px;margin-bottom:4px">Back ${esc(o.personName||'this contender')}</h2>
        <p class="mono" style="font-size:12px;color:var(--muted);margin-bottom:14px">$1 = 1 vote. The money on the board is the score.</p>
        <div data-sheet-body class="mono" style="font-size:12px;color:var(--muted)">Reading the leaderboard…</div>
      </div>`;
    document.body.appendChild(el);
    const close = () => el.remove();
    el.addEventListener('click', e => { if(e.target === el) close(); });
    el.querySelector('[data-sheet-close]').addEventListener('click', close);

    const body = el.querySelector('[data-sheet-body]');
    const host = document.createElement('div');
    body.replaceWith(host);

    await mount(host, Object.assign({}, o, {
      personId,
      onBacked(data){
        if(typeof o.onBacked === 'function') o.onBacked(data);
        close();
      }
    }));
    return true;
  }

  window.GoatBack = { mount, sheet, place, goatFan, dollars, usd };
})();
