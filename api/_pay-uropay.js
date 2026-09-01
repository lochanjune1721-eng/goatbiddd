// api/_pay-uropay.js — UroPay: opens a UroPay (UPI) order for a wallet top-up.
//
// Mirrors the PayPal rail: this route moves no money. It records what is owed
// and returns the URL to send the payer to. Credit is granted later, and only
// against an order UroPay itself confirms as PAID.
import { createClient } from '@supabase/supabase-js';
import { HttpError, requireEnv, supabaseUrl, refuseInDemoMode } from './_lib.js';
import { createOrder, isConfigured } from './_uropay.js';
import { creditCentsForCents, votesForCents, rupeesForCents } from './_pricing.js';
import { userCountry, assertRail } from './_country.js';
import { settleUroPayOrder } from './_uropay-settle.js';
export async function uroPayCheckout(req, res, body){

  // Nothing below this line can run in a demonstration build.
  refuseInDemoMode();

  if (!isConfigured()) throw new HttpError(503, 'UPI top-ups are not configured yet. Nothing has been charged.');

  const { userId, amountCents, amount_cents, returnTo, personId } = body;
  const cents = Number(amountCents ?? amount_cents);
  const votesBought = votesForCents(cents);
  const creditCents = creditCentsForCents(cents);

  const { SUPABASE_SERVICE_ROLE_KEY } = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const SUPABASE_URL = supabaseUrl();
  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  let uid = userId;
  if (req.headers.authorization) {
    const token = req.headers.authorization.replace('Bearer ', '');
    const { data } = await supa.auth.getUser(token);
    if (data?.user) uid = data.user.id;
  }
  if (!uid) throw new HttpError(401, 'Sign in before topping up');

  // The rail follows the country on the account, not the network the request
  // arrived on. Enforced here as well as hidden in the UI, so a hand-made POST
  // cannot open an order on a rail this fan was never offered.
  assertRail(await userCountry(supa, uid), 'upi');

  const votes = votesBought;
  // Charged on the dollars, not on the bonused votes — the bonus is a discount,
  // and billing for it would hand it straight back.
  const rupees = rupeesForCents(cents);
  const siteUrl = process.env.SITE_URL || 'https://www.thetruegoat.com';

  // The pending row is the record of what was asked for, in both currencies:
  // amount_cents is the votes to grant, provider_amount is the rupees UroPay
  // must actually collect before any of them are granted.
  const { data: pending, error: pendingErr } = await supa
    .from('topups')
    .insert({
      user_id: uid,
      amount_cents: cents,
      credit_cents: creditCents,
      vote_person_id: personId || null,
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
}

// uroPayConfirm — called by the wallet when UroPay sends the payer back.
//
// Confirms immediately so the votes appear while they are still looking at the
// page. The webhook settles the same order independently; whichever arrives
// first wins and the other is a no-op.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function uroPayConfirm(req, res, body){

  const { topupId } = body;
  if (!topupId || !UUID.test(String(topupId))) throw new HttpError(400, 'Missing topupId');

  const { SUPABASE_SERVICE_ROLE_KEY } = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const SUPABASE_URL = supabaseUrl();
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
}
