// js/country-boards.js — country dimension.
//
// Boards live inside a country. data/boards/index.json lists the countries;
// data/boards/<CC>.json holds that country's boards and their ranked
// contenders. A visitor only ever downloads the one country they picked.
//
// This reads the shipped JSON, so country boards browse correctly before
// data/country-boards-seed.sql has been run. Once seeded they exist in the
// database as ordinary categories and can be voted on.
(function(){
  if(typeof window === 'undefined') return;

  const KEY = 'goat_country';
  const GLOBAL = 'GLOBAL';
  let indexPromise = null;
  const countryCache = new Map();

  // The index carries verified:true only after scripts/fix_country_boards.mjs
  // has assigned every contender to a board matching their actual occupation.
  // Without that stamp the raw export is unusable as rankings, so the picker
  // stays hidden rather than showing a tennis player atop Greatest Cricketer.
  async function meta(){
    if(!indexPromise){
      indexPromise = fetch('data/boards/index.json')
        .then(r=>{ if(!r.ok) throw new Error('country index ' + r.status); return r.json(); })
        .catch(e=>{ console.warn('country index unavailable', e); return { countries: [] }; });
    }
    return indexPromise;
  }
  async function verified(){ return !!(await meta()).verified; }
  async function countries(){
    const j = await meta();
    if(!j.verified) return [];
    return (j.countries || []).slice().sort((a,b)=> a.country.localeCompare(b.country));
  }

  async function load(code){
    if(!code || code === GLOBAL) return null;
    if(countryCache.has(code)) return countryCache.get(code);
    const p = fetch('data/boards/' + encodeURIComponent(code) + '.json')
      .then(r=>{ if(!r.ok) throw new Error('country ' + code + ' ' + r.status); return r.json(); })
      .catch(e=>{ console.warn('country boards unavailable', e); return null; });
    countryCache.set(code, p);
    return p;
  }

  // One board out of a country file, by its slug.
  async function board(code, slug){
    const c = await load(code);
    return c ? (c.boards || []).find(b=> b.slug === slug) || null : null;
  }

  // Find whichever country owns a board slug, using the code prefix the
  // builder writes into every slug ("br-greatest-brazilian-footballer").
  async function boardBySlug(slug){
    const code = String(slug || '').split('-')[0].toUpperCase();
    if(!code) return null;
    const b = await board(code, slug);
    return b ? { code, board: b } : null;
  }

  function remembered(){
    try { return localStorage.getItem(KEY) || GLOBAL; } catch(e){ return GLOBAL; }
  }
  function remember(code){
    try { code === GLOBAL ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, code); } catch(e){}
  }

  // Contenders are plain names in the JSON. Shape them like `people` rows so
  // the existing tile renderer and portrait lookup work unchanged.
  function asPeople(board, code){
    return (board.contenders || []).map((c,i)=>({
      id: 'cb-' + board.slug + '-' + i,
      slug: board.slug + '-' + String(c.name).toLowerCase().replace(/[^a-z0-9]+/g,'-'),
      name: c.name,
      photo_path: null,
      wikipedia_url: null,
      total_cents: 0,
      first_backed_at: null,
      category_id: 'cb-' + board.slug,
      country_code: code
    }));
  }

  window.CountryBoards = { GLOBAL, countries, verified, load, board, boardBySlug, remembered, remember, asPeople };
})();
