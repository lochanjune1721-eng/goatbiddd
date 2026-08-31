// api/_paypal.js — PayPal REST client (Orders v2 + webhook verification).
//
// Hand-rolled over fetch rather than pulling in @paypal/paypal-server-sdk: the
// three calls this site makes are small, and a serverless bundle is cheaper
// without it. Field names and enum values below are the wire format from
// PayPal's own SDK, not guesses.
import { HttpError, requireEnv } from './_lib.js';

const LIVE = 'https://api-m.paypal.com';
const SANDBOX = 'https://api-m.sandbox.paypal.com';

export function payPalBase(){
  return process.env.PAYPAL_ENV === 'sandbox' ? SANDBOX : LIVE;
}

// Access tokens last ~9 hours. A warm serverless container can reuse one, so
// cache it and re-fetch a minute before it lapses.
let cachedToken = null;

async function getAccessToken(){
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;

  const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = requireEnv('PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET');
  const basic = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');

  const res = await fetch(`${payPalBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  const text = await res.text();
  if (!res.ok) {
    // Never log the body: it echoes back credentials on some error paths.
    console.error('[paypal] token request failed', res.status);
    throw new HttpError(502, `PayPal authentication failed (${res.status}). Check PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET and that PAYPAL_ENV matches the credentials.`);
  }

  let json;
  try { json = JSON.parse(text); } catch { throw new HttpError(502, 'PayPal returned a malformed token response'); }
  if (!json.access_token) throw new HttpError(502, 'PayPal returned no access token');

  const ttl = Number(json.expires_in) || 300;
  cachedToken = { value: json.access_token, expiresAt: Date.now() + (ttl - 60) * 1000 };
  return cachedToken.value;
}

// Calls a PayPal REST endpoint and returns the parsed body. `rawBody`, when
// given, is sent verbatim — the webhook verifier needs byte-exact JSON.
export async function payPalFetch(path, { method = 'GET', body, rawBody, headers = {} } = {}){
  const token = await getAccessToken();
  const payload = rawBody !== undefined ? rawBody : (body !== undefined ? JSON.stringify(body) : undefined);

  const res = await fetch(`${payPalBase()}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...headers
    },
    body: payload
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* handled below */ }

  if (!res.ok) {
    const err = new HttpError(502, describePayPalError(res.status, json, text));
    err.payPalStatus = res.status;
    err.payPalBody = json;
    throw err;
  }
  return json;
}

// PayPal returns { name, message, details: [{ issue, description }] }. Surface
// the issue code — it is the part that says what to actually change.
function describePayPalError(status, json, text){
  if (!json) return `PayPal returned ${status}: ${String(text).slice(0, 200)}`;
  const issues = Array.isArray(json.details)
    ? json.details.map(d => d.issue).filter(Boolean).join(', ')
    : '';
  return `PayPal returned ${status} ${json.name || ''}${issues ? ` (${issues})` : ''}: ${json.message || ''}`.trim();
}

// True when a failed call carries this PayPal issue code.
export function hasIssue(err, issue){
  return Array.isArray(err?.payPalBody?.details)
    && err.payPalBody.details.some(d => d.issue === issue);
}

// Ask PayPal whether a webhook delivery really came from PayPal.
//
// Verification is delegated to PayPal rather than checked locally against the
// signing certificate: it is the integration PayPal's own SDK uses, and it
// cannot be got subtly wrong in a way that silently accepts forgeries.
//
// `rawBody` is spliced into the request as-is instead of being re-serialised.
// The signature covers the exact bytes PayPal sent, and a round trip through
// JSON.parse/stringify can reorder keys or change escaping, which is the usual
// cause of a valid webhook failing verification.
export async function verifyWebhookSignature(req, rawBody){
  const { PAYPAL_WEBHOOK_ID } = requireEnv('PAYPAL_WEBHOOK_ID');

  const header = name => {
    const value = req.headers[name];
    if (Array.isArray(value)) return value.length ? String(value[0]) : '';
    return value ? String(value) : '';
  };

  const fields = {
    auth_algo: header('paypal-auth-algo'),
    cert_url: header('paypal-cert-url'),
    transmission_id: header('paypal-transmission-id'),
    transmission_sig: header('paypal-transmission-sig'),
    transmission_time: header('paypal-transmission-time'),
    webhook_id: PAYPAL_WEBHOOK_ID
  };

  const missing = Object.entries(fields).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new HttpError(401, `Missing webhook signature header(s): ${missing.join(', ')}`);

  // The certificate must be PayPal's own — cert_url arrives in an unverified
  // header, and a URL pointing anywhere else is an attempt to have PayPal
  // validate against a certificate the sender controls.
  let certHost;
  try { certHost = new URL(fields.cert_url).hostname; }
  catch { throw new HttpError(401, 'Malformed cert_url'); }
  if (certHost !== 'paypal.com' && !certHost.endsWith('.paypal.com')) {
    throw new HttpError(401, 'cert_url is not a PayPal host');
  }

  const verifyBody =
    '{' + Object.entries(fields).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',') +
    ',"webhook_event":' + rawBody + '}';

  const result = await payPalFetch('/v1/notifications/verify-webhook-signature', {
    method: 'POST',
    rawBody: verifyBody
  });

  if (result?.verification_status !== 'SUCCESS') {
    throw new HttpError(401, `Webhook signature not verified by PayPal (${result?.verification_status || 'no status'})`);
  }
  return fields.transmission_id;
}

// Cents to the decimal string PayPal wants ("50.00").
export function toPayPalAmount(cents){
  return (cents / 100).toFixed(2);
}

// PayPal amount string back to integer cents, for comparing against our own
// record of what was owed.
export function fromPayPalAmount(value){
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}
