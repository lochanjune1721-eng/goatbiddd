// api/_pay-upi.js — direct UPI: pay straight to the site's own VPA.
//
// No gateway sits in the middle, so there is no callback and nothing can tell
// this server the money arrived. That is a property of UPI collect-to-VPA, not
// an omission: this rail therefore never credits on its own. It opens a
// pending top-up, hands back a upi:// link and a QR, and waits for the payer
// to submit their UTR (upiClaim below), which an admin approves against the
// bank statement. Crediting on an unverified claim would be free votes for
// anyone who typed twelve digits.
// The default entry requires node:fs for its toFile renderers, which does not
// exist on Workers. The browser build has the same toString(svg).
import QRCode from 'qrcode/lib/browser.js';
import { createClient } from '@supabase/supabase-js';
import { HttpError, requireEnv, supabaseUrl } from './_lib.js';
import { rupeesForVotes } from './_pricing.js';
export function isConfigured(){
  return Boolean(process.env.UPI_VPA && process.env.UPI_PAYEE_NAME);
}

export async function upiIntent(req, res, body){

  if (!isConfigured()) throw new HttpError(503, 'UPI is not configured yet. Nothing has been charged.');
  const { UPI_VPA, UPI_PAYEE_NAME } = requireEnv('UPI_VPA', 'UPI_PAYEE_NAME');

  const { userId, amountCents, amount_cents } = body;
  const cents = Number(amountCents ?? amount_cents);
  if (!Number.isInteger(cents) || cents < 100) throw new HttpError(400, 'Minimum top-up is $1 (1 vote)');
  if (cents > 500000) throw new HttpError(400, 'Maximum top-up is $5,000');

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

  const votes = cents / 100;
  const rupees = rupeesForVotes(votes);

  const { data: pending, error } = await supa.from('topups').insert({
    user_id: uid,
    amount_cents: cents,
    status: 'pending',
    provider: 'upi',
    provider_amount: rupees,
    provider_currency: 'INR'
  }).select('id').single();
  if (error) throw new HttpError(500, `Could not open a top-up: ${error.message}`);

  // A short reference the payer can quote and that shows up in the bank
  // statement narration, which is what makes reconciliation bearable.
  const ref = 'GOAT' + pending.id.replace(/-/g, '').slice(0, 8).toUpperCase();

  const params = new URLSearchParams({
    pa: UPI_VPA,
    pn: UPI_PAYEE_NAME,
    am: rupees.toFixed(2),
    cu: 'INR',
    tn: `${votes} vote${votes === 1 ? '' : 's'} ${ref}`,
    tr: ref
  });
  const upiUrl = `upi://pay?${params.toString()}`;

  await supa.from('topups').update({ provider_order_id: ref }).eq('id', pending.id);

  // Rendered here rather than from a CDN so a blocked script cannot leave the
  // payer with no way to pay on desktop.
  const qrSvg = await QRCode.toString(upiUrl, { type: 'svg', margin: 1, width: 260 });

  return res.status(200).json({
    ok: true,
    topupId: pending.id,
    reference: ref,
    vpa: UPI_VPA,
    payeeName: UPI_PAYEE_NAME,
    amountInr: rupees,
    votes,
    upiUrl,
    qrSvg,
    // Said plainly so the UI cannot imply the votes are already there.
    notice: 'Votes are added once we match your payment — usually within a few hours.'
  });
}

// upiClaim — the payer tells us they paid, and quotes their UTR.
//
// This does not credit anything. It moves the top-up to 'review' so it appears
// in the admin queue, where it is checked against the bank statement. The UTR
// lands in provider_payment_id, whose (provider, provider_payment_id) unique
// index means the same reference cannot be claimed twice, by anyone.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A UPI UTR is twelve digits; allow a little either side for bank variations.
const UTR = /^[A-Za-z0-9]{6,32}$/;

export async function upiClaim(req, res, body){

  const { topupId, utr } = body;
  if (!topupId || !UUID.test(String(topupId))) throw new HttpError(400, 'Missing topupId');

  const reference = String(utr || '').trim().replace(/\s+/g, '');
  if (!UTR.test(reference)) throw new HttpError(400, 'Enter the UPI reference number from your payment app (usually 12 digits).');

  const { SUPABASE_SERVICE_ROLE_KEY } = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const SUPABASE_URL = supabaseUrl();
  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) throw new HttpError(401, 'Sign in to submit your payment reference');
  const { data: authData } = await supa.auth.getUser(token);
  const uid = authData?.user?.id;
  if (!uid) throw new HttpError(401, 'Your session has expired — sign in again');

  const { data: topup } = await supa.from('topups')
    .select('id,user_id,status,provider,amount_cents,provider_amount').eq('id', topupId).maybeSingle();
  if (!topup) throw new HttpError(404, 'That top-up could not be found');
  if (topup.user_id !== uid) throw new HttpError(403, 'That top-up belongs to a different account');
  if (topup.provider !== 'upi') throw new HttpError(400, 'That top-up is not a UPI payment');
  if (topup.status === 'confirmed') return res.status(200).json({ ok: true, alreadyConfirmed: true });

  const { error } = await supa.from('topups')
    .update({ status: 'review', provider_payment_id: reference, claimed_at: new Date().toISOString() })
    .eq('id', topupId);

  if (error) {
    // The unique index is the guard: this reference is already spoken for.
    if (String(error.message || '').includes('duplicate key') || error.code === '23505') {
      throw new HttpError(409, 'That reference has already been submitted. If it is yours and the votes have not arrived, contact support.');
    }
    throw new HttpError(500, `Could not record that reference: ${error.message}`);
  }

  console.log(`[upi-claim] ${uid} claims UTR ${reference} for topup ${topupId} (${topup.provider_amount} INR)`);
  return res.status(200).json({
    ok: true,
    status: 'review',
    message: 'Thanks — we will match your payment and add your votes, usually within a few hours.'
  });
}
