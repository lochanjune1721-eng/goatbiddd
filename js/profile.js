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
      .select('id,email,display_name,photo_path,country,social_handle,social_platform').eq('id', user.id).maybeSingle();

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

  // Two shapes of the same form. 'gate' is what stands between a backer and
  // their first vote: name and email, nothing else, because anything more is a
  // toll booth. 'edit' is the profile they came to change on purpose, so it
  // carries everything the site knows about them.
  function openModal(profile, resolve, mode){
    document.getElementById('profile-modal')?.remove();
    const p = profile || {};
    const full = mode === 'edit';
    const photo = p.photo_path ? window.GOAT?.getPhotoUrl?.(p.photo_path) || p.photo_path : null;
    const initials = (p.display_name || '?').trim().slice(0,2).toUpperCase();

    const modal = document.createElement('div');
    modal.id = 'profile-modal';
    modal.className = 'inline-topup';
    modal.innerHTML = `
      <div class="inline-topup-card" style="max-width:400px;text-align:left;position:relative;max-height:88vh;overflow-y:auto">
        <button id="pf-close" style="position:absolute;right:14px;top:14px;background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer">✕</button>
        <h2 class="display" style="font-size:22px;margin-bottom:6px">${full ? 'Your profile' : 'One step before you back'}</h2>
        <p class="mono" style="font-size:12px;color:var(--muted);margin-bottom:16px">
          ${full ? 'This is what other fans see when you lead a contender.'
                 : 'Your name goes on the board when you lead a contender, so it cannot be blank.'}</p>

        <div style="display:flex;gap:14px;align-items:center;margin-bottom:14px">
          <div id="pf-preview" style="width:64px;height:64px;border-radius:50%;overflow:hidden;flex:0 0 auto;background:var(--surface-3);border:1px solid var(--border);display:grid;place-items:center;color:var(--gold);font-family:Anton,sans-serif;font-size:20px">
            ${photo ? `<img src="${esc(photo)}" style="width:100%;height:100%;object-fit:cover">` : esc(initials)}
          </div>
          <div style="flex:1;min-width:0">
            <label for="pf-photo" style="font-size:11px;text-transform:uppercase;color:var(--muted);display:block;margin-bottom:4px">Photo <span style="text-transform:none">— optional</span></label>
            <input id="pf-photo" type="file" accept="image/*" style="font-size:12px;color:var(--muted);max-width:100%">
          </div>
        </div>

        ${field('pf-name', 'Name', esc(p.display_name||''), 'e.g. Alex')}
        ${field('pf-email', 'Email', esc(p.email||p.authEmail||''), 'you@example.com', 'email')}
        ${full ? `
        <div class="field" style="margin-bottom:10px">
          <label style="font-size:11px;text-transform:uppercase;color:var(--muted)">Country <span style="text-transform:none">— decides how you pay</span></label>
          <select id="pf-country" style="width:100%;height:38px;border-radius:999px;border:1px solid var(--border);background:var(--bg);color:var(--ink);padding:0 12px;font-size:13px"></select>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:10px">
          <div class="field" style="flex:0 0 118px">
            <label style="font-size:11px;text-transform:uppercase;color:var(--muted)">Social</label>
            <select id="pf-platform" style="width:100%;height:38px;border-radius:999px;border:1px solid var(--border);background:var(--bg);color:var(--ink);padding:0 10px;font-size:13px">
              ${['x','instagram','tiktok','youtube','other'].map(v =>
                `<option value="${v}"${p.social_platform===v?' selected':''}>${v === 'x' ? 'X' : v[0].toUpperCase()+v.slice(1)}</option>`).join('')}
            </select>
          </div>
          <div class="field" style="flex:1;min-width:0">
            <label style="font-size:11px;text-transform:uppercase;color:var(--muted)">Handle</label>
            <input id="pf-handle" value="${esc(p.social_handle||'')}" placeholder="@you" style="width:100%;height:38px;border-radius:999px;border:1px solid var(--border);background:var(--bg);color:var(--ink);padding:0 12px;font-size:13px">
          </div>
        </div>
        <p style="font-size:11.5px;color:var(--muted);line-height:1.4;margin:12px 0 2px">
          Everything here is public. Your name and picture appear on every contender you
          lead, and your handle is how people find you.
        </p>` : ''}

        <button id="pf-save" class="btn-primary" style="width:100%;margin-top:8px">${full ? 'Save' : 'Save and continue →'}</button>
        <div id="pf-msg" style="display:none;margin-top:10px;font-size:12px;text-align:center" class="mono"></div>
      </div>`;
    document.body.appendChild(modal);

    if(full){
      const sel = modal.querySelector('#pf-country');
      if(sel && window.countryOptions) sel.innerHTML = window.countryOptions(p.country || null);
    }

    const msg = modal.querySelector('#pf-msg');
    function say(text, colour){ msg.style.display='block'; msg.style.color=colour; msg.textContent=text; }
    function close(ok){ modal.remove(); if(typeof resolve === 'function') resolve(ok); }

    modal.addEventListener('click', e => { if(e.target === modal) close(false); });
    modal.querySelector('#pf-close').addEventListener('click', () => close(false));

    let pickedFile = null;
    modal.querySelector('#pf-photo').addEventListener('change', e => {
      pickedFile = e.target.files?.[0] || null;
      if(!pickedFile) return;
      modal.querySelector('#pf-preview').innerHTML =
        `<img src="${URL.createObjectURL(pickedFile)}" style="width:100%;height:100%;object-fit:cover">`;
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
        if(full){
          const c = modal.querySelector('#pf-country')?.value || '';
          if(/^[A-Z]{2}$/.test(c)) patch.country = c;
          const handle = modal.querySelector('#pf-handle').value.trim().replace(/^@+/, '');
          patch.social_handle = handle || null;
          patch.social_platform = handle ? (modal.querySelector('#pf-platform').value || 'x') : null;
        }
        // A photo is a bonus, never a blocker: a failed upload still saves the
        // name and email rather than losing the whole form. But it is SAID.
        // This used to console.warn and close, so a picture that never uploaded
        // looked exactly like one that did — the form closed, the name was
        // saved, and the face silently was not.
        let photoError = null;
        if(pickedFile){
          try {
            const url = await uploadAvatar(pickedFile, user.id);
            if(url) patch.photo_path = url; else photoError = 'the upload returned no URL';
          } catch(e){
            photoError = String(e?.message || e);
            // The overwhelmingly likely cause, and it has a fix with a name.
            if(/bucket|not found|does not exist|404/i.test(photoError))
              photoError = 'the avatars bucket does not exist yet — run supabase-profile-gate.sql';
            else if(/row-level security|policy|permission|403|401/i.test(photoError))
              photoError = 'storage refused the upload — run supabase-profile-gate.sql, which adds the policy';
          }
        }

        const { error } = await sb().from('users').upsert(Object.assign({ id: user.id }, patch));
        if(error) throw error;
        await load(true);
        if(window.refreshBalance) window.refreshBalance();

        // Held open on a photo failure so the reason is read rather than
        // flashed past.
        if(photoError){
          btn.disabled = false;
          return say('Saved your name and email. Photo not saved: ' + photoError, '#e55');
        }
        close(true);
      }catch(e){
        btn.disabled = false;
        say(String(e?.message || e), '#e55');
      }
    });

    setTimeout(() => modal.querySelector('#pf-name')?.focus(), 50);
  }

  function field(id, label, value, placeholder, type){
    return `<div class="field" style="margin-bottom:10px">
      <label style="font-size:11px;text-transform:uppercase;color:var(--muted)">${label}</label>
      <input id="${id}" ${type?`type="${type}"`:''} value="${value}" placeholder="${placeholder}"
        style="width:100%;height:38px;border-radius:999px;border:1px solid var(--border);background:var(--bg);color:var(--ink);padding:0 12px;font-size:13px">
    </div>`;
  }

  window.GoatProfile = {
    get: load,
    isReady: ready,

    // The one call the backing control makes. Resolves true when the account is
    // allowed to back — either it already was, or the form was just completed.
    // Resolves false if they closed it, in which case nothing should be spent.
    // Opened from the avatar in the topbar: the whole profile, on purpose.
    async edit(){
      const client = sb(); if(!client) return false;
      const { data:{ user } } = await client.auth.getUser();
      if(!user){ window.Auth?.openAuthModal?.(); return false; }
      const profile = await load(true);
      return new Promise(resolve => openModal(profile || { authEmail: user.email }, resolve, 'edit'));
    },

    async require(){
      const client = sb(); if(!client) return false;
      const { data:{ user } } = await client.auth.getUser();
      if(!user){ window.Auth?.openAuthModal?.(); return false; }
      const profile = await load(true);
      if(ready(profile)) return true;
      return new Promise(resolve => openModal(profile || { authEmail: user.email }, resolve, 'gate'));
    },

    // Called when the database refuses a vote for a profile the page thought was
    // complete — a row changed under us, or the page was open a long time.
    async repair(){ cached = null; return this.require(); },

    open(){ return this.edit(); }
  };
})();
