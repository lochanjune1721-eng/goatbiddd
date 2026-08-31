// api/uropay-confirm.js — called by the wallet when UroPay sends the payer back.
//
// Confirms immediately so the votes appear while they are still looking at the
// page. The webhook settles the same order independently; whichever arrives
// first wins and the other is a no-op.
import { createClient } from '@supabase/supabase-js';
import { HttpError, readJsonBody, requireMethod, requireEnv, withHandler } from './_lib.js';
import { settleUroPayOrder } from './_uropay-settle.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default withHandler(async function handler(req, res){
  requireMethod(req, 'POST');

  const { topupId } = await readJsonBody(req);
  if (!topupId || !UUID.test(String(topupId))) throw new HttpError(400, 'Missing topupId');

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = requireEnv('SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY');
  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) throw new HttpError(401, 'Sign in to finish your top-up');
  const { data: authData } = await supa.auth.getUser(token);
  const uid = authData?.user?.id;
  if (!uid) throw new HttpError(401, 'Your session has expired — sign in again');

  const { data: topup } = await supa.from('topups')
    .select('id,user_id,provider_order_id,status').eq('id', topupId).maybeSingle();
  if (!topup) throw new HttpError(404, 'That top-up could not be found');
  if (topup.user_id !== uid) throw new HttpError(403, 'That payment belongs to a different account');
  if (!topup.provider_order_id) throw new HttpError(409, 'That top-up never reached UroPay');

  const result = await settleUroPayOrder(supa, {
    orderId: topup.provider_order_id,
    topupId: topup.id,
    requireUserId: uid,
    label: 'uropay-confirm'
  });

  if (!result.settled) {
    if (result.pending) {
      return res.status(202).json({ ok: false, pending: true, message: 'UroPay has not confirmed this payment yet. Your votes will appear as soon as it clears.' });
    }
    throw new HttpError(402, `Payment not completed: ${result.reason}. Nothing has been charged.`);
  }

  const { data: user } = await supa.from('users').select('balance_cents').eq('id', uid).maybeSingle();
  return res.status(200).json({
    ok: true,
    duplicate: !!result.duplicate,
    credited: result.credited ?? 0,
    newBalance: user?.balance_cents ?? null
  });
});
