// api/upi-intent.js — direct UPI: pay straight to the site's own VPA.
//
// No gateway sits in the middle, so there is no callback and nothing can tell
// this server the money arrived. That is a property of UPI collect-to-VPA, not
// an omission: this rail therefore never credits on its own. It opens a
// pending top-up, hands back a upi:// link and a QR, and waits for the payer
// to submit their UTR (api/upi-claim.js), which an admin approves against the
// bank statement. Crediting on an unverified claim would be free votes for
// anyone who typed twelve digits.
import { createClient } from '@supabase/supabase-js';
import QRCode from 'qrcode';
import { HttpError, readJsonBody, requireMethod, requireEnv, withHandler } from './_lib.js';
import { rupeesForVotes } from './_pricing.js';

export function isConfigured(){
  return Boolean(process.env.UPI_VPA && process.env.UPI_PAYEE_NAME);
}

export default withHandler(async function handler(req, res){
  requireMethod(req, 'POST');

  if (!isConfigured()) throw new HttpError(503, 'UPI is not configured yet. Nothing has been charged.');
  const { UPI_VPA, UPI_PAYEE_NAME } = requireEnv('UPI_VPA', 'UPI_PAYEE_NAME');

  const { userId, amountCents, amount_cents } = await readJsonBody(req);
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
});
