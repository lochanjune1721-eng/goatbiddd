// js/portrait-fallback.js — runtime portrait resolver.
//
// Most contenders were seeded with photo_path NULL (see data/seed-people.sql),
// so their cards fall back to initials. Rather than leave the boards bare,
// look the portrait up on Wikipedia at view time and cache it in localStorage.
// Backfilling photo_path with scripts/bulk_wikimedia_resolver.mjs makes this a
// no-op — nothing here runs for a contender that already has a photo.
(function(){
  if(typeof window === 'undefined') return;

  const CACHE_KEY = 'goat_portraits_v1';
  const TTL = 14 * 24 * 60 * 60 * 1000;
  const API = 'https://en.wikipedia.org/w/api.php';
  const BATCH = 40;          // the pageimages API takes up to 50 titles per call
  const MAX_CALLS = 6;       // hard ceiling per page view

  let cache = {};
  try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {}; } catch(e) { cache = {}; }

  let saveTimer = null;
  function persist(){
    clearTimeout(saveTimer);
    saveTimer = setTimeout(()=>{
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); }
      catch(e){ cache = {}; try{ localStorage.removeItem(CACHE_KEY); }catch(_){} }
    }, 500);
  }

  function readCache(title){
    const hit = cache[title];
    if(!hit) return undefined;
    if(Date.now() - hit.t > TTL){ delete cache[title]; return undefined; }
    return hit.u;   // string URL, or null meaning "Wikipedia has no image for this"
  }

  // Prefer the exact article the DB points at; fall back to the display name.
  function titleFor(person){
    const m = /\/wiki\/([^#?]+)/.exec(person && person.wikipedia_url || '');
    if(m){
      try { return decodeURIComponent(m[1]).replace(/_/g, ' '); }
      catch(e){ return m[1].replace(/_/g, ' '); }
    }
    return (person && person.name) || '';
  }

  async function fetchBatch(titles, size){
    const params = new URLSearchParams({
      action:'query', format:'json', origin:'*', formatversion:'2',
      prop:'pageimages', piprop:'thumbnail', pithumbsize:String(size),
      pilicense:'any', redirects:'1', titles:titles.join('|')
    });
    const res = await fetch(API + '?' + params.toString());
    if(!res.ok) throw new Error('wikipedia ' + res.status);
    const j = await res.json();

    // Wikipedia normalises and follows redirects, so map the title it answers
    // with back to the one we asked for.
    const alias = {};
    ((j.query && j.query.normalized) || []).forEach(n=> alias[n.to] = n.from);
    ((j.query && j.query.redirects) || []).forEach(r=> alias[r.to] = alias[r.from] || r.from);

    const out = {};
    ((j.query && j.query.pages) || []).forEach(pg=>{
      const asked = alias[pg.title] || pg.title;
      out[asked] = (pg.thumbnail && pg.thumbnail.source) || null;
    });
    titles.forEach(t=>{ if(!(t in out)) out[t] = null; });
    return out;
  }

  function apply(el, url){
    if(!url){ el.dataset.portraitDone = 'none'; return; }
    const size = parseInt(el.dataset.portraitSize, 10) || 300;
    const img = document.createElement('img');
    img.className = 'goat-photo';
    img.alt = el.dataset.portraitName || '';
    img.width = size; img.height = size;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('load', ()=>{
      // Drop the initials, keep the portrait, fade it in.
      for(const node of [...el.childNodes]) if(node !== img) el.removeChild(node);
      el.classList.add('has-portrait');
      el.dataset.portraitDone = '1';
    });
    img.addEventListener('error', ()=>{
      img.remove();
      el.dataset.portraitDone = 'error';
    });
    img.src = url;
    // The image must be IN the document before it will load: a detached
    // <img loading="lazy"> is deferred forever, because the browser has no box
    // to test against the viewport. It sits at opacity 0 over the initials
    // until it decodes, so nothing flashes and lazy loading still applies.
    el.appendChild(img);
    el.dataset.portraitDone = 'loading';
  }

  let inFlight = false;
  async function scan(root){
    if(inFlight) return;
    const scope = root || document;
    const nodes = [...scope.querySelectorAll('[data-portrait]')]
      .filter(el=> !el.dataset.portraitDone && el.dataset.portrait);
    if(!nodes.length) return;

    // Serve whatever the cache already knows before touching the network.
    const pending = new Map();
    for(const el of nodes){
      const title = el.dataset.portrait;
      const hit = readCache(title);
      if(hit !== undefined){ apply(el, hit); continue; }
      if(!pending.has(title)) pending.set(title, []);
      pending.get(title).push(el);
    }
    if(!pending.size) return;

    inFlight = true;
    try {
      const titles = [...pending.keys()];
      const size = parseInt(nodes[0].dataset.portraitSize, 10) || 400;
      for(let i = 0; i < titles.length && i < BATCH * MAX_CALLS; i += BATCH){
        const chunk = titles.slice(i, i + BATCH);
        let found;
        try { found = await fetchBatch(chunk, Math.max(size, 320)); }
        catch(e){ console.warn('portrait lookup failed', e); break; }
        for(const t of chunk){
          const url = found[t] || null;
          cache[t] = { u:url, t:Date.now() };
          (pending.get(t) || []).forEach(el=> apply(el, url));
        }
        persist();
      }
    } finally { inFlight = false; }
  }

  function esc(t){
    return String(t == null ? '' : t).replace(/[&<>"']/g, c=> ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  }

  // Single decision point for every contender portrait on the site: use the
  // stored photo when there is one, otherwise emit a placeholder that scan()
  // can fill in. Previously a null photo_path still produced an <img> pointing
  // at an empty storage path, which cost a guaranteed 404 per contender.
  function photoHtml(person, size, opts){
    opts = opts || {};
    if(person && person.photo_path){
      return window.OptimizedImage.render({
        photoPath: person.photo_path, videoPath: person.video_path,
        name: person.name, size,
        priority: opts.eager ? 'eager' : 'lazy', slug: person.slug
      });
    }
    const name = (person && person.name) || '';
    const initials = (window.GOAT && window.GOAT.initials)
      ? window.GOAT.initials(name)
      : (name.slice(0,2).toUpperCase() || '?');
    return '<div class="fallback" data-portrait="' + esc(titleFor(person)) +
           '" data-portrait-size="' + size +
           '" data-portrait-name="' + esc(name) + '">' + esc(initials) + '</div>';
  }

  window.PortraitFallback = { scan, titleFor, photoHtml };
})();
