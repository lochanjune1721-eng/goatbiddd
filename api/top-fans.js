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
import { createClient } from '@supabase/supabase-js';
import { requireEnv, requireMethod, withHandler, supabaseUrl } from './_lib.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default withHandler(async function handler(req, res){
  requireMethod(req, 'GET');

  // Anything that is not a uuid is dropped rather than passed to the database.
  const ids = String(req.query?.ids || '')
    .split(',').map(s => s.trim()).filter(s => UUID.test(s)).slice(0, 400);

  if (!ids.length) return res.status(200).json({ ok: true, fans: {} });

  const { SUPABASE_SERVICE_ROLE_KEY } = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const supa = createClient(supabaseUrl(), SUPABASE_SERVICE_ROLE_KEY);

  // Biggest first, so the first row seen for a contender is their leader.
  const { data: totals, error } = await supa
    .from('fan_totals')
    .select('person_id,user_id,total_cents')
    .in('person_id', ids)
    .gt('total_cents', 0)
    .order('total_cents', { ascending: false })
    .limit(5000);
  if (error) throw new Error(`fan_totals: ${error.message}`);

  const top = new Map();
  for (const r of totals || []) if (!top.has(r.person_id)) top.set(r.person_id, r);
  if (!top.size) return res.status(200).json({ ok: true, fans: {} });

  const { data: people } = await supa
    .from('users')
    .select('id,display_name,photo_path,social_handle,social_platform')
    .in('id', [...new Set([...top.values()].map(r => r.user_id))]);

  const byUser = new Map((people || []).map(u => [u.id, u]));

  const fans = {};
  for (const [personId, row] of top) {
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
