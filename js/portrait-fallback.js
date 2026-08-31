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
  const MAX_CALLS = 24;      // hard ceiling per page view — the homepage alone
                             // asks for ~100 contenders, and the old ceiling of
                             // 6 left everything past the 240th as initials

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

  async function fetchBatch(titles, size, attempt){
    const params = new URLSearchParams({
      action:'query', format:'json', origin:'*', formatversion:'2',
      prop:'pageimages', piprop:'thumbnail', pithumbsize:String(size),
      pilicense:'any', redirects:'1', titles:titles.join('|')
    });
    const res = await fetch(API + '?' + params.toString());
    if(!res.ok){
      // A single rate-limited batch used to abandon every remaining portrait
      // on the page. Back off once, then let the caller move on to the next
      // chunk instead of giving up on all of them.
      if((res.status === 429 || res.status >= 500) && !attempt){
        await new Promise(r=> setTimeout(r, 1200));
        return fetchBatch(titles, size, 1);
      }
      throw new Error('wikipedia ' + res.status);
    }
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
    let hdUrl = url;
    if(hdUrl.includes('upload.wikimedia.org') && /\/\d+px-/.test(hdUrl)){
      hdUrl = hdUrl.replace(/\/\d+px-/, '/800px-');
    }
    const size = parseInt(el.dataset.portraitSize, 10) || 400;
    const img = document.createElement('img');
    img.className = 'goat-photo';
    img.alt = el.dataset.portraitName || '';
    img.width = size; img.height = size;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';

    const clip = el.dataset.video || (window.PersonMedia ? window.PersonMedia.getVideo(el.dataset.portraitName, el.dataset.portraitSlug) : null);
    if(clip) {
      img.dataset.video = clip;
    }

    img.addEventListener('load', ()=>{
      // Drop the initials, keep the portrait, fade it in.
      for(const node of [...el.childNodes]) if(node !== img) el.removeChild(node);
      el.classList.add('has-portrait');
      el.dataset.portraitDone = '1';
      if(clip && window.VideoHover && window.VideoHover.scan) {
        window.VideoHover.scan(el.parentElement || el);
      }
    });
    img.addEventListener('error', ()=>{
      // If 800px fails, fallback to standard url
      if(img.src !== url && url) {
        img.src = url;
        return;
      }
      img.remove();
      el.dataset.portraitDone = 'error';
    });
    img.src = hdUrl;
    el.appendChild(img);
  }

  let inFlight = false;
  async function scan(root){
    const nodes = (root || document).querySelectorAll('[data-portrait-name]:not([data-portrait-done])');
    if(!nodes.length) return;

    // Look up the Wikipedia article title from the contender's wikipedia_url
    // (written into data-portrait), not the display name. They differ often —
    // stage names, accents, disambiguated titles — and querying the display
    // name is why so many contenders stayed as initials. The name is only the
    // fallback for a row with no wikipedia_url.
    const pending = new Map();
    for(const el of nodes){
      const title = el.dataset.portrait || el.dataset.portraitName;
      if(!title){ el.dataset.portraitDone = 'none'; continue; }
      const cached = readCache(title);
      if(cached !== undefined){
        apply(el, cached);
      } else {
        if(!pending.has(title)) pending.set(title, []);
        pending.get(title).push(el);
      }
    }

    if(!pending.size) return;

    inFlight = true;
    try {
      const titles = [...pending.keys()];
      const size = parseInt(nodes[0].dataset.portraitSize, 10) || 400;
      for(let i = 0; i < titles.length && i < BATCH * MAX_CALLS; i += BATCH){
        const chunk = titles.slice(i, i + BATCH);
        let found;
        try { found = await fetchBatch(chunk, Math.max(size * 2, 700)); }
        catch(e){ console.warn('portrait lookup failed for one batch, continuing', e); continue; }
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
  // can fill in.
  function photoHtml(person, size, opts){
    opts = opts || {};
    const name = (person && person.name) || '';
    const slug = (person && person.slug) || '';
    const clip = (person && person.video_path && window.GOAT && window.GOAT.getVideoUrl)
      ? window.GOAT.getVideoUrl(person.video_path)
      : ((window.PersonMedia) ? window.PersonMedia.getVideo(name, slug) : null);

    if(person && person.photo_path){
      return window.OptimizedImage.render({
        photoPath: person.photo_path,
        videoPath: person.video_path || clip,
        name: person.name,
        size,
        priority: opts.eager ? 'eager' : 'lazy',
        slug: person.slug
      });
    }

    const videoAttr = clip ? ' data-video="' + esc(clip) + '"' : '';
    const title = titleFor(person);

    // No stored photo. This used to render initials and wait for the batch
    // Wikipedia call below to fill them in — which depends on the visitor's
    // browser reaching Wikipedia, on CORS, and on not being rate-limited.
    //
    // api/img.js already resolves a portrait from a title server-side and the
    // result is cached at the edge, so ask it directly. scan() stays as the
    // second line of defence: if the function itself cannot be reached, the
    // onerror below hands the element back to it.
    if(title || name){
      const q = 'name=' + encodeURIComponent(name) +
                '&title=' + encodeURIComponent(title) +
                '&size=' + encodeURIComponent(size);
      return '<img src="/api/img?' + q + '" class="goat-photo" alt="' + esc(name) +
             '" width="' + size + '" height="' + size + '"' +
             (opts.eager ? ' fetchpriority="high" loading="eager"' : ' loading="lazy"') +
             ' decoding="async" referrerpolicy="no-referrer"' +
             ' data-portrait="' + esc(title) +
             '" data-portrait-size="' + size +
             '" data-portrait-slug="' + esc(slug) +
             '" data-portrait-name="' + esc(name) + '"' + videoAttr +
             ' onerror="window.onGoatPortraitError && window.onGoatPortraitError(this)">';
    }

    const initials = (window.GOAT && window.GOAT.initials)
      ? window.GOAT.initials(name)
      : (name.slice(0,2).toUpperCase() || '?');

    return '<div class="fallback" data-portrait="' + esc(title) +
           '" data-portrait-size="' + size +
           '" data-portrait-slug="' + esc(slug) +
           '" data-portrait-name="' + esc(name) + '"' + videoAttr + '>' + esc(initials) + '</div>';
  }

  // The server route was unreachable (not merely out of portraits — it answers
  // with an initials SVG in that case). Swap in the placeholder scan() knows
  // how to fill, and let the client-side lookup try.
  function onGoatPortraitError(img){
    if(!img || !img.parentElement) return;
    const d = img.dataset;
    const name = d.portraitName || '';
    const initials = (window.GOAT && window.GOAT.initials)
      ? window.GOAT.initials(name)
      : (name.slice(0,2).toUpperCase() || '?');

    const div = document.createElement('div');
    div.className = 'fallback';
    div.dataset.portrait = d.portrait || '';
    div.dataset.portraitSize = d.portraitSize || '';
    div.dataset.portraitSlug = d.portraitSlug || '';
    div.dataset.portraitName = name;
    if(d.video) div.dataset.video = d.video;
    div.textContent = initials;

    const parent = img.parentElement;
    parent.replaceChild(div, img);
    scan(parent);
  }
  window.onGoatPortraitError = onGoatPortraitError;

  window.PortraitFallback = { scan, titleFor, photoHtml, onGoatPortraitError };
})();
