// api/_uropay.js — UroPay Merchant API v1 (UPI).
//
// Every request, inbound and outbound, is signed with HMAC-SHA256 over a
// canonical string. The scheme is symmetric: UroPay signs its webhook to us
// with the same construction, differing only in the path.
import crypto from 'node:crypto';
import { HttpError, requireEnv } from './_lib.js';

const API_ORIGIN = 'https://api.uropai.in';

// Their replay window, applied to their webhooks as well as our requests.
const MAX_AGE_SECONDS = 300;
const MAX_SKEW_SECONDS = 30;

// TEST and PRODUCTION are chosen by which key signs the request — there is no
// environment header. A production key is refused until KYC passes.
function credentials(){
  const { UROPAY_API_KEY, UROPAY_API_SECRET } = requireEnv('UROPAY_API_KEY', 'UROPAY_API_SECRET');
  return { key: UROPAY_API_KEY, secret: UROPAY_API_SECRET };
}

// The docs sign webhooks with the same merchant secret as outbound requests,
// but the dashboard issues a separate UROPAY_WEBHOOK_SECRET. Prefer that when
// it is set — if the two ever differ, the dedicated one is the truth for
// inbound deliveries — and fall back to the API secret, which is what the
// documented example uses.
function webhookSecret(){
  const dedicated = process.env.UROPAY_WEBHOOK_SECRET;
  if (dedicated) return dedicated;
  const { UROPAY_API_SECRET } = requireEnv('UROPAY_API_SECRET');
  return UROPAY_API_SECRET;
}

export function isConfigured(){
  return Boolean(process.env.UROPAY_API_KEY && process.env.UROPAY_API_SECRET);
}

// ${method}\n${path}\n${timestamp}\n${nonce}\n${queryString}\n${rawBody}
// `path` is the pathname alone and never carries the query string; `query` has
// no leading "?" and is empty when there is none.
function canonicalString(method, path, timestamp, nonce, query, rawBody){
  return [method, path, timestamp, nonce, query || '', rawBody || ''].join('\n');
}

function hmacHex(canonical, secret){
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
}

function signedHeaders(method, path, query, rawBody){
  const { key, secret } = credentials();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID();   // must be unique per request; reuse is rejected
  return {
    'X-Api-Key': key,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Signature': hmacHex(canonicalString(method, path, timestamp, nonce, query, rawBody), secret)
  };
}

// Calls the Merchant API and unwraps the { code, status, message, data }
// envelope. Errors carry UroPay's own message, which names the problem —
// an amount under the derived minimum, a replayed tenantOrderRef, KYC.
export async function uroPayFetch(path, { method = 'GET', query = '', body } = {}){
  const rawBody = body === undefined ? '' : JSON.stringify(body);
  const headers = signedHeaders(method, path, query, rawBody);
  if (rawBody) headers['Content-Type'] = 'application/json';

  const url = API_ORIGIN + path + (query ? `?${query}` : '');
  let res;
  try {
    res = await fetch(url, { method, headers, body: rawBody || undefined });
  } catch (err) {
    throw new HttpError(502, `UroPay is unreachable: ${err?.message || err}`);
  }

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* handled below */ }

  if (!res.ok) {
    const message = json?.message || String(text).slice(0, 200);
    // 403 means the production key is live but the account has not cleared KYC.
    const err = new HttpError(res.status === 403 ? 503 : 502, `UroPay ${res.status}: ${message}`);
    err.uroPayStatus = res.status;
    err.uroPayBody = json;
    throw err;
  }
  return json?.data ?? null;
}

export function createOrder(order){
  return uroPayFetch('/v1/orders', { method: 'POST', body: order });
}

// The authoritative status. The webhook is explicitly advisory, so nothing is
// credited until this call confirms it.
export function getOrder(orderId){
  return uroPayFetch(`/v1/orders/${encodeURIComponent(orderId)}`);
}

function header(req, name){
  const v = req.headers[name];
  if (Array.isArray(v)) return v.length ? String(v[0]) : '';
  return v ? String(v) : '';
}

// Verifies an inbound order-status webhook. Same HMAC construction as our own
// requests, with path '/tenant-webhook' and an empty query string.
export function verifyWebhook(req, rawBody){
  const { key } = credentials();
  const secret = webhookSecret();

  const apiKey = header(req, 'x-api-key');
  const timestamp = header(req, 'x-timestamp');
  const nonce = header(req, 'x-nonce');
  const signature = header(req, 'x-signature');
  if (!apiKey || !timestamp || !nonce || !signature) throw new HttpError(401, 'Missing UroPay signature headers');

  // Compared in constant time: this value is attacker-supplied.
  const keyBuf = Buffer.from(key, 'utf8');
  const sentKeyBuf = Buffer.from(apiKey, 'utf8');
  if (keyBuf.length !== sentKeyBuf.length || !crypto.timingSafeEqual(keyBuf, sentKeyBuf)) {
    throw new HttpError(401, 'Unknown UroPay API key');
  }

  const sent = Number(timestamp);
  if (!Number.isFinite(sent)) throw new HttpError(401, 'Malformed UroPay timestamp');
  const now = Math.floor(Date.now() / 1000);
  if (now - sent > MAX_AGE_SECONDS) throw new HttpError(401, 'UroPay webhook is too old');
  if (sent - now > MAX_SKEW_SECONDS) throw new HttpError(401, 'UroPay webhook timestamp is in the future');

  const expected = hmacHex(canonicalString('POST', '/tenant-webhook', timestamp, nonce, '', rawBody), secret);
  const expectedBuf = Buffer.from(expected, 'hex');

  let actualBuf;
  try { actualBuf = Buffer.from(signature, 'hex'); }
  catch { throw new HttpError(401, 'Malformed UroPay signature'); }

  if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    throw new HttpError(401, 'UroPay signature verification failed');
  }
  return { nonce, timestamp };
}

// Both Indian rails price a vote the same way.
export { rupeesForVotes, rupeesForCents } from './_pricing.js';
