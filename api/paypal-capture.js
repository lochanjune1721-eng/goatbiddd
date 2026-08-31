// api/paypal-capture.js — called by the wallet when PayPal sends the payer
// back. Captures the approved order and credits the wallet.
//
// The webhook does the same job independently, so this is about speed, not
// correctness: whichever arrives first settles, and confirm_topup makes the
// second a no-op.
import { createClient } from '@supabase/supabase-js';
import { HttpError, readJsonBody, requireMethod, requireEnv, withHandler, supabaseUrl } from './_lib.js';
import { payPalFetch, fromPayPalAmount, hasIssue } from './_paypal.js';
import { settleTopup, readCapture } from './_settle.js';

export default withHandler(async function handler(req, res){
  requireMethod(req, 'POST');

  const { orderId } = await readJsonBody(req);
  if (!orderId || typeof orderId !== 'string') throw new HttpError(400, 'Missing orderId');

  const { SUPABASE_SERVICE_ROLE_KEY } = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const SUPABASE_URL = supabaseUrl();
  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Must be the signed-in payer: settleTopup checks this id against the row's
  // owner, so nobody can settle someone else's order into their own wallet.
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) throw new HttpError(401, 'Sign in to finish your top-up');
  const { data: authData } = await supa.auth.getUser(token);
  const uid = authData?.user?.id;
  if (!uid) throw new HttpError(401, 'Your session has expired — sign in again');

  let order;
  try {
    order = await payPalFetch(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      method: 'POST',
      headers: { 'PayPal-Request-Id': `capture-${orderId}` },
      body: {}
    });
  } catch (err) {
    // Already captured — by the webhook, or by the payer refreshing the return
    // page. Read the existing capture instead of treating it as a failure.
    if (hasIssue(err, 'ORDER_ALREADY_CAPTURED')) {
      order = await payPalFetch(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
    } else {
      throw err;
    }
  }

  const capture = readCapture(order);
  if (!capture) throw new HttpError(502, 'PayPal did not return a capture for that order');

  if (capture.status === 'PENDING') {
    return res.status(202).json({ ok: false, pending: true, message: 'PayPal is still reviewing this payment. Your votes will appear once it clears.' });
  }
  if (capture.status !== 'COMPLETED') {
    throw new HttpError(402, `PayPal did not complete the payment (${capture.status}). Nothing has been charged.`);
  }

  const result = await settleTopup(supa, {
    topupId: capture.topupId,
    orderId,
    captureId: capture.id,
    capturedCents: fromPayPalAmount(capture.amountValue),
    requireUserId: uid,
    label: 'paypal-capture'
  });

  if (!result.settled) throw new HttpError(500, `Payment captured but not credited: ${result.reason}. Contact support with order ${orderId}.`);

  const { data: user } = await supa.from('users').select('balance_cents').eq('id', uid).maybeSingle();
  return res.status(200).json({
    ok: true,
    duplicate: !!result.duplicate,
    credited: result.credited ?? 0,
    newBalance: user?.balance_cents ?? result.newBalance ?? null
  });
});
