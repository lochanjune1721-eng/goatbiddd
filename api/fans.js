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

  res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=15');
  return res.status(200).json({ ok: true, fans: users || [] });
});
