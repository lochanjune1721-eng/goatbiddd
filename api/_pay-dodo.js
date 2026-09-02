// api/_pay-dodo.js — Dodo Payments: opens a checkout for a wallet top-up.
//
// This route moves no money, deliberately: It records what was asked for and returns a URL to send the
// payer to. Credit is granted later, and only against a payment Dodo itself
// reports as succeeded — never against the payer coming back to the site,
// which anyone can do by typing the return URL.
import { createClient } from '@supabase/supabase-js';
import { HttpError, requireEnv, supabaseUrl, refuseInDemoMode } from './_lib.js';
import { createPayment, getPayment, isConfigured, mode } from './_dodo.js';
import { creditCentsForCents, MIN_CENTS, MAX_CENTS } from './_pricing.js';
import { settleTopup } from './_settle.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Dodo's own words for "the money arrived". Anything else is not a payment.
const PAID = new Set(['succeeded', 'success', 'paid', 'completed', 'captured']);
export function isPaid(status){
  return PAID.has(String(status || '').toLowerCase());
}

async function client(){
  const { SUPABASE_SERVICE_ROLE_KEY } = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  return createClient(supabaseUrl(), SUPABASE_SERVICE_ROLE_KEY);
}

async function callerId(supa, req, fallback){
  if (req.headers.authorization) {
    const token = req.headers.authorization.replace('Bearer ', '');
    const { data } = await supa.auth.getUser(token);
    if (data?.user) return data.user.id;
  }
  return fallback;
}

export async function dodoCheckout(req, res, body){
  // Nothing below this line can run in a demonstration build.
  refuseInDemoMode();

  if (!isConfigured()) {
    throw new HttpError(503, 'Card top-ups are not configured yet. Nothing has been charged.');
  }

  const { userId, amountCents, amount_cents, returnTo, personId } = body;
  const cents = Math.round(Number(amountCents ?? amount_cents));
  if (!Number.isFinite(cents) || cents < MIN_CENTS || cents > MAX_CENTS) {
    throw new HttpError(400, `Top up between $${MIN_CENTS / 100} and $${(MAX_CENTS / 100).toLocaleString('en-US')}.`);
  }

  const supa = await client();
  const uid = await callerId(supa, req, userId);
  if (!uid) throw new HttpError(401, 'Sign in before topping up');

  // The email Dodo needs for the receipt comes from the account, not the
  // request body — a payer cannot address someone else's receipt.
  const { data: account } = await supa
    .from('users').select('email,display_name').eq('id', uid).maybeSingle();

  const siteUrl = process.env.SITE_URL || 'https://thetruegoat.com';

  // The pending row is the record of what was asked for, written before Dodo is
  // called. If the call fails there is still a row saying so, rather than a
  // payment nobody can account for.
  const { data: pending, error: pendingErr } = await supa
    .from('topups')
    .insert({
      user_id: uid,
      amount_cents: cents,
      credit_cents: creditCentsForCents(cents),
      vote_person_id: personId || null,
      status: 'pending',
      provider: 'dodo',
      provider_amount: cents,
      provider_currency: 'USD'
    })
    .select('id')
    .single();
  if (pendingErr) throw new HttpError(500, `Could not open a top-up: ${pendingErr.message}`);
  const topupId = pending.id;

  const returnQuery = new URLSearchParams({ dodo: 'return', topup_id: topupId });
  if (returnTo) returnQuery.set('returnTo', returnTo);

  let payment;
  try {
    payment = await createPayment({
      reference: topupId,
      amountCents: cents,
      currency: 'USD',
      customer: {
        email: account?.email || undefined,
        name: account?.display_name || undefined
      },
      returnUrl: `${siteUrl}/wallet?${returnQuery.toString()}`
    });
  } catch (err) {
    await supa.from('topups').update({ status: 'failed' }).eq('id', topupId);
    throw err;
  }

  await supa.from('topups')
    .update({ provider_order_id: payment.id || null })
    .eq('id', topupId);

  return res.status(200).json({
    ok: true, url: payment.url, paymentId: payment.id, topupId, mode: mode()
  });
}

// dodoConfirm — called by the wallet when Dodo sends the payer back.
//
// Asks Dodo what happened rather than believing the return. The webhook settles
// the same payment independently; whichever arrives first wins and the other is
// a no-op, because settlement is keyed on the payment id.
export async function dodoConfirm(req, res, body){
  const { topupId } = body;
  if (!topupId || !UUID.test(String(topupId))) throw new HttpError(400, 'Missing topupId');

  const supa = await client();

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) throw new HttpError(401, 'Sign in to finish your top-up');
  const { data: authData } = await supa.auth.getUser(token);
  const uid = authData?.user?.id;
  if (!uid) throw new HttpError(401, 'Sign in to finish your top-up');

  const { data: topup } = await supa
    .from('topups').select('*').eq('id', topupId).maybeSingle();
  if (!topup) throw new HttpError(404, 'That top-up does not exist');
  if (topup.user_id !== uid) throw new HttpError(403, 'That top-up is not yours');

  if (topup.status === 'confirmed') {
    return res.status(200).json({ ok: true, settled: true, alreadyCredited: true });
  }
  if (!topup.provider_order_id) {
    return res.status(200).json({ ok: true, settled: false, reason: 'no payment was opened' });
  }

  const payment = await getPayment(topup.provider_order_id);
  const status = payment?.status || payment?.payment_status;

  if (!isPaid(status)) {
    return res.status(200).json({ ok: true, settled: false, status: status || 'unknown' });
  }

  const result = await settleTopup(supa, {
    topupId,
    captureId: topup.provider_order_id,
    capturedCents: Number(payment?.total_amount ?? payment?.amount ?? topup.amount_cents),
    requireUserId: uid,
    provider: 'dodo',
    label: 'dodo-confirm'
  });

  return res.status(200).json({ ok: true, ...result });
}
