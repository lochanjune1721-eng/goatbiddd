// api/dodo-webhook.js — Dodo Payments' own callback.
//
// This is the path that actually grants credit. The browser return is a
// convenience — anyone can type that URL — so it confirms nothing on its own;
// this does, and only for a body whose signature verifies.
//
// Always answers 200 once the signature is good, whatever we then decide about
// the payload. A non-2xx makes Dodo retry, and retrying a delivery we have
// already understood and rejected achieves nothing but noise.
import { createClient } from '@supabase/supabase-js';
import { readRawBodyText, requireEnv, requireMethod, supabaseUrl, withHandler } from './_lib.js';
import { verifyWebhook } from './_dodo.js';
import { isPaid } from './_pay-dodo.js';
import { settleTopup } from './_settle.js';

export default withHandler(async function handler(req, res){
  requireMethod(req, 'POST');

  // The exact bytes Dodo signed. Re-serialising a parsed object changes them
  // and every signature then fails.
  const raw = await readRawBodyText(req);
  verifyWebhook(req.headers || {}, raw);

  let event = null;
  try { event = raw ? JSON.parse(raw) : null; } catch (e) {}
  const type = String(event?.type || event?.event_type || '');
  const data = event?.data || event?.payload || event || {};

  const paymentId = data.payment_id || data.id || null;
  const topupId   = data.metadata?.topup_id || null;
  const status    = data.status || data.payment_status || null;

  if (!paymentId) {
    console.warn('[dodo-webhook] delivery with no payment id, type:', type);
    return res.status(200).json({ ok: true, ignored: 'no payment id' });
  }

  // Only a payment that succeeded is settled. A "created" or "failed" event is
  // recorded by being ignored — there is nothing to credit.
  if (!isPaid(status) && !/succeed|success|paid|complete/i.test(type)) {
    return res.status(200).json({ ok: true, ignored: `status ${status || type || 'unknown'}` });
  }

  const { SUPABASE_SERVICE_ROLE_KEY } = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const supa = createClient(supabaseUrl(), SUPABASE_SERVICE_ROLE_KEY);

  // requireUserId is deliberately unset: Dodo is not a signed-in user. The
  // amount credited still comes from our own pending row, never from this body.
  const result = await settleTopup(supa, {
    topupId,
    orderId: paymentId,
    captureId: paymentId,
    capturedCents: Number(data.total_amount ?? data.amount ?? NaN),
    provider: 'dodo',
    label: 'dodo-webhook'
  });

  return res.status(200).json({ ok: true, ...result });
});
