// api/_dodo.js — Dodo Payments client.
//
// One place for everything Dodo-specific: the host, the request shape, the
// response field names, and the webhook signature. Nothing else in the codebase
// knows Dodo exists, so when a detail here turns out to differ from their docs
// it is corrected once, here, and the rest of the rail is unaffected.
//
// ── Read this before taking a real payment ─────────────────────────────────
//
// The CONTRACT block below is my reading of Dodo's REST API. I could not reach
// their documentation from the machine this was written on, so treat those
// three constants and two field names as the part to verify, not as settled.
// Everything else — what gets recorded, what gets credited, how a duplicate
// webhook is ignored — is ours and does not depend on being right about them.
//
// The fastest way to check: set DODO_API_KEY to a TEST key, leave DODO_MODE
// unset, and open a $1 top-up. `GET /api/health?rail=dodo` reports what Dodo
// actually answered, so a wrong path or field name shows up as a plain message
// rather than as a payer stuck on a blank page.
import crypto from 'node:crypto';
import { HttpError, requireEnv } from './_lib.js';

// ── CONTRACT — verify these against your Dodo dashboard/docs ───────────────
const HOSTS = {
  live: 'https://live.dodopayments.com',
  test: 'https://test.dodopayments.com'
};
// Where a one-time payment is created, and the two fields we need back from it.
const CREATE_PATH   = '/payments';
const FIELD_LINK    = 'payment_link';   // the URL to send the payer to
const FIELD_ID      = 'payment_id';     // Dodo's id for the payment
// ── end CONTRACT ───────────────────────────────────────────────────────────

// Test unless explicitly told otherwise. A rail that defaults to live is one
// misconfigured deploy away from charging somebody during a smoke test.
function origin(){
  return String(process.env.DODO_MODE || '').toLowerCase() === 'live' ? HOSTS.live : HOSTS.test;
}

export function isConfigured(){
  return Boolean(process.env.DODO_API_KEY);
}

export function mode(){
  return String(process.env.DODO_MODE || '').toLowerCase() === 'live' ? 'live' : 'test';
}

async function call(path, { method = 'POST', body } = {}){
  const { DODO_API_KEY } = requireEnv('DODO_API_KEY');
  const url = origin() + path;

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${DODO_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (err) {
    throw new HttpError(502, `Could not reach Dodo Payments (${err?.message || err}). Nothing has been charged.`);
  }

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) {}

  if (!res.ok) {
    // Dodo's own message, verbatim — a wrong product id or a missing field says
    // so, and guessing from a status code wastes an afternoon.
    const detail = json?.message || json?.error?.message || json?.detail || text.slice(0, 300) || res.statusText;
    throw new HttpError(res.status === 401 ? 500 : 502,
      `Dodo Payments refused the request (${res.status}): ${detail}`);
  }
  return json;
}

/**
 * Opens a one-time payment and returns { url, id, raw }.
 *
 * `reference` is our topups row id. It travels in metadata and comes back on
 * the webhook, which is how a payment is matched to what was actually asked
 * for rather than to whatever the payload claims.
 *
 * Amount handling is the one thing that differs between Dodo accounts. Dodo
 * bills against products, so a wallet that takes any amount needs either a
 * "pay what you want" product (DODO_PRODUCT_ID, amount sent per payment) or a
 * fixed-price one per tier. DODO_PRODUCT_ID selects the first; without it the
 * amount is sent on its own, which only works on accounts that allow it.
 */
export async function createPayment({ reference, amountCents, currency = 'USD', customer, returnUrl }){
  const productId = process.env.DODO_PRODUCT_ID;

  const body = {
    payment_link: true,
    return_url: returnUrl,
    customer,
    billing: { country: 'US', state: '', city: '', street: '', zipcode: '' },
    metadata: { topup_id: String(reference) },
    ...(productId
      ? { product_cart: [{ product_id: productId, quantity: 1, amount: amountCents }] }
      : { amount: amountCents, currency })
  };

  const json = await call(CREATE_PATH, { body });
  const url = json?.[FIELD_LINK] || json?.url || json?.checkout_url || null;
  const id  = json?.[FIELD_ID]   || json?.id  || null;

  if (!url) {
    console.error('[dodo] created a payment with no link:', JSON.stringify(json).slice(0, 600));
    throw new HttpError(502, 'Dodo Payments did not return a checkout link. Nothing has been charged.');
  }
  return { url, id, raw: json };
}

export async function getPayment(paymentId){
  return call(`${CREATE_PATH}/${encodeURIComponent(paymentId)}`, { method: 'GET' });
}

// ── Webhook signature ──────────────────────────────────────────────────────
//
// Dodo signs with Standard Webhooks (standardwebhooks.com), which is a
// published spec rather than a Dodo invention: HMAC-SHA256 over
// "{id}.{timestamp}.{body}", base64, sent as "v1,<sig>" — possibly several
// space-separated, during a secret rotation. The secret is base64 after the
// "whsec_" prefix.
//
// Verified over the RAW body. Re-serialising a parsed object changes the bytes
// and every signature then fails.
const TOLERANCE_SECONDS = 300;

export function verifyWebhook(headers, rawBody){
  const { DODO_WEBHOOK_SECRET } = requireEnv('DODO_WEBHOOK_SECRET');

  // The Worker adapter lowercases header names into a plain object and Node
  // does the same, but a Headers instance or a runtime that preserves case
  // would silently produce "missing headers" on a delivery that is perfectly
  // signed — and the failure would look like a signature problem. So handle
  // every shape rather than assume one.
  const get = n => {
    if (!headers) return '';
    if (typeof headers.get === 'function') return headers.get(n) || '';
    if (headers[n] != null) return headers[n];
    const want = n.toLowerCase();
    for (const k of Object.keys(headers)) if (k.toLowerCase() === want) return headers[k];
    return '';
  };
  const id        = get('webhook-id');
  const timestamp = get('webhook-timestamp');
  const signature = get('webhook-signature');
  if (!id || !timestamp || !signature) {
    throw new HttpError(400, 'Missing webhook signature headers');
  }

  // A replayed delivery from days ago must not settle anything today.
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > TOLERANCE_SECONDS) {
    throw new HttpError(400, 'Webhook timestamp is outside the tolerance window');
  }

  const raw = DODO_WEBHOOK_SECRET.startsWith('whsec_')
    ? DODO_WEBHOOK_SECRET.slice(6) : DODO_WEBHOOK_SECRET;
  const key = Buffer.from(raw, 'base64');

  const expected = crypto.createHmac('sha256', key)
    .update(`${id}.${timestamp}.${rawBody}`).digest('base64');

  // Constant-time against each offered signature: a rotation sends both the old
  // and the new, and only one of them has to match.
  const offered = String(signature).split(' ')
    .map(s => s.includes(',') ? s.slice(s.indexOf(',') + 1) : s)
    .filter(Boolean);

  const want = Buffer.from(expected);
  const ok = offered.some(sig => {
    const got = Buffer.from(sig);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  });

  if (!ok) throw new HttpError(401, 'Webhook signature did not verify');
  return true;
}
