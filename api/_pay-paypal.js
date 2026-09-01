// api/_pay-paypal.js — PayPal: opens an order for a wallet top-up.
//
// This route never moves money. It records what is owed and hands back the
// PayPal URL to send the payer to; credit is only ever granted later, by
// the capture below or the webhook, and only against a completed capture.
import { createClient } from '@supabase/supabase-js';
import { HttpError, requireEnv, supabaseUrl, refuseInDemoMode } from './_lib.js';
import { payPalFetch, toPayPalAmount, fromPayPalAmount, hasIssue } from './_paypal.js';
import { settleTopup, readCapture } from './_settle.js';
import { creditCentsForCents, votesForCents } from './_pricing.js';
import { userCountry, assertRail } from './_country.js';
export async function payPalCheckout(req, res, body){

  // Nothing below this line can run in a demonstration build.
  refuseInDemoMode();

  const { userId, amountCents, amount_cents, returnTo, personId } = body;
  const cents = Number(amountCents ?? amount_cents);
  // Throws for anything outside $1–$5,000, so the range check lives in one place.
  const votesBought = votesForCents(cents);
  const creditCents = creditCentsForCents(cents);

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

  // The rail follows the country on the account, not the network the request
  // arrived on. Enforced here as well as hidden in the UI, so a hand-made POST
  // cannot open an order on a rail this fan was never offered.
  assertRail(await userCountry(supabaseAdmin, uid), 'paypal');

  const siteUrl = process.env.SITE_URL || 'https://www.thetruegoat.com';

  // The pending row is the record of what was asked for. Settlement reads the
  // amount from here and checks PayPal's captured total against it, so the
  // payer cannot decide their own credit.
  const { data: pending, error: pendingErr } = await supabaseAdmin
    .from('topups')
    .insert({
      user_id: uid,
      amount_cents: cents,
      // What settlement will grant: the tier's votes, not the dollars. Fixed
      // now so repricing a tier cannot change an order already open.
      credit_cents: creditCents,
      // Set for pay-to-vote — settlement spends the votes on this contender
      // instead of leaving a balance the payer never asked for.
      vote_person_id: personId || null,
      status: 'pending',
      provider: 'paypal'
    })
    .select('id')
    .single();
  if (pendingErr) throw new HttpError(500, `Could not open a top-up: ${pendingErr.message}`);
  const topupId = pending.id;

  const votes = votesBought;
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
}

// payPalCapture — called by the wallet when PayPal sends the payer
// back. Captures the approved order and credits the wallet.
//
// The webhook does the same job independently, so this is about speed, not
// correctness: whichever arrives first settles, and confirm_topup makes the
// second a no-op.

export async function payPalCapture(req, res, body){

  const { orderId } = body;
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
}
