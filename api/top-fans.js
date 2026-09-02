// api/top-fans.js — the Greatest Fan of All Time for a set of contenders.
//
// This exists because the browser cannot answer the question. fan_totals is
// public, so a page can see THAT a contender has a fan; users carries a
// "self read" policy, so it cannot see WHO. Every attempt to name them from the
// page needed something installed first — a SECURITY DEFINER function, a public
// view — and each one is another file that has to be run before a face appears.
//
// This needs nothing run. It uses the service key on the server, the same way
// /api/fans already does, and answers with only what a public identity is:
// a name, a picture, a handle. No email, no balance, no country.
//
//   GET /api/top-fans?ids=<uuid>,<uuid>,…
//   → { ok: true, fans: { "<person id>": { display_name, photo_path, … } } }
//
// ── Why it reads bids and not only fan_totals ───────────────────────────────
//
// fan_totals is a cache. place_bid writes it alongside the bid, so it is right
// for every bid placed through the site as it stands. It is not the record:
// bids is. The two can part company, and have — data/demo-backing-remove.sql
// recomputes people.total_cents from bids but only deletes the seeded
// fan_totals rows, and any bid placed before place_bid started maintaining the
// cache never wrote one at all. The visible symptom is a contender showing real
// dollars with a crown instead of a face, which is what sent me here: the money
// was real, the fan was real, and the cache had no row to name them from.
//
// So the cache is used where it has an answer, and bids are summed for the
// contenders where it does not. That is a fallback, not a replacement — reading
// bids for every contender on every page load would be the wrong shape — and it
// means a face appears from the record itself even where the cache is stale.
// data/rebuild-fan-totals.sql repairs the cache so the leaderboards agree too.
import { createClient } from '@supabase/supabase-js';
import { requireEnv, requireMethod, withHandler, supabaseUrl } from './_lib.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The leader per contender, from the cache first and from the bids of whoever
// the cache missed second. Returns Map<person_id, { user_id, total_cents, src }>.
async function leadersFor(supa, ids){
  const lead = new Map();

  const { data: totals, error } = await supa
    .from('fan_totals')
    .select('person_id,user_id,total_cents')
    .in('person_id', ids)
    .gt('total_cents', 0)
    .order('total_cents', { ascending: false })
    .limit(5000);
  if (error) throw new Error(`fan_totals: ${error.message}`);

  // Biggest first, so the first row seen for a contender is their leader.
  for (const r of totals || []) {
    if (r.user_id && !lead.has(r.person_id)) {
      lead.set(r.person_id, { user_id: r.user_id, total_cents: r.total_cents, src: 'fan_totals' });
    }
  }

  const missing = ids.filter(id => !lead.has(id));
  if (missing.length) {
    const { data: bids } = await supa
      .from('bids')
      .select('person_id,user_id,amount_cents')
      .in('person_id', missing)
      .limit(20000);

    // Sum per (contender, backer), then keep the largest per contender.
    const sums = new Map();
    for (const b of bids || []) {
      if (!b.user_id) continue;
      const key = `${b.person_id}|${b.user_id}`;
      sums.set(key, (sums.get(key) || 0) + (b.amount_cents || 0));
    }
    for (const [key, cents] of sums) {
      if (cents <= 0) continue;
      const [personId, userId] = key.split('|');
      const cur = lead.get(personId);
      if (!cur || cents > cur.total_cents) {
        lead.set(personId, { user_id: userId, total_cents: cents, src: 'bids' });
      }
    }
  }

  return lead;
}

// Public identity only. Never email, balance or anything else on the row.
async function identities(supa, userIds){
  if (!userIds.length) return new Map();
  const { data } = await supa
    .from('users')
    .select('id,display_name,photo_path,social_handle,social_platform')
    .in('id', userIds);
  return new Map((data || []).map(u => [u.id, u]));
}

export default withHandler(async function handler(req, res){
  requireMethod(req, 'GET');

  // Anything that is not a uuid is dropped rather than passed to the database.
  const ids = String(req.query?.ids || '')
    .split(',').map(s => s.trim()).filter(s => UUID.test(s)).slice(0, 400);

  const { SUPABASE_SERVICE_ROLE_KEY } = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const supa = createClient(supabaseUrl(), SUPABASE_SERVICE_ROLE_KEY);

  // Called with no ids, it reports instead of answering: the contenders with the
  // most money on them, and the fan behind each. Open /api/top-fans in a browser
  // and the whole question — is this deployed, is there a backer to name, does
  // that backer have a name and a picture — is answered on one page, with no ids
  // to find first. `from` says whether the cache or the bids produced the fan;
  // 'bids' anywhere means fan_totals is stale and the rebuild is worth running.
  if (!ids.length) {
    const { data: top } = await supa.from('people')
      .select('id,name,total_cents').gt('total_cents', 0)
      .order('total_cents', { ascending: false }).limit(12);

    const topIds = (top || []).map(p => p.id);
    const lead = topIds.length ? await leadersFor(supa, topIds) : new Map();
    const byUser = await identities(supa, [...new Set([...lead.values()].map(r => r.user_id))]);

    const { count: cacheRows } = await supa.from('fan_totals').select('id', { count: 'exact', head: true });
    const { count: bidRows }   = await supa.from('bids').select('id', { count: 'exact', head: true });

    return res.status(200).json({
      ok: true,
      note: 'Diagnostic. Pass ?ids=<uuid>,<uuid> to use this normally.',
      fan_totals_rows: cacheRows ?? null,
      bid_rows: bidRows ?? null,
      contenders: (top || []).map(p => {
        const f = lead.get(p.id);
        const u = f ? (byUser.get(f.user_id) || {}) : null;
        return {
          contender: p.name,
          dollars: Math.floor((p.total_cents || 0) / 100),
          greatest_fan: u
            ? (u.display_name || '(signed in, but no display name set)')
            : (f ? '(backer has no users row)' : 'NO BACKER AT ALL — the crown is correct'),
          fan_dollars: f ? Math.floor(f.total_cents / 100) : 0,
          from: f ? f.src : null,
          has_photo: u ? Boolean(u.photo_path) : false,
          has_handle: u ? Boolean(u.social_handle) : false
        };
      })
    });
  }

  const lead = await leadersFor(supa, ids);
  if (!lead.size) return res.status(200).json({ ok: true, fans: {} });

  const byUser = await identities(supa, [...new Set([...lead.values()].map(r => r.user_id))]);

  const fans = {};
  for (const [personId, row] of lead) {
    const u = byUser.get(row.user_id) || {};
    fans[personId] = {
      user_id:         row.user_id,
      total_cents:     row.total_cents,
      display_name:    u.display_name    || null,
      photo_path:      u.photo_path      || null,
      social_handle:   u.social_handle   || null,
      social_platform: u.social_platform || null
    };
  }

  // Short cache: the crown changes when somebody backs, and a stale face for a
  // few seconds is better than this query on every card of every page load.
  res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');
  return res.status(200).json({ ok: true, fans });
});
