// api/checkout.js — opens a PayPal order for a wallet top-up.
//
// This route never moves money. It records what is owed and hands back the
// PayPal URL to send the payer to; credit is only ever granted later, by
// api/paypal-capture.js or the webhook, and only against a completed capture.
import { createClient } from '@supabase/supabase-js';
import { HttpError, readJsonBody, requireMethod, requireEnv, withHandler, supabaseUrl } from './_lib.js';
import { payPalFetch, toPayPalAmount } from './_paypal.js';

export default withHandler(async function handler(req, res){
  requireMethod(req, 'POST');

  const body = await readJsonBody(req);
  const { userId, amountCents, amount_cents, returnTo, email } = body;
  const cents = Number(amountCents ?? amount_cents);
  if (!Number.isInteger(cents) || cents < 100) throw new HttpError(400, 'Minimum top-up is $1 (1 vote)');
  if (cents > 500000) throw new HttpError(400, 'Maximum top-up is $5,000');

  const { SUPABASE_SERVICE_ROLE_KEY } = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const SUPABASE_URL = supabaseUrl();
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Trust the bearer token over the posted userId when both are present: the
  // body is caller-controlled, the token is not.
  let uid = userId;
  if (req.headers.authorization) {
    const token = req.headers.authorization.replace('Bearer ', '');
    const { data } = await supabaseAdmin.auth.getUser(token);
    if (data?.user) uid = data.user.id;
  }
  if (!uid) throw new HttpError(401, 'Sign in before topping up');

  const siteUrl = process.env.SITE_URL || 'https://www.thetruegoat.com';

  // The pending row is the record of what was asked for. Settlement reads the
  // amount from here and checks PayPal's captured total against it, so the
  // payer cannot decide their own credit.
  const { data: pending, error: pendingErr } = await supabaseAdmin
    .from('topups')
    .insert({ user_id: uid, amount_cents: cents, status: 'pending', provider: 'paypal' })
    .select('id')
    .single();
  if (pendingErr) throw new HttpError(500, `Could not open a top-up: ${pendingErr.message}`);
  const topupId = pending.id;

  const votes = cents / 100;
  const returnQuery = new URLSearchParams({ paypal: 'return', topup_id: topupId });
  if (returnTo) returnQuery.set('returnTo', returnTo);

  let order;
  try {
    order = await payPalFetch('/v2/checkout/orders', {
      method: 'POST',
      // Makes a retried create idempotent at PayPal instead of opening a
      // second order for the same top-up.
      headers: { 'PayPal-Request-Id': topupId },
      body: {
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: topupId,
          // Echoed back on the capture and on the webhook resource — this is
          // how settlement finds the row without trusting a query parameter.
          custom_id: topupId,
          description: `${votes} vote${votes === 1 ? '' : 's'} on The True GOAT`,
          amount: { currency_code: 'USD', value: toPayPalAmount(cents) }
        }],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: 'The True GOAT',
              landing_page: 'LOGIN',
              shipping_preference: 'NO_SHIPPING',
              user_action: 'PAY_NOW',
              return_url: `${siteUrl}/wallet?${returnQuery.toString()}`,
              cancel_url: `${siteUrl}/wallet?paypal=cancel`
            }
          }
        }
      }
    });
  } catch (err) {
    await supabaseAdmin.from('topups').update({ status: 'failed' }).eq('id', topupId);
    throw err;
  }

  await supabaseAdmin.from('topups').update({ provider_order_id: order?.id }).eq('id', topupId);

  // With payment_source.paypal.experience_context the approval link comes back
  // as rel "payer-action"; the older application_context flow calls it
  // "approve". Accept either so this keeps working if the shape changes.
  const link = (order?.links || []).find(l => l.rel === 'payer-action')
    || (order?.links || []).find(l => l.rel === 'approve');

  if (!link?.href) {
    console.error('[checkout] PayPal order had no approval link:', JSON.stringify(order?.links));
    throw new HttpError(502, 'PayPal did not return an approval link. Nothing has been charged.');
  }

  return res.status(200).json({ ok: true, url: link.href, orderId: order.id, topupId });
});
