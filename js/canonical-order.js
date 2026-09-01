// js/canonical-order.js — canonical board ordering.
//
// Every board is a top 20. The ranked list lives in data/canonical-top20.json,
// generated from data/goat_lol_147_categories_top20.csv (147 categories x 20).
//
// Votes still decide the board: money always outranks the canonical list. The
// canonical rank is the tiebreak, which is what orders a board while every
// contender is still on zero — otherwise the order is whatever the database
// happens to return.
(function(){
  if(typeof window === 'undefined') return;

  const SOURCE = 'data/canonical-top20.json';
  let loading = null, index = null;

  // Fold case, accents and punctuation so "Pelé" matches "Pele".
  function norm(s){
    return String(s == null ? '' : s)
      .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .replace(/[^a-z0-9]+/g,' ').trim();
  }

  async function load(){
    if(index) return index;
    if(loading) return loading;
    loading = (async ()=>{
      const res = await fetch(SOURCE);
      if(!res.ok) throw new Error('canonical list ' + res.status);
      const raw = await res.json();
      const bySlug = new Map(), byName = new Map();
      for(const key of Object.keys(raw)){
        const entry = raw[key];
        bySlug.set(key, entry);
        for(const s of entry.slugs || []) if(!bySlug.has(s)) bySlug.set(s, entry);
        byName.set(norm(entry.name), entry);
        // also index the bare noun, so "Footballers" finds "Greatest Footballer"
        byName.set(norm(String(entry.name).replace(/^greatest\s+/i,'')), entry);
      }
      index = { bySlug, byName, all:raw };
      return index;
    })();
    return loading;
  }

  // Find the canonical list for a DB category row. Returns null when the
  // category is not in the canonical set, in which case callers must leave the
  // existing order alone rather than guessing.
  async function listFor(cat){
    if(!cat) return null;
    let idx;
    try { idx = await load(); } catch(e){ console.warn('canonical list unavailable', e); return null; }
    const hit = (cat.slug && idx.bySlug.get(cat.slug))
      || (cat.name && idx.byName.get(norm(cat.name)))
      || (cat.name && idx.byName.get(norm(String(cat.name).replace(/^greatest\s+/i,''))));
    return hit ? hit.top20 : null;
  }

  // Votes first, then canonical rank, then who got there earliest.
  function order(people, top20){
    if(!Array.isArray(people) || !people.length) return people || [];
    const rank = new Map();
    (top20 || []).forEach((n,i)=> rank.set(norm(n), i));
    const rankOf = p => rank.has(norm(p.name)) ? rank.get(norm(p.name)) : Number.MAX_SAFE_INTEGER;
    const when = p => p.first_backed_at ? Date.parse(p.first_backed_at) : Infinity;
    return people.slice().sort((a,b)=>{
      const av = a.total_cents||0, bv = b.total_cents||0;
      if(av !== bv) return bv - av;
      const ar = rankOf(a), br = rankOf(b);
      if(ar !== br) return ar - br;
      const at = when(a), bt = when(b);
      if(at !== bt) return at - bt;
      return String(a.name||'').localeCompare(String(b.name||''));
    });
  }

  // Anyone outside the canonical 20 who has never been backed is filler from
  // seeding and should not take a slot. Contenders with votes are always kept:
  // somebody paid for them, and a paid entry must never silently vanish.
  function keepActual(people, top20){
    const canon = new Set((top20 || []).map(norm));
    return (people || []).filter(p => canon.has(norm(p.name)) || (p.total_cents||0) > 0);
  }

  // Convenience: resolve + filter + order + trim in one call.
  async function apply(people, cat, size){
    // A board carrying seed_rank has an explicit editorial order in the
    // database, set by data/top-100-battles.sql. That beats this bundled JSON,
    // which predates it and covers a different set of boards — without this,
    // a seeded board whose NAME happens to match an old one ("Greatest
    // Footballer" against "Footballers") would be re-sorted by the old ranking
    // and, worse, have every contender outside the old top 20 filtered out.
    if (Array.isArray(people) && people.some(p => p && p.seed_rank != null)) {
      const sorted = people.slice().sort((a,b)=>{
        const money = (b.total_cents||0) - (a.total_cents||0);
        if(money) return money;
        const at = a.first_backed_at ? Date.parse(a.first_backed_at) : Infinity;
        const bt = b.first_backed_at ? Date.parse(b.first_backed_at) : Infinity;
        if(at !== bt) return at - bt;
        return (a.seed_rank ?? Infinity) - (b.seed_rank ?? Infinity);
      });
      return size ? sorted.slice(0, size) : sorted;
    }

    const top20 = await listFor(cat);
    if(!top20) return size ? (people||[]).slice(0, size) : (people||[]);
    const sorted = order(keepActual(people, top20), top20);
    return size ? sorted.slice(0, size) : sorted;
  }

  window.CanonicalOrder = { listFor, order, apply, keepActual, norm };
})();
