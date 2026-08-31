// api/uropay-webhook.js — UroPay order-status webhook.
//
// Signature-verified, then ignored as evidence: UroPay documents this delivery
// as advisory and best-effort, retried never, so the handler re-reads the
// order and settles on what GET /v1/orders says. Duplicate deliveries are
// expected — confirm_topup makes the second one a no-op.
import { createClient } from '@supabase/supabase-js';
import { HttpError, readRawBodyText, requireEnv, requireMethod, withHandler } from './_lib.js';
import { verifyWebhook } from './_uropay.js';
import { settleUroPayOrder } from './_uropay-settle.js';

export default withHandler(async function handler(req, res){
  requireMethod(req, 'POST');

  // Before anything reads req.body — the signature covers these exact bytes.
  const raw = await readRawBodyText(req);

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = requireEnv('SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY');
  verifyWebhook(req, raw);

  let event;
  try { event = raw.trim() ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'Invalid JSON body'); }

  const { eventId, orderId, status, environment } = event || {};
  const log = `uropay-webhook ${eventId || '(no id)'} ${status || '(no status)'}`;

  if (!orderId) return res.status(200).json({ received: true, ignored: 'no order id' });

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // CANCELLED was added after this integration was written; the docs warn that
  // handlers switching on status need a default branch. Anything that is not
  // PAID is recorded as failed and credits nothing.
  if (status !== 'PAID') {
    await supa.from('topups')
      .update({ status: 'failed' })
      .eq('provider', 'uropay').eq('provider_order_id', orderId).neq('status', 'confirmed');
    console.log(`[${log}] order ${orderId} did not succeed (${environment}); nothing credited`);
    return res.status(200).json({ received: true, status: status || null });
  }

  const result = await settleUroPayOrder(supa, { orderId, label: 'uropay-webhook' });
  if (!result.settled) console.warn(`[${log}] not settled: ${result.reason}`);
  return res.status(200).json({ received: true, settled: result.settled, reason: result.reason });
});
