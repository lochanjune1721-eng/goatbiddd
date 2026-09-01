// api/_settle.js — the single place a completed PayPal payment turns into
// wallet credit. Both the return-from-PayPal capture and the webhook go
// through here so the two cannot disagree about the rules.
import { HttpError } from './_lib.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Locates the pending top-up a capture belongs to. The custom_id PayPal echoes
// back is the primary key; the order id is the fallback for a payload that
// somehow lost it.
async function findTopup(supa, { topupId, orderId, captureId }){
  if (topupId && UUID.test(String(topupId))) {
    const { data } = await supa.from('topups').select('*').eq('id', topupId).maybeSingle();
    if (data) return data;
  }
  if (orderId) {
    const { data } = await supa.from('topups').select('*').eq('provider_order_id', orderId).maybeSingle();
    if (data) return data;
  }
  if (captureId) {
    const { data } = await supa.from('topups').select('*').eq('provider_payment_id', captureId).maybeSingle();
    if (data) return data;
  }
  return null;
}

/**
 * Credits a wallet for a capture PayPal has confirmed as COMPLETED.
 *
 * The credited amount always comes from our own pending row, never from the
 * payload — a payer who tampers with the order cannot decide what they get.
 * The captured total is checked against it and a short payment is refused.
 *
 * `requireUserId`, when set, asserts the caller owns the top-up. The webhook
 * leaves it unset (PayPal is not a signed-in user); the browser return path
 * sets it, so one signed-in user cannot settle another's order.
 */
export async function settleTopup(supa, { topupId, orderId, captureId, capturedCents, capturedProviderAmount, requireUserId, provider = 'paypal', label = 'settle' }){
  if (!captureId) return { settled: false, reason: 'no capture id' };

  const topup = await findTopup(supa, { topupId, orderId, captureId });
  if (!topup) {
    // Deliberately not falling back to "credit them something": an unmatched
    // payment is a reconciliation problem, not a licence to guess an amount.
    console.warn(`[${label}] no pending top-up for capture ${captureId} (topup=${topupId} order=${orderId}) — crediting nothing`);
    return { settled: false, reason: 'no matching top-up' };
  }

  if (requireUserId && topup.user_id !== requireUserId) {
    throw new HttpError(403, 'That payment belongs to a different account');
  }

  if (topup.status === 'confirmed') {
    return { settled: true, duplicate: true, topup };
  }

  // Underpayment check, done in whatever currency the provider charged. A UPI
  // order is billed in rupees while the wallet is in USD cents, so comparing
  // capturedCents against amount_cents would be meaningless there — that path
  // passes capturedProviderAmount and is checked against provider_amount.
  const owed = Number.isFinite(capturedProviderAmount)
    ? { paid: capturedProviderAmount, due: Number(topup.provider_amount), unit: topup.provider_currency || 'provider units' }
    : (Number.isFinite(capturedCents) ? { paid: capturedCents, due: topup.amount_cents, unit: 'cents' } : null);

  if (owed && Number.isFinite(owed.due)) {
    if (owed.paid < owed.due) {
      console.error(`[${label}] payment ${captureId} paid ${owed.paid} ${owed.unit} against an owed ${owed.due} — refusing to credit`);
      await supa.from('topups').update({ status: 'failed' }).eq('id', topup.id);
      return { settled: false, reason: 'captured amount is less than the amount owed' };
    }
    if (owed.paid > owed.due) {
      console.warn(`[${label}] payment ${captureId} paid ${owed.paid} ${owed.unit} against an owed ${owed.due} — crediting the votes that were ordered`);
    }
  }

  const { data: newBalance, error } = await supa.rpc('confirm_topup', {
    p_topup_id: topup.id,
    p_user_id: topup.user_id,
    p_amount_cents: topup.amount_cents,
    p_payment_id: captureId,
    p_provider: provider
  });
  if (error) throw new HttpError(500, `confirm_topup failed: ${error.message}`);

  console.log(`[${label}] credited ${topup.amount_cents} cents (${topup.amount_cents / 100} votes of credit) to ${topup.user_id} for capture ${captureId}; balance ${newBalance}`);
  return { settled: true, topup, newBalance, credited: topup.amount_cents };
}

// Pulls the capture out of an Orders v2 order (as returned by both the capture
// call and a plain GET of an already-captured order).
export function readCapture(order){
  const unit = order?.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];
  if (!capture) return null;
  return {
    id: capture.id,
    status: capture.status,
    amountValue: capture.amount?.value,
    topupId: capture.custom_id || unit.custom_id || unit.reference_id || null
  };
}
