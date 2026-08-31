// api/payment-done.js — PayPal webhook. The reliable half of settlement: it
// still credits the wallet when the payer closes the tab before being sent
// back to the site.
//
// Every delivery is verified with PayPal before anything is read from it. An
// unverified POST to this URL credits nothing, and a missing PAYPAL_WEBHOOK_ID
// fails the request rather than falling back to trusting the caller.
import { createClient } from '@supabase/supabase-js';
import { HttpError, readRawBodyText, requireEnv, requireMethod, withHandler } from './_lib.js';
import { verifyWebhookSignature, payPalFetch, fromPayPalAmount, hasIssue } from './_paypal.js';
import { settleTopup, readCapture } from './_settle.js';

export default withHandler(async function handler(req, res){
  requireMethod(req, 'POST');

  // Read the stream before anything touches req.body — the verification call
  // sends these bytes back to PayPal unchanged.
  const raw = await readRawBodyText(req);

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = requireEnv('SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY');
  const transmissionId = await verifyWebhookSignature(req, raw);

  let event;
  try { event = raw.trim() ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'Invalid JSON body'); }

  const eventType = String(event?.event_type || '');
  const resource = event?.resource || {};
  const log = `payment-done ${transmissionId} ${eventType}`;

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // A capture completed — the money is ours. This is the event that credits.
  if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
    const result = await settleTopup(supa, {
      topupId: resource.custom_id,
      orderId: orderIdFromCapture(resource),
      captureId: resource.id,
      capturedCents: fromPayPalAmount(resource.amount?.value),
      label: 'paypal-webhook'
    });
    return res.status(200).json({ received: true, settled: result.settled, reason: result.reason });
  }

  // The payer approved but was never sent back to finish. Capture it here so
  // an abandoned tab does not leave a paid-for top-up unsettled.
  if (eventType === 'CHECKOUT.ORDER.APPROVED') {
    const orderId = resource.id;
    if (!orderId) return res.status(200).json({ received: true, ignored: 'no order id' });

    let order;
    try {
      order = await payPalFetch(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
        method: 'POST',
        headers: { 'PayPal-Request-Id': `capture-${orderId}` },
        body: {}
      });
    } catch (err) {
      if (hasIssue(err, 'ORDER_ALREADY_CAPTURED')) {
        // The browser return path got there first; PAYMENT.CAPTURE.COMPLETED
        // will settle it if that somehow did not.
        return res.status(200).json({ received: true, alreadyCaptured: true });
      }
      throw err;
    }

    const capture = readCapture(order);
    if (capture?.status !== 'COMPLETED') {
      console.warn(`[${log}] capture for ${orderId} came back ${capture?.status || 'empty'} — crediting nothing`);
      return res.status(200).json({ received: true, captureStatus: capture?.status || null });
    }

    const result = await settleTopup(supa, {
      topupId: capture.topupId,
      orderId,
      captureId: capture.id,
      capturedCents: fromPayPalAmount(capture.amountValue),
      label: 'paypal-webhook'
    });
    return res.status(200).json({ received: true, settled: result.settled, reason: result.reason });
  }

  // Money went back out. Mark the receipt so the top-up history is not a lie;
  // the balance is left alone deliberately — clawing back credit the fan has
  // already spent would drive it negative, and that is a decision for a human.
  if (eventType === 'PAYMENT.CAPTURE.REFUNDED' || eventType === 'PAYMENT.CAPTURE.REVERSED') {
    const captureId = resource.links?.find(l => l.rel === 'up')?.href?.split('/').pop() || resource.id;
    if (captureId) {
      await supa.from('topups').update({ status: 'failed' }).eq('provider_payment_id', captureId);
      console.warn(`[${log}] capture ${captureId} was refunded/reversed — receipt marked failed, balance left for manual review`);
    }
    return res.status(200).json({ received: true, refunded: true });
  }

  if (eventType === 'PAYMENT.CAPTURE.DENIED' || eventType === 'CHECKOUT.ORDER.VOIDED') {
    const topupId = resource.custom_id;
    if (topupId) await supa.from('topups').update({ status: 'failed' }).eq('id', topupId);
    return res.status(200).json({ received: true, failed: true });
  }

  // Acknowledge everything else so PayPal stops retrying it.
  console.log(`[${log}] no action for this event type`);
  return res.status(200).json({ received: true, ignored: eventType });
});

// A capture resource links back to its order with rel "up".
function orderIdFromCapture(resource){
  const up = resource?.links?.find(l => l.rel === 'up')?.href;
  if (!up) return null;
  const match = up.match(/\/checkout\/orders\/([^/?#]+)/);
  return match ? match[1] : null;
}
