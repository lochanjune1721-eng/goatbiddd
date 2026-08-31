// api/checkout.js — Dodo Payments checkout session & wallet top-up handler
import { createClient } from '@supabase/supabase-js';
import { HttpError, readJsonBody, requireMethod, requireEnv, unwrap, withHandler } from './_lib.js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://orzcszqpnvicreqvpncu.supabase.co';

export default withHandler(async function handler(req, res){
  requireMethod(req, 'POST');

  const body = await readJsonBody(req);
  const { userId, amountCents, amount_cents, returnTo, email } = body;
  const cents = Number(amountCents ?? amount_cents);
  if (!Number.isFinite(cents) || cents < 100) throw new HttpError(400, 'Minimum top-up is $1 (1 vote)');

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    // This used to answer ok:true, which reads as success in the wallet UI
    // while no credit was ever recorded.
    throw new HttpError(503, 'Top-ups are unavailable: the server is missing SUPABASE_SERVICE_ROLE_KEY.');
  }

  const supabaseAdmin = createClient(SUPABASE_URL, serviceKey);

  // Authenticate user
  let uid = userId;
  let userEmail = email;
  if (req.headers.authorization) {
    const token = req.headers.authorization.replace('Bearer ', '');
    const { data } = await supabaseAdmin.auth.getUser(token);
    if (data?.user) {
      uid = data.user.id;
      userEmail = data.user.email || userEmail;
    }
  }
  if (!uid) throw new HttpError(401, 'Missing userId');

  const dodoApiKey = process.env.DODO_API_KEY || process.env.DODO_PAYMENTS_API_KEY;
  const isDodoConfigured = dodoApiKey && !dodoApiKey.startsWith('dodo_...');

  const siteUrl = process.env.SITE_URL || 'https://www.thetruegoat.com';
  const redirectUrl = `${siteUrl}/wallet?payment=success&votes=${cents/100}` + (returnTo ? `&returnTo=${encodeURIComponent(returnTo)}` : '');

  // If real Dodo Payments API key is provided, create real checkout session
  if (isDodoConfigured) {
    try {
      // topups.id is a uuid; let the database mint it and carry that value in
      // the payment metadata. The old `topup_<timestamp>` string failed the
      // column type, so no pending row was ever written — which left the
      // webhook with no record of how much had actually been paid.
      const { data: pending, error: pendingErr } = await supabaseAdmin
        .from('topups')
        .insert({ user_id: uid, amount_cents: cents, status: 'pending' })
        .select('id')
        .single();
      if (pendingErr) throw new HttpError(500, `Could not open a top-up: ${pendingErr.message}`);
      const topupId = pending.id;

      const dodoRes = await fetch('https://live.dodopayments.com/checkouts', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${dodoApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          total_amount: cents,
          currency: 'USD',
          product_cart: [
            {
              name: `${cents/100} The True GOAT Votes`,
              quantity: 1,
              amount: cents
            }
          ],
          customer: {
            email: userEmail || 'fan@thetruegoat.com'
          },
          metadata: {
            topup_id: topupId,
            user_id: uid,
            amount_cents: cents
          },
          return_url: redirectUrl
        })
      });

      if (dodoRes.ok) {
        const dodoData = await dodoRes.json();
        const checkoutUrl = dodoData.checkout_url || dodoData.url || dodoData.payment_url;
        if (checkoutUrl) {
          return res.status(200).json({ ok: true, url: checkoutUrl, topupId });
        }
      }
      const detail = await dodoRes.text().catch(() => '');
      console.error('[checkout] Dodo checkout call returned non-200:', dodoRes.status, detail.slice(0, 500));
      throw new HttpError(502, 'The payment provider could not start a checkout. Nothing has been charged — please try again.');
    } catch(err) {
      if (err instanceof HttpError) throw err;
      console.error('[checkout] Dodo checkout creation failed:', err);
      throw new HttpError(502, 'The payment provider is unreachable. Nothing has been charged — please try again.');
    }
  }

  // Below here no payment has been made. Crediting the wallet anyway is free
  // money, so it happens only when the project is explicitly put in test mode.
  // Failing a top-up is the correct outcome of an unconfigured payment
  // provider; silently granting votes is not.
  if (process.env.ALLOW_TEST_TOPUPS !== '1') {
    throw new HttpError(503, 'Payments are not configured yet, so top-ups are unavailable. Nothing has been charged.');
  }

  const paymentId = `test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const { data: newBalance, error: creditErr } = await supabaseAdmin.rpc('confirm_topup', {
    p_topup_id: null,
    p_user_id: uid,
    p_amount_cents: cents,
    p_payment_id: paymentId
  });
  if (creditErr) throw new HttpError(500, `Test top-up failed: ${creditErr.message}`);

  console.warn(`[checkout] TEST MODE: credited ${cents} cents to ${uid} with no payment (ALLOW_TEST_TOPUPS=1)`);
  return res.status(200).json({ ok: true, test: true, newBalance, votesAdded: cents/100 });
});
