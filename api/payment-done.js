import { createClient } from '@supabase/supabase-js';
import { HttpError, readJsonBody, requireEnv, requireMethod, unwrap, withHandler } from './_lib.js';

// Dodo Payments webhook — confirm top-up, add credit to user's wallet. Idempotent.
export default withHandler(async function handler(req, res){
  requireMethod(req, 'POST');

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = requireEnv('SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY');

  let body;
  try { body = await readJsonBody(req); } catch { body = {}; }
  console.log('[payment-done] webhook received:', JSON.stringify(body).slice(0, 3000));

  // Extract payment details from Dodo payload (support both root and nested data)
  const data = body.data || body;
  const dodoId = data.payment_id || data.paymentId || data.id || data.dodo_payment_id || body.payment_id;
  const metadata = data.metadata || body.metadata || {};
  const topupId = metadata.topup_id || data.topup_id;
  const userId = metadata.user_id || data.user_id || data.customer?.customer_id;
  const amount = metadata.amount_cents || data.total_amount || data.amount_cents || data.amount || 0;

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // 1. Find the topup record
  let topup = null;
  if (topupId) {
    const { data: t } = await supa.from('topups').select('*').eq('id', topupId).maybeSingle();
    topup = t;
  }
  if (!topup && dodoId) {
    const { data: t } = await supa.from('topups').select('*').eq('dodo_payment_id', dodoId).maybeSingle();
    topup = t;
  }
  if (!topup && userId) {
    const { data: t } = await supa.from('topups').select('*').eq('user_id', userId).eq('status', 'pending').order('created_at', { ascending: false }).limit(1).maybeSingle();
    topup = t;
  }

  const parsedAmount = Math.round(Number(amount));
  const cents = (topup?.amount_cents) || (Number.isFinite(parsedAmount) && parsedAmount > 0 ? parsedAmount : 500);
  const targetUserId = topup?.user_id || userId;

  if (!targetUserId) {
    console.warn('[payment-done] Missing user id for webhook payload');
    return res.status(200).json({ received: true, warning: 'Missing user id' });
  }

  if (topup && topup.status === 'confirmed') {
    return res.status(200).json({ received: true, duplicate: true });
  }

  // 2. Mark confirmed in topups table
  if (topup) {
    await supa.from('topups').update({ status: 'confirmed', dodo_payment_id: dodoId || `dodo_${Date.now()}` }).eq('id', topup.id);
  } else {
    await supa.from('topups').insert({
      id: topupId || `topup_${Date.now()}`,
      user_id: targetUserId,
      amount_cents: cents,
      dodo_payment_id: dodoId || `dodo_${Date.now()}`,
      status: 'confirmed'
    });
  }

  // 3. Credit user's wallet balance
  const { data: user } = await supa.from('users').select('balance_cents').eq('id', targetUserId).maybeSingle();
  const newBalance = (user?.balance_cents || 0) + cents;
  await supa.from('users').update({ balance_cents: newBalance }).eq('id', targetUserId);

  console.log(`[payment-done] Successfully credited ${cents} cents (${cents/100} votes) to user ${targetUserId}. New balance: ${newBalance}`);
  return res.status(200).json({ received: true, credited: cents, newBalance });
});
