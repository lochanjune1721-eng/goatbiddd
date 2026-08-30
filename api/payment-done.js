import { createClient } from '@supabase/supabase-js';
import { HttpError, readJsonBody, requireEnv, requireMethod, unwrap, withHandler } from './_lib.js';

// Dodo webhook — confirm top-up, add to balance. Idempotent on dodo_payment_id.
export default withHandler(async function handler(req, res){
  requireMethod(req, 'POST');

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = requireEnv('SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY');

  // A malformed webhook payload is the sender's problem, not a crash: fall back
  // to an empty object so the lookups below just miss and return 404.
  let body;
  try { body = await readJsonBody(req); } catch { body = {}; }
  console.log('payment-done', JSON.stringify(body).slice(0, 3000));

  const dodoId = body.paymentId || body.payment_id || body.id || body.dodo_payment_id;
  const topupId = body.metadata?.topup_id || body.topup_id;
  const userId = body.metadata?.user_id || body.user_id;
  const amount = body.amount_cents || body.amount || body.total || 0;

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // find topup
  let topup = null;
  if (topupId) {
    topup = unwrap(await supa.from('topups').select('*').eq('id', topupId).maybeSingle(), 'lookup topup by id');
  } else if (dodoId) {
    topup = unwrap(await supa.from('topups').select('*').eq('dodo_payment_id', dodoId).maybeSingle(), 'lookup topup by payment id');
  }
  // fallback find pending for user
  if (!topup && userId) {
    topup = unwrap(
      await supa.from('topups').select('*').eq('user_id', userId).eq('status', 'pending').order('created_at', { ascending: false }).limit(1).maybeSingle(),
      'lookup pending topup'
    );
  }
  if (!topup) throw new HttpError(404, 'Topup not found');
  if (topup.status === 'confirmed') return res.status(200).json({ received: true, duplicate: true });

  const parsedAmount = Math.round(Number(amount));
  const cents = topup.amount_cents || (Number.isFinite(parsedAmount) ? parsedAmount : 0);

  // idempotent
  const { error: upErr } = await supa.from('topups').update({ status: 'confirmed', dodo_payment_id: dodoId || `dodo_${Date.now()}` }).eq('id', topup.id);
  if (upErr && !String(upErr.message || '').includes('duplicate')) throw new HttpError(500, `confirm topup: ${upErr.message || upErr}`);

  // add balance
  const user = unwrap(await supa.from('users').select('balance_cents').eq('id', topup.user_id).maybeSingle(), 'lookup user balance');
  unwrap(
    await supa.from('users').update({ balance_cents: (user?.balance_cents || 0) + cents }).eq('id', topup.user_id),
    'credit user balance'
  );
  return res.status(200).json({ received: true });
});
