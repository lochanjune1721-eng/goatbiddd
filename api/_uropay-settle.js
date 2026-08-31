// api/_uropay-settle.js — the one place a UroPay order turns into votes.
//
// UroPay's own documentation calls the webhook a courtesy notification and
// names GET /v1/orders/{orderId} the source of truth, so nothing here trusts a
// payload: both the browser return and the webhook re-read the order and
// settle only on a PAID that UroPay itself reports.
import { getOrder } from './_uropay.js';
import { settleTopup } from './_settle.js';

export async function settleUroPayOrder(supa, { orderId, topupId, requireUserId, label }){
  const order = await getOrder(orderId);
  if (!order) return { settled: false, reason: 'order not found at UroPay', status: null };

  // PENDING is not a failure — the payer may still be completing the UPI
  // request in their bank app.
  if (order.status !== 'PAID') {
    return { settled: false, pending: order.status === 'PENDING', status: order.status, reason: reasonFor(order) };
  }

  const captured = Number(order.amount_captured ?? order.amount);

  const result = await settleTopup(supa, {
    topupId: topupId || order.tenantOrderRef,
    orderId,
    // The order id is the idempotency key: a UroPay order settles once, and
    // both the return path and the webhook key off the same value.
    captureId: order.id,
    capturedProviderAmount: Number.isFinite(captured) ? captured : undefined,
    requireUserId,
    provider: 'uropay',
    label
  });

  return { ...result, status: order.status };
}

// statusReason is only present on the GET response, never on the webhook.
function reasonFor(order){
  const map = {
    USER_DROPPED: 'the payment was left unfinished',
    USER_CANCELLED: 'the payment was cancelled',
    PG_CANCELLED: 'the bank cancelled the payment',
    CHECKOUT_CANCEL_BUTTON: 'the payment was cancelled at checkout',
    LIFETIME_EXPIRED: 'the payment window expired',
    PG_EXPIRED: 'the bank expired the payment'
  };
  return map[order.statusReason] || `UroPay reports the order as ${order.status}`;
}
