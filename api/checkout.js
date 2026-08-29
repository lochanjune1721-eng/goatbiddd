// /api/checkout.js
// TEMPORARY: fake payment. Swap for Dodo before launch.
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "https://orzcszqpnvicreqvpncu.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} }
  const { userId, amountCents, amount_cents } = body || {};
  const cents = Number(amountCents ?? amount_cents);
  if (!cents || cents < 500) return res.status(400).json({ error: 'Minimum is 5 votes' });

  // If no service key (local dev), just simulate success
  await new Promise(r => setTimeout(r, 800)); // simulate provider latency

  if (!SERVICE_KEY) {
    // In dev without service key, just return ok and let client optimistically assume credit
    return res.json({ ok: true, fake: true, newBalance: null, message: 'Fake checkout — no service key, using optimistic balance' });
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY);
  // Use provided userId or try to get from auth header
  let uid = userId;
  if (!uid && req.headers.authorization) {
    const token = req.headers.authorization.replace('Bearer ','');
    const { data } = await supabaseAdmin.auth.getUser(token);
    uid = data?.user?.id;
  }
  if (!uid) return res.status(401).json({ error: 'Missing userId' });

  const paymentId = `fake_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
  const { data, error } = await supabaseAdmin.rpc('credit_balance', {
    p_user_id: uid,
    p_amount_cents: cents,
    p_payment_id: paymentId
  });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true, newBalance: data });
}
