// api/fans.js — Public top fans leaderboard & stats
import { createClient } from '@supabase/supabase-js';
import { requireEnv, requireMethod, withHandler } from './_lib.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://orzcszqpnvicreqvpncu.supabase.co';

export default withHandler(async function handler(req, res){
  requireMethod(req, 'GET');

  // Read inside the handler: an unset key here would otherwise hand
  // createClient undefined and fail deep in the client with an opaque message.
  const { SUPABASE_SERVICE_ROLE_KEY } = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: users } = await supa
    .from('users')
    .select('id,display_name,is_anonymous,total_spent_cents,photo_path,social_handle,social_platform')
    .gt('total_spent_cents', 0)
    .order('total_spent_cents', { ascending: false })
    .limit(50);

  // Who each fan is actually backing. A leaderboard of names and numbers says
  // nothing about the rivalry; the contender they have put the most behind is
  // the interesting half, and it is one extra query for the whole page rather
  // than one per fan.
  const ids = (users || []).map(u => u.id);
  const backing = new Map();
  if (ids.length) {
    // Two plain reads rather than an embedded people(...). An embed returns null
    // for a row it cannot resolve and the fan then looks like they back nobody,
    // which is how a leaderboard ended up showing three fans with money down and
    // no contender beside them. Read the ids, then read the people.
    const { data: totals } = await supa
      .from('fan_totals')
      .select('user_id,person_id,total_cents')
      .in('user_id', ids)
      .gt('total_cents', 0)
      .order('total_cents', { ascending: false })
      .limit(5000);

    // Ordered by size, so the first row seen for a fan is their biggest bet.
    const best = new Map();
    for (const row of totals || []) {
      if (row?.person_id && !best.has(row.user_id)) best.set(row.user_id, row);
    }

    if (best.size) {
      const { data: people } = await supa
        .from('people')
        .select('id,name,slug,photo_path')
        .in('id', [...new Set([...best.values()].map(r => r.person_id))]);
      const byId = new Map((people || []).map(p => [p.id, p]));

      for (const [userId, row] of best) {
        const person = byId.get(row.person_id);
        if (!person) continue;
        backing.set(userId, {
          name: person.name,
          slug: person.slug,
          photo_path: person.photo_path,
          votes: Math.floor((row.total_cents || 0) / 100)
        });
      }
    }
  }

  const fans = (users || []).map(u => ({ ...u, backing: backing.get(u.id) || null }));

  res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=15');
  return res.status(200).json({ ok: true, fans });
});
