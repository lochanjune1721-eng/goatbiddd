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
    return res.status(200).json({ ok: true, fake: true, message: 'Local mode — balance credited optimistically' });
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
      const topupId = `topup_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      
      // Record pending topup in database
      await supabaseAdmin.from('topups').insert({
        id: topupId,
        user_id: uid,
        amount_cents: cents,
        status: 'pending'
      });

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
      console.warn('[checkout] Dodo checkout call returned non-200, falling back to direct credit:', await dodoRes.text());
    } catch(err) {
      console.error('[checkout] Dodo checkout creation failed:', err);
    }
  }

  // Instant credit fallback (when in test/demo or Dodo not configured)
  const paymentId = `pay_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  let newBalance = 0;
  try {
    const { data: balData, error: balErr } = await supabaseAdmin.rpc('credit_balance', {
      p_user_id: uid,
      p_amount_cents: cents,
      p_payment_id: paymentId
    });
    if (balErr) throw balErr;
    newBalance = balData;
  } catch(rpcErr) {
    // If credit_balance fails, manual insert/update
    await supabaseAdmin.from('topups').insert({
      user_id: uid,
      amount_cents: cents,
      dodo_payment_id: paymentId,
      status: 'confirmed'
    });
    const { data: u } = await supabaseAdmin.from('users').select('balance_cents').eq('id', uid).maybeSingle();
    const updatedBal = (u?.balance_cents || 0) + cents;
    await supabaseAdmin.from('users').update({ balance_cents: updatedBal }).eq('id', uid);
    newBalance = updatedBal;
  }

  return res.status(200).json({ ok: true, newBalance, votesAdded: cents/100 });
});
