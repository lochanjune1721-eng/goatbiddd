// api/uropay-checkout.js — opens a UroPay (UPI) order for a wallet top-up.
//
// Mirrors api/checkout.js: this route moves no money. It records what is owed
// and returns the URL to send the payer to. Credit is granted later, and only
// against an order UroPay itself confirms as PAID.
import { createClient } from '@supabase/supabase-js';
import { HttpError, readJsonBody, requireMethod, requireEnv, withHandler } from './_lib.js';
import { createOrder, rupeesForVotes, isConfigured } from './_uropay.js';

export default withHandler(async function handler(req, res){
  requireMethod(req, 'POST');

  if (!isConfigured()) throw new HttpError(503, 'UPI top-ups are not configured yet. Nothing has been charged.');

  const body = await readJsonBody(req);
  const { userId, amountCents, amount_cents, returnTo } = body;
  const cents = Number(amountCents ?? amount_cents);
  if (!Number.isInteger(cents) || cents < 100) throw new HttpError(400, 'Minimum top-up is $1 (1 vote)');
  if (cents > 500000) throw new HttpError(400, 'Maximum top-up is $5,000');

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = requireEnv('SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY');
  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  let uid = userId;
  if (req.headers.authorization) {
    const token = req.headers.authorization.replace('Bearer ', '');
    const { data } = await supa.auth.getUser(token);
    if (data?.user) uid = data.user.id;
  }
  if (!uid) throw new HttpError(401, 'Sign in before topping up');

  const votes = cents / 100;
  const rupees = rupeesForVotes(votes);
  const siteUrl = process.env.SITE_URL || 'https://www.thetruegoat.com';

  // The pending row is the record of what was asked for, in both currencies:
  // amount_cents is the votes to grant, provider_amount is the rupees UroPay
  // must actually collect before any of them are granted.
  const { data: pending, error: pendingErr } = await supa
    .from('topups')
    .insert({
      user_id: uid,
      amount_cents: cents,
      status: 'pending',
      provider: 'uropay',
      provider_amount: rupees,
      provider_currency: 'INR'
    })
    .select('id')
    .single();
  if (pendingErr) throw new HttpError(500, `Could not open a top-up: ${pendingErr.message}`);
  const topupId = pending.id;

  // UroPay does not document any parameters on the return URL, so carry our own
  // id rather than depending on one being appended.
  const returnQuery = new URLSearchParams({ uropay: 'return', topup_id: topupId });
  if (returnTo) returnQuery.set('returnTo', returnTo);

  let order;
  try {
    order = await createOrder({
      // tenantOrderRef is UroPay's idempotency key. Using the topup uuid makes
      // a retried create return the same order rather than opening a second.
      tenantOrderRef: topupId,
      amount: rupees,
      currency: 'INR',
      paymentMethods: ['upi'],
      returnUrl: `${siteUrl}/wallet?${returnQuery.toString()}`,
      webhookUrl: `${siteUrl}/api/uropay-webhook`,
      metaData: { topup_id: topupId, user_id: String(uid).slice(0, 100) }
    });
  } catch (err) {
    await supa.from('topups').update({ status: 'failed' }).eq('id', topupId);
    throw err;
  }

  if (!order?.openUrl) {
    console.error('[uropay-checkout] order had no openUrl:', JSON.stringify(order));
    throw new HttpError(502, 'UroPay did not return a checkout link. Nothing has been charged.');
  }

  await supa.from('topups').update({ provider_order_id: order.id }).eq('id', topupId);

  return res.status(200).json({ ok: true, url: order.openUrl, orderId: order.id, topupId, amountInr: rupees });
});
