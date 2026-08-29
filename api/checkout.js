// /api/checkout.js
// TEMPORARY: fake payment. Swap for Dodo before launch.
import { createClient } from '@supabase/supabase-js';
import { HttpError, readJsonBody, requireMethod, requireEnv, unwrap, withHandler } from './_lib.js';

// Project URL is public (the service-role key below is the secret), so keep the
// fallback: a missing SUPABASE_URL env var should not take checkout down.
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://orzcszqpnvicreqvpncu.supabase.co';

export default withHandler(async function handler(req, res){
  requireMethod(req, 'POST');

  const body = await readJsonBody(req);
  const { userId, amountCents, amount_cents } = body;
  const cents = Number(amountCents ?? amount_cents);
  if (!Number.isFinite(cents) || cents < 500) throw new HttpError(400, 'Minimum is 5 votes');

  await new Promise(r => setTimeout(r, 800)); // simulate provider latency

  // Without a service key (local dev) there is nothing to credit — say so
  // instead of half-running and failing at the first Supabase call.
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(200).json({ ok: true, fake: true, newBalance: null, message: 'Fake checkout — no service key, using optimistic balance' });
  }

  const { SUPABASE_SERVICE_ROLE_KEY } = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Use provided userId or try to get from auth header
  let uid = userId;
  if (!uid && req.headers.authorization) {
    const token = req.headers.authorization.replace('Bearer ', '');
    const { data } = await supabaseAdmin.auth.getUser(token);
    uid = data?.user?.id;
  }
  if (!uid) throw new HttpError(401, 'Missing userId');

  const paymentId = `fake_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const newBalance = unwrap(
    await supabaseAdmin.rpc('credit_balance', { p_user_id: uid, p_amount_cents: cents, p_payment_id: paymentId }),
    'credit_balance'
  );
  return res.status(200).json({ ok: true, newBalance });
});
