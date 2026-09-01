// js/checkout.js — the checkout overlay.
//
// One file, loaded by every page that can take money, so paying always looks
// and behaves the same wherever it starts. Deliberately styled nothing like the
// site: the site is dark and gold, this is a dark summary panel beside a white
// form. Paying is the one moment a visitor should feel handed to something
// sober and bank-like rather than to more of the same page.
//
// It opens for two jobs and knows the difference:
//   open({ personId, personName })  — back a contender. The votes are spent on
//     them the instant the payment settles; no wallet to understand first.
//   open()                          — top up the wallet and keep the balance.
//
// Every number shown comes from /api/health: the tier table and which rails
// work. The page never decides what a payment is worth — the server recomputes
// it at checkout and writes it onto the top-up row.
(function(){
  'use strict';
  if (window.GoatCheckout) return;

  const CSS = `
.gco-root{position:fixed;inset:0;z-index:9999;display:none;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.gco-root.open{display:block}
.gco-veil{position:absolute;inset:0;background:rgba(8,8,10,.72);backdrop-filter:blur(10px) saturate(120%);
  animation:gco-fade .22s ease}
.gco-wrap{position:absolute;inset:0;display:grid;place-items:center;padding:20px;overflow:auto}
.gco-card{position:relative;width:100%;max-width:900px;background:#fff;border-radius:22px;overflow:hidden;
  display:grid;grid-template-columns:5fr 6fr;box-shadow:0 40px 90px -20px rgba(0,0,0,.7);
  animation:gco-rise .26s cubic-bezier(.2,.8,.25,1);color:#14141a}
@keyframes gco-fade{from{opacity:0}to{opacity:1}}
@keyframes gco-rise{from{opacity:0;transform:translateY(14px) scale(.985)}to{opacity:1;transform:none}}

/* ── left: the order ───────────────────────────────────────────────────── */
.gco-side{background:#111116;color:#f4f4f6;padding:30px 28px;display:flex;flex-direction:column;gap:18px}
.gco-brand{display:flex;align-items:center;gap:9px;font-weight:800;font-size:14px;letter-spacing:-.01em}
.gco-brand i{width:22px;height:22px;border-radius:7px;background:linear-gradient(140deg,#e8c874,#b8892f);
  display:block;flex:0 0 auto}
.gco-for{display:flex;align-items:center;gap:12px;padding:14px 0;border-top:1px solid rgba(255,255,255,.1);
  border-bottom:1px solid rgba(255,255,255,.1)}
.gco-for img{width:46px;height:46px;border-radius:50%;object-fit:cover;background:#26262e;flex:0 0 auto}
.gco-for-label{font-size:10.5px;letter-spacing:.13em;text-transform:uppercase;color:#8b8b98}
.gco-for-name{font-size:17px;font-weight:700;letter-spacing:-.015em;line-height:1.2}
.gco-big{font-size:42px;font-weight:800;letter-spacing:-.03em;line-height:1;font-variant-numeric:tabular-nums}
.gco-big-sub{font-size:12.5px;color:#8b8b98;margin-top:6px}
.gco-lines{margin-top:auto;display:flex;flex-direction:column;gap:9px;font-size:13px}
.gco-line{display:flex;justify-content:space-between;gap:12px;color:#b9b9c6}
.gco-line b{color:#f4f4f6;font-variant-numeric:tabular-nums;font-weight:600}
.gco-line.bonus{color:#5fd08a}.gco-line.bonus b{color:#5fd08a}
.gco-line.total{border-top:1px solid rgba(255,255,255,.12);padding-top:11px;margin-top:2px;font-size:15px;color:#fff}
.gco-line.total b{font-size:18px;font-weight:800;letter-spacing:-.02em}
.gco-note{font-size:11px;color:#75757f;line-height:1.55}

/* ── right: the form ───────────────────────────────────────────────────── */
.gco-main{padding:30px 28px;display:flex;flex-direction:column;gap:18px;background:#fff}
.gco-h{font-size:19px;font-weight:750;letter-spacing:-.022em;margin:0}
.gco-sub{font-size:12.5px;color:#6b6b78;margin:-12px 0 0;line-height:1.5}
.gco-label{font-size:10.5px;letter-spacing:.13em;text-transform:uppercase;color:#8a8a96;font-weight:700}
.gco-tiers{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.gco-tier{position:relative;border:1.5px solid #e4e4ea;background:#fff;border-radius:13px;padding:11px 8px 9px;
  cursor:pointer;text-align:center;transition:border-color .14s,background .14s,transform .1s;font:inherit;color:inherit}
.gco-tier:hover{border-color:#b9b9c4}
.gco-tier:active{transform:scale(.985)}
.gco-tier.on{border-color:#14141a;background:#14141a;color:#fff}
.gco-tier-amt{font-size:16px;font-weight:800;letter-spacing:-.02em;display:block}
.gco-tier-votes{font-size:11px;color:#7a7a86;display:block;margin-top:1px}
.gco-tier.on .gco-tier-votes{color:#c6c6d2}
.gco-tier-tag{position:absolute;top:-7px;left:50%;transform:translateX(-50%);background:#1f9d55;color:#fff;
  font-size:9px;font-weight:800;letter-spacing:.05em;padding:2px 7px;border-radius:999px;white-space:nowrap}
.gco-custom{display:flex;gap:8px;align-items:center}
.gco-custom input{flex:1;min-width:0;height:44px;border:1.5px solid #e4e4ea;border-radius:12px;padding:0 14px;
  font:inherit;font-size:15px;color:#14141a;background:#fff}
.gco-custom input:focus{outline:none;border-color:#14141a}
.gco-methods{display:grid;gap:8px}
.gco-method{display:flex;align-items:center;gap:11px;border:1.5px solid #e4e4ea;background:#fff;border-radius:13px;
  padding:13px 14px;cursor:pointer;text-align:left;transition:border-color .14s,background .14s;font:inherit;color:inherit}
.gco-method:hover{border-color:#b9b9c4}
.gco-method.on{border-color:#14141a;background:#fafafb}
.gco-method-mark{width:34px;height:24px;border-radius:6px;flex:0 0 auto;display:grid;place-items:center;
  font-size:10px;font-weight:800;letter-spacing:-.02em;color:#fff}
.gco-method-mark.paypal{background:#003087}
.gco-method-mark.upi{background:linear-gradient(135deg,#0d7a3f,#f26522)}
.gco-method-t{display:block;font-size:13.5px;font-weight:700;letter-spacing:-.01em;line-height:1.25}
.gco-method-s{display:block;font-size:11.5px;color:#7a7a86;line-height:1.35;margin-top:2px}
.gco-method-tick{margin-left:auto;width:18px;height:18px;border-radius:50%;border:1.5px solid #d6d6de;flex:0 0 auto}
.gco-method.on .gco-method-tick{border-color:#14141a;background:#14141a;
  box-shadow:inset 0 0 0 3.5px #fff}
.gco-pay{width:100%;height:50px;border:0;border-radius:13px;background:#14141a;color:#fff;font:inherit;
  font-size:15px;font-weight:750;letter-spacing:-.01em;cursor:pointer;transition:background .14s,opacity .14s}
.gco-pay:hover{background:#000}
.gco-pay:disabled{opacity:.45;cursor:not-allowed}
.gco-msg{font-size:12.5px;line-height:1.5;padding:11px 13px;border-radius:11px;display:none}
.gco-msg.show{display:block}
.gco-msg.err{background:#fdf1f1;color:#a3242b;border:1px solid #f3d7d8}
.gco-msg.info{background:#f4f5f7;color:#4a4a58;border:1px solid #e4e4ea}
.gco-fine{font-size:10.5px;color:#96969f;line-height:1.6;text-align:center}
.gco-x{position:absolute;top:14px;right:16px;width:30px;height:30px;border-radius:50%;border:0;cursor:pointer;
  background:rgba(255,255,255,.9);color:#14141a;font-size:16px;line-height:1;display:grid;place-items:center;z-index:2}
.gco-x:hover{background:#fff}

/* ── the UPI step, only when nothing can confirm for us ────────────────── */
.gco-upi{display:none;flex-direction:column;gap:13px;align-items:center;text-align:center}
.gco-upi.show{display:flex}
.gco-upi svg{width:180px;height:180px;background:#fff;border-radius:12px;padding:7px;border:1.5px solid #e4e4ea}
.gco-upi-copy{width:100%;border:1.5px solid #e4e4ea;border-radius:12px;padding:9px 12px;text-align:left;
  cursor:pointer;background:#fff;font:inherit;color:inherit;position:relative}
.gco-upi-copy b{display:block;font-family:ui-monospace,Menlo,monospace;font-size:13px;overflow-wrap:anywhere}
.gco-upi-copy span{font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:#8a8a96;font-weight:700}
.gco-upi-copy i{position:absolute;top:9px;right:12px;font-style:normal;font-size:9.5px;font-weight:800;
  letter-spacing:.08em;text-transform:uppercase;color:#1f9d55}

@media (max-width:760px){
  .gco-card{grid-template-columns:1fr;max-width:460px;border-radius:18px}
  .gco-side{padding:22px 20px 18px;gap:14px}
  .gco-big{font-size:34px}
  .gco-lines{margin-top:4px}
  .gco-main{padding:20px}
  .gco-wrap{padding:10px;align-items:start}
}
@media (max-width:380px){ .gco-tiers{grid-template-columns:repeat(2,1fr)} }
`;

  let el = null, state = null, health = null;

  function h(html){ const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; }
  function esc(v){ return String(v == null ? '' : v)
    .replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function money(cents, currency, inrPerVote){
    return currency === 'INR' && inrPerVote
      ? '₹' + Math.round((cents / 100) * inrPerVote).toLocaleString('en-IN')
      : '$' + (cents / 100).toLocaleString('en-US');
  }

  function build(){
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    el = h(`<div class="gco-root" role="dialog" aria-modal="true" aria-label="Checkout">
      <div class="gco-veil" data-close></div>
      <div class="gco-wrap" data-wrap>
        <div class="gco-card">
          <button class="gco-x" data-close aria-label="Close">✕</button>
          <aside class="gco-side">
            <div class="gco-brand"><i></i> The True GOAT</div>
            <div class="gco-for" data-for hidden>
              <img data-for-img alt="">
              <div><div class="gco-for-label">Backing</div><div class="gco-for-name" data-for-name></div></div>
            </div>
            <div>
              <div class="gco-big" data-big>—</div>
              <div class="gco-big-sub" data-big-sub></div>
            </div>
            <div class="gco-lines">
              <div class="gco-line"><span>Votes</span><b data-l-votes>—</b></div>
              <div class="gco-line bonus" data-l-bonus-row hidden><span>Bonus votes</span><b data-l-bonus></b></div>
              <div class="gco-line total"><span>Total</span><b data-l-total>—</b></div>
              <div class="gco-note" data-note></div>
            </div>
          </aside>
          <section class="gco-main">
            <h2 class="gco-h" data-title>Add votes</h2>
            <p class="gco-sub" data-subtitle></p>
            <div class="gco-msg" data-msg></div>
            <div data-buy>
              <div class="gco-label" style="margin-bottom:9px">Amount</div>
              <div class="gco-tiers" data-tiers></div>
              <div class="gco-custom" style="margin-top:9px">
                <input type="number" min="1" step="1" placeholder="Other amount in $" data-custom>
              </div>
              <div class="gco-label" style="margin:18px 0 9px">Pay with</div>
              <div class="gco-methods" data-methods></div>
              <button class="gco-pay" data-pay style="margin-top:16px">Continue</button>
              <div class="gco-fine" style="margin-top:11px" data-fine></div>
            </div>
            <div class="gco-upi" data-upi>
              <svg data-upi-qr viewBox="0 0 1 1"></svg>
              <button class="gco-upi-copy" data-copy-vpa><span>UPI ID</span><b data-upi-vpa></b><i>Copy</i></button>
              <button class="gco-upi-copy" data-copy-ref><span>Reference</span><b data-upi-ref></b><i>Copy</i></button>
              <a class="gco-pay" data-upi-open style="display:grid;place-items:center;text-decoration:none">Open UPI app</a>
              <div class="gco-custom" style="width:100%">
                <input data-utr placeholder="12-digit UTR" inputmode="numeric">
                <button class="gco-pay" data-utr-send style="width:auto;padding:0 18px">Submit</button>
              </div>
              <div class="gco-fine">Votes are added once we match your reference — usually within a few hours.</div>
            </div>
          </section>
        </div>
      </div>
    </div>`);
    document.body.appendChild(el);

    el.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
    document.addEventListener('keydown', e => { if(e.key === 'Escape' && el.classList.contains('open')) close(); });
    el.querySelector('[data-pay]').addEventListener('click', pay);
    el.querySelector('[data-custom]').addEventListener('input', onCustom);
    el.querySelector('[data-utr-send]').addEventListener('click', sendUtr);
    el.querySelector('[data-copy-vpa]').addEventListener('click', e => copy(e.currentTarget, 'upi-vpa'));
    el.querySelector('[data-copy-ref]').addEventListener('click', e => copy(e.currentTarget, 'upi-ref'));
    return el;
  }

  async function copy(btn, key){
    const value = el.querySelector('[data-' + key + ']').textContent.trim();
    const tag = btn.querySelector('i');
    try { await navigator.clipboard.writeText(value); tag.textContent = 'Copied'; }
    catch(e){ tag.textContent = 'Select it'; }
    setTimeout(() => { tag.textContent = 'Copy'; }, 1600);
  }

  function msg(text, kind){
    const m = el.querySelector('[data-msg]');
    m.textContent = text || '';
    m.className = 'gco-msg' + (text ? ' show ' + (kind || 'info') : '');
  }

  function paint(){
    const t = health?.tiers || [];
    const rails = health?.rails || { offer: [], preferred: null };
    const perVote = health?.upi?.inrPerVote || health?.uropay?.inrPerVote || null;
    const currency = state.method === 'upi' ? 'INR' : 'USD';
    const q = s => el.querySelector(s);

    // Amount tiles.
    q('[data-tiers]').innerHTML = t.map(x =>
      `<button class="gco-tier${x.cents === state.cents ? ' on' : ''}" data-cents="${x.cents}">
         ${x.bonus > 0 ? `<span class="gco-tier-tag">+${x.bonus} free</span>` : ''}
         <span class="gco-tier-amt">${money(x.cents, currency, perVote)}</span>
         <span class="gco-tier-votes">${x.votes} votes</span>
       </button>`).join('');
    q('[data-tiers]').querySelectorAll('.gco-tier').forEach(b => b.addEventListener('click', () => {
      state.cents = Number(b.dataset.cents);
      q('[data-custom]').value = '';
      paint();
    }));

    // Methods.
    const LABEL = {
      paypal: ['PayPal', 'paypal', 'Card, or your PayPal balance'],
      upi:    ['UPI', 'upi', rails.upiAutoConfirms
        ? 'Any UPI app. Votes land the moment it clears.'
        : 'Any UPI app. We add the votes after matching your reference.']
    };
    q('[data-methods]').innerHTML = rails.offer.map(m => {
      const [name, cls, sub] = LABEL[m] || [m, '', ''];
      return `<button class="gco-method${m === state.method ? ' on' : ''}" data-method="${m}">
          <span class="gco-method-mark ${cls}">${name === 'PayPal' ? 'PP' : 'UPI'}</span>
          <span style="min-width:0"><span class="gco-method-t">${esc(name)}</span><span class="gco-method-s">${esc(sub)}</span></span>
          <span class="gco-method-tick"></span>
        </button>`;
    }).join('');
    q('[data-methods]').querySelectorAll('.gco-method').forEach(b => b.addEventListener('click', () => {
      state.method = b.dataset.method; paint();
    }));

    // Summary.
    const tier = t.find(x => x.cents === state.cents);
    const votes = tier ? tier.votes : Math.floor(state.cents / 100);
    const bonus = tier ? tier.bonus : 0;
    q('[data-big]').textContent = money(state.cents, currency, perVote);
    q('[data-big-sub]').textContent = votes + ' vote' + (votes === 1 ? '' : 's')
      + (currency === 'INR' ? ' · charged in rupees' : '');
    q('[data-l-votes]').textContent = (votes - bonus) + '';
    q('[data-l-bonus-row]').hidden = bonus <= 0;
    q('[data-l-bonus]').textContent = '+' + bonus;
    q('[data-l-total]').textContent = votes + ' votes';
    q('[data-note]').textContent = state.personName
      ? 'Spent on ' + state.personName + ' the moment your payment clears.'
      : 'Added to your wallet. Spend it on anyone, any time.';

    q('[data-pay]').textContent = rails.offer.length
      ? 'Pay ' + money(state.cents, currency, perVote)
      : 'Payments unavailable';
    q('[data-pay]').disabled = !rails.offer.length || !state.method;
    q('[data-fine]').textContent = state.method === 'paypal'
      ? 'You will finish on PayPal, then come straight back.'
      : rails.upiAutoConfirms ? 'You will finish in your UPI app, then come straight back.' : '';
  }

  function onCustom(e){
    const dollars = Number(e.target.value);
    if(!Number.isFinite(dollars) || dollars < 1) return;
    state.cents = Math.min(Math.round(dollars) * 100, 500000);
    paint();
  }

  async function token(){
    try {
      const { data:{ session } } = await window.supabaseClient.auth.getSession();
      return session?.access_token || null;
    } catch(e){ return null; }
  }

  async function pay(){
    const tok = await token();
    if(!tok){
      close();
      if(window.Auth?.openAuthModal) window.Auth.openAuthModal();
      else location.href = '/wallet';
      return;
    }
    const btn = el.querySelector('[data-pay]');
    btn.disabled = true; btn.textContent = 'Opening…';
    msg('');

    const direct = state.method === 'upi' && health?.rails?.upiProvider === 'direct';
    const action = state.method === 'paypal' ? 'paypal-checkout' : direct ? 'upi-intent' : 'uropay-checkout';

    try {
      const r = await fetch('/api/pay', {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'Authorization':'Bearer ' + tok },
        body: JSON.stringify({
          action, amountCents: state.cents,
          personId: state.personId || null,
          returnTo: location.pathname + location.search
        })
      });
      const j = await r.json().catch(() => ({}));
      if(!r.ok){ msg(j.error || 'That did not go through. Nothing has been charged.', 'err'); paint(); return; }

      if(j.url){ location.href = j.url; return; }          // PayPal / UroPay hosted page
      if(j.upiUrl){ showDirectUpi(j); return; }             // fallback rail only
      msg('Payment started. Your votes will appear shortly.', 'info');
      paint();
    } catch(err){
      msg('Could not reach the payment service: ' + err.message, 'err');
      paint();
    }
  }

  function showDirectUpi(j){
    state.topupId = j.topupId;
    const q = s => el.querySelector(s);
    q('[data-buy]').style.display = 'none';
    q('[data-upi]').classList.add('show');
    q('[data-title]').textContent = 'Pay ₹' + j.amountInr;
    q('[data-subtitle]').textContent = 'Scan the code, or copy the UPI ID into your app.';
    const holder = document.createElement('div');
    holder.innerHTML = j.qrSvg || '';
    const svg = holder.querySelector('svg');
    if(svg) q('[data-upi-qr]').replaceWith(Object.assign(svg, { dataset:{ upiQr:'' } }));
    q('[data-upi-vpa]').textContent = j.vpa;
    q('[data-upi-ref]').textContent = j.reference;
    q('[data-upi-open]').href = j.upiUrl;
  }

  async function sendUtr(){
    const utr = el.querySelector('[data-utr]').value.trim();
    if(!utr) return msg('Enter the reference number from your payment app.', 'err');
    const tok = await token();
    if(!tok) return msg('Sign in again to submit your reference.', 'err');
    try {
      const r = await fetch('/api/pay', {
        method:'POST',
        headers:{ 'Content-Type':'application/json','Authorization':'Bearer ' + tok },
        body: JSON.stringify({ action:'upi-claim', topupId: state.topupId, utr })
      });
      const j = await r.json().catch(() => ({}));
      if(!r.ok) return msg(j.error || 'Could not submit that reference.', 'err');
      el.querySelector('[data-upi]').classList.remove('show');
      el.querySelector('[data-title]').textContent = 'Thanks — reference received';
      el.querySelector('[data-subtitle]').textContent = j.message || 'We will add your votes once the payment is matched.';
    } catch(err){ msg('Error: ' + err.message, 'err'); }
  }

  function close(){
    if(!el) return;
    el.classList.remove('open');
    document.documentElement.style.overflow = '';
  }

  async function open(opts){
    opts = opts || {};
    if(!el) build();
    state = {
      cents: 1000,
      method: null,
      personId: opts.personId || null,
      personName: opts.personName || null,
      topupId: null
    };

    const q = s => el.querySelector(s);
    q('[data-buy]').style.display = '';
    q('[data-upi]').classList.remove('show');
    q('[data-utr]').value = '';
    q('[data-custom]').value = '';
    msg('');

    q('[data-for]').hidden = !state.personName;
    if(state.personName){
      q('[data-for-name]').textContent = state.personName;
      const img = q('[data-for-img]');
      if(opts.personPhoto){ img.src = opts.personPhoto; img.hidden = false; } else { img.hidden = true; }
      q('[data-title]').textContent = 'Back ' + state.personName;
      q('[data-subtitle]').textContent = 'Your votes go straight onto their total — no wallet needed.';
    } else {
      q('[data-title]').textContent = 'Add votes';
      q('[data-subtitle]').textContent = 'Top up once, then back anyone with one tap.';
    }

    el.classList.add('open');
    document.documentElement.style.overflow = 'hidden';

    if(!health){
      try { health = await fetch('/api/health').then(r => r.json()); }
      catch(e){ health = null; }
    }
    if(!health?.rails?.offer?.length){
      msg('Payments are not available right now. Nothing has been charged.', 'err');
    }
    state.method = health?.rails?.preferred || health?.rails?.offer?.[0] || null;
    paint();
  }

  window.GoatCheckout = { open, close, reload(){ health = null; } };
})();
