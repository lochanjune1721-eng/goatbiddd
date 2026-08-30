import { createClient } from '@supabase/supabase-js';
import { HttpError, readJsonBody, requireEnv, requireMethod, unwrap, withHandler } from './_lib.js';

export default withHandler(async function handler(req, res){
  requireMethod(req, 'POST');

  const { ADMIN_PASSWORD } = requireEnv('ADMIN_PASSWORD');
  const body = await readJsonBody(req);
  const { password, action, id } = body;

  if (password !== ADMIN_PASSWORD) throw new HttpError(401, 'Unauthorized');
  if (!action) return res.status(200).json({ ok: true });

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = requireEnv('SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY');
  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // 30-min grace: list confirmed donations with no matching payment (donation_confirmed true, payment_confirmed false, created >30m ago)
  if (action === 'pending_donations') {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const entries = unwrap(
      await supa.from('entries').select('*').eq('donation_confirmed', true).eq('payment_confirmed', false).lt('last_bid_at', cutoff).order('last_bid_at', { ascending: false }).limit(50),
      'pending_donations'
    );
    return res.status(200).json({ entries });
  }
  if (action === 'approve_donation') {
    if (!id) throw new HttpError(400, 'Missing id');
    unwrap(await supa.from('entries').update({ status: 'live', payment_confirmed: true }).eq('id', id), 'approve_donation');
    return res.status(200).json({ ok: true });
  }
  if (action === 'reject') {
    if (!id) throw new HttpError(400, 'Missing id');
    unwrap(await supa.from('entries').update({ status: 'rejected' }).eq('id', id), 'reject');
    return res.status(200).json({ ok: true });
  }
  throw new HttpError(400, 'Unknown action');
});
