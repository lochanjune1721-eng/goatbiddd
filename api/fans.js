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
    const { data: totals } = await supa
      .from('fan_totals')
      .select('user_id,total_cents,people(name,slug,photo_path)')
      .in('user_id', ids)
      .order('total_cents', { ascending: false });

    // Ordered by size, so the first row seen for a fan is their biggest bet.
    for (const row of totals || []) {
      if (!row?.people || backing.has(row.user_id)) continue;
      backing.set(row.user_id, {
        name: row.people.name,
        slug: row.people.slug,
        photo_path: row.people.photo_path,
        votes: Math.floor((row.total_cents || 0) / 100)
      });
    }
  }

  const fans = (users || []).map(u => ({ ...u, backing: backing.get(u.id) || null }));

  res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=15');
  return res.status(200).json({ ok: true, fans });
});
