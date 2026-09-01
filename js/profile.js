// js/profile.js — the name and email a backer has to have before they can back.
//
// The rule is enforced in the database (supabase-profile-gate.sql): place_vote
// and place_bid both refuse an account without them. This file is the other
// half — asking for them at the point it matters, so the rule arrives as a form
// rather than as a raised exception.
//
// A photo is asked for and never required. Where someone signed in with Google
// we already have one, so it is filled in and they are not asked twice.

(function(){
  if(typeof window === 'undefined') return;

  const AVATAR_BUCKET = 'avatars';
  const MAX_BYTES = 5 * 1024 * 1024;

  function sb(){ return window.supabaseClient; }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  // The row as the gate sees it. Kept for the life of the page and refreshed
  // after a save, so a vote does not cost a round trip per click.
  let cached = null;

  async function load(force){
    if(cached && !force) return cached;
    const client = sb(); if(!client) return null;
    const { data:{ user } } = await client.auth.getUser();
    if(!user) { cached = null; return null; }

    let { data } = await client.from('users')
      .select('id,email,display_name,photo_path').eq('id', user.id).maybeSingle();

    // Google hands us a name and a picture. Taking them here means a Google
    // signer never sees this form at all, which is the whole point of asking
    // an OAuth provider for a profile in the first place.
    const meta = user.user_metadata || {};
    const fromGoogle = {
      display_name: meta.full_name || meta.name || null,
      photo_path:   meta.avatar_url || meta.picture || null
    };
    const patch = {};
    if(data && !String(data.display_name||'').trim() && fromGoogle.display_name) patch.display_name = fromGoogle.display_name;
    if(data && !String(data.photo_path||'').trim()   && fromGoogle.photo_path)   patch.photo_path   = fromGoogle.photo_path;
    if(data && !String(data.email||'').trim() && user.email) patch.email = user.email;
    if(data && Object.keys(patch).length){
      await client.from('users').update(patch).eq('id', user.id);
      data = Object.assign({}, data, patch);
    }

    cached = data ? Object.assign({}, data, { authEmail: user.email }) : null;
    return cached;
  }

  function ready(p){
    return !!(p && String(p.display_name||'').trim() && String(p.email||'').trim());
  }

  // Uploads to the avatars bucket under the owner's id, which is what the
  // storage policy checks. The public URL is stored whole, so every existing
  // caller of GOAT.getPhotoUrl renders it unchanged — that helper passes an
  // absolute URL straight through.
  async function uploadAvatar(file, userId){
    if(!file) return null;
    if(file.size > MAX_BYTES) throw new Error('That image is over 5MB — pick a smaller one.');
    if(!/^image\//.test(file.type||'')) throw new Error('That file is not an image.');
    const ext = (file.name.split('.').pop()||'jpg').toLowerCase().replace(/[^a-z0-9]/g,'') || 'jpg';
    const path = `${userId}/avatar-${Date.now()}.${ext}`;
    const { error } = await sb().storage.from(AVATAR_BUCKET)
      .upload(path, file, { upsert: true, contentType: file.type });
    if(error) throw error;
    const { data } = sb().storage.from(AVATAR_BUCKET).getPublicUrl(path);
    return data?.publicUrl || null;
  }

  function openModal(profile, resolve){
    document.getElementById('profile-modal')?.remove();
    const p = profile || {};
    const photo = p.photo_path ? window.GOAT?.getPhotoUrl?.(p.photo_path) || p.photo_path : null;

    const modal = document.createElement('div');
    modal.id = 'profile-modal';
    modal.className = 'inline-topup';
    modal.innerHTML = `
      <div class="inline-topup-card" style="max-width:380px;text-align:left;position:relative">
        <button id="pf-close" style="position:absolute;right:14px;top:14px;background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer">✕</button>
        <h2 class="display" style="font-size:22px;margin-bottom:6px">One step before you back</h2>
        <p class="mono" style="font-size:12px;color:var(--muted);margin-bottom:16px">Your name goes on the board when you lead a contender, so it cannot be blank.</p>

        <div style="display:flex;gap:14px;align-items:center;margin-bottom:14px">
          <div id="pf-preview" style="width:64px;height:64px;border-radius:50%;overflow:hidden;flex:0 0 auto;background:var(--surface-3);border:1px solid var(--border);display:grid;place-items:center;color:var(--gold);font-family:Anton,sans-serif;font-size:20px">
            ${photo ? `<img src="${esc(photo)}" style="width:100%;height:100%;object-fit:cover">` : esc((p.display_name||'?').slice(0,2).toUpperCase())}
          </div>
          <div style="flex:1;min-width:0">
            <label for="pf-photo" style="font-size:11px;text-transform:uppercase;color:var(--muted);display:block;margin-bottom:4px">Photo <span style="text-transform:none;font-size:11px">— optional</span></label>
            <input id="pf-photo" type="file" accept="image/*" style="font-size:12px;color:var(--muted);max-width:100%">
          </div>
        </div>

        <div class="field" style="margin-bottom:10px">
          <label style="font-size:11px;text-transform:uppercase;color:var(--muted)">Name</label>
          <input id="pf-name" value="${esc(p.display_name||'')}" placeholder="e.g. Alex" style="width:100%;height:38px;border-radius:999px;border:1px solid var(--border);background:var(--bg);color:var(--ink);padding:0 12px;font-size:13px">
        </div>
        <div class="field" style="margin-bottom:10px">
          <label style="font-size:11px;text-transform:uppercase;color:var(--muted)">Email</label>
          <input id="pf-email" type="email" value="${esc(p.email||p.authEmail||'')}" placeholder="you@example.com" style="width:100%;height:38px;border-radius:999px;border:1px solid var(--border);background:var(--bg);color:var(--ink);padding:0 12px;font-size:13px">
        </div>

        <button id="pf-save" class="btn-primary" style="width:100%;margin-top:6px">Save and continue →</button>
        <div id="pf-msg" style="display:none;margin-top:10px;font-size:12px;text-align:center" class="mono"></div>
      </div>`;
    document.body.appendChild(modal);

    const msg = modal.querySelector('#pf-msg');
    function say(text, colour){ msg.style.display='block'; msg.style.color=colour; msg.textContent=text; }
    function close(ok){ modal.remove(); resolve(ok); }

    modal.addEventListener('click', e => { if(e.target === modal) close(false); });
    modal.querySelector('#pf-close').addEventListener('click', () => close(false));

    let pickedFile = null;
    modal.querySelector('#pf-photo').addEventListener('change', e => {
      pickedFile = e.target.files?.[0] || null;
      if(!pickedFile) return;
      const url = URL.createObjectURL(pickedFile);
      modal.querySelector('#pf-preview').innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover">`;
    });

    modal.querySelector('#pf-save').addEventListener('click', async () => {
      const name  = modal.querySelector('#pf-name').value.trim();
      const email = modal.querySelector('#pf-email').value.trim();
      if(!name)  return say('Enter the name you want on the board.', '#e55');
      if(!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return say('Enter a valid email.', '#e55');

      const btn = modal.querySelector('#pf-save');
      btn.disabled = true; say('Saving…', 'var(--gold)');
      try{
        const { data:{ user } } = await sb().auth.getUser();
        if(!user) throw new Error('Signed out — sign in again.');

        const patch = { display_name: name, email };
        // A photo is a bonus, never a blocker: if the upload fails the name and
        // email still save and the backer still gets to back.
        if(pickedFile){
          try { const url = await uploadAvatar(pickedFile, user.id); if(url) patch.photo_path = url; }
          catch(e){ console.warn('[profile] avatar upload failed:', e?.message || e); }
        }

        const { error } = await sb().from('users').upsert(Object.assign({ id: user.id }, patch));
        if(error) throw error;
        await load(true);
        close(true);
      }catch(e){
        btn.disabled = false;
        say(String(e?.message || e), '#e55');
      }
    });

    setTimeout(() => modal.querySelector('#pf-name')?.focus(), 50);
  }

  window.GoatProfile = {
    get: load,
    isReady: ready,

    // The one call the backing control makes. Resolves true when the account is
    // allowed to back — either it already was, or the form was just completed.
    // Resolves false if they closed it, in which case nothing should be spent.
    async require(){
      const client = sb(); if(!client) return false;
      const { data:{ user } } = await client.auth.getUser();
      if(!user){ window.Auth?.openAuthModal?.(); return false; }
      const profile = await load(true);
      if(ready(profile)) return true;
      return new Promise(resolve => openModal(profile || { authEmail: user.email }, resolve));
    },

    // Called when the database refuses a vote for a profile the page thought was
    // complete — a row changed under us, or the page was open a long time.
    async repair(){ cached = null; return this.require(); },

    open(){ return this.require(); }
  };
})();
