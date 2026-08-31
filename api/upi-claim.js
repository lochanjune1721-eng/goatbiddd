// api/upi-claim.js — the payer tells us they paid, and quotes their UTR.
//
// This does not credit anything. It moves the top-up to 'review' so it appears
// in the admin queue, where it is checked against the bank statement. The UTR
// lands in provider_payment_id, whose (provider, provider_payment_id) unique
// index means the same reference cannot be claimed twice, by anyone.
import { createClient } from '@supabase/supabase-js';
import { HttpError, readJsonBody, requireMethod, requireEnv, withHandler, supabaseUrl } from './_lib.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A UPI UTR is twelve digits; allow a little either side for bank variations.
const UTR = /^[A-Za-z0-9]{6,32}$/;

export default withHandler(async function handler(req, res){
  requireMethod(req, 'POST');

  const { topupId, utr } = await readJsonBody(req);
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
});
