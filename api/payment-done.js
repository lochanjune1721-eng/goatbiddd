import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { HttpError, readRawBodyText, requireEnv, requireMethod, withHandler } from './_lib.js';

// Dodo Payments webhook — confirm top-up, add credit to user's wallet.
//
// This endpoint mints wallet balance, so it is only ever as trustworthy as the
// signature check below: without one, anyone who finds the URL can POST a
// payload and credit themselves for free. It fails closed — no secret
// configured means no credit, not "credit anyway".

const TOLERANCE_SECONDS = 5 * 60;

function header(req, ...names){
  for (const name of names){
    const value = req.headers[name];
    if (Array.isArray(value)) { if (value.length) return String(value[0]); }
    else if (value) return String(value);
  }
  return '';
}

// Dodo signs with the Standard Webhooks scheme (standardwebhooks.com): the
// secret is base64 after a `whsec_` prefix. Dashboards vary in whether they
// show the prefix, and some integrations use the literal string as the key, so
// try both derivations of whatever was configured — an attacker knows neither.
function signingKeys(secret){
  const body = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const keys = [Buffer.from(body, 'utf8')];
  const decoded = Buffer.from(body, 'base64');
  if (decoded.length) keys.push(decoded);
  return keys;
}

function equals(a, b){
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Throws unless the request carries a valid signature over `raw`.
function verifySignature(req, raw, secret){
  const id = header(req, 'webhook-id', 'svix-id');
  const timestamp = header(req, 'webhook-timestamp', 'svix-timestamp');
  const signature = header(req, 'webhook-signature', 'svix-signature');
  if (!id || !timestamp || !signature) throw new HttpError(401, 'Missing webhook signature headers');

  // Reject replays of a captured-but-old delivery.
  const sent = Number(timestamp);
  if (!Number.isFinite(sent)) throw new HttpError(401, 'Malformed webhook timestamp');
  if (Math.abs(Date.now() / 1000 - sent) > TOLERANCE_SECONDS) throw new HttpError(401, 'Webhook timestamp outside tolerance');

  const signedPayload = `${id}.${timestamp}.${raw}`;
  const expected = signingKeys(secret).map(key =>
    crypto.createHmac('sha256', key).update(signedPayload).digest('base64')
  );

  // The header holds one or more space-separated "v1,<signature>" entries;
  // during a secret rotation more than one is present and any may match.
  const offered = signature.split(' ')
    .map(part => (part.includes(',') ? part.slice(part.indexOf(',') + 1) : part))
    .filter(Boolean);

  const ok = offered.some(sig => expected.some(exp => equals(sig, exp)));
  if (!ok) throw new HttpError(401, 'Invalid webhook signature');
  return id;
}

export default withHandler(async function handler(req, res){
  requireMethod(req, 'POST');

  // Before anything reads req.body — the raw bytes are what was signed.
  const raw = await readRawBodyText(req);

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DODO_WEBHOOK_SECRET } =
    requireEnv('SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'DODO_WEBHOOK_SECRET');

  const eventId = verifySignature(req, raw, DODO_WEBHOOK_SECRET);

  let body;
  try { body = raw.trim() ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'Invalid JSON body'); }
  if (!body || typeof body !== 'object') body = {};

  // Only a successful payment moves money. Everything else is acknowledged so
  // Dodo stops retrying, but credits nothing.
  const eventType = String(body.type || body.event_type || body.event || '').toLowerCase();
  if (eventType && !/succeed|success|complete|paid/.test(eventType)) {
    console.log(`[payment-done] ${eventId}: ignoring non-success event "${eventType}"`);
    return res.status(200).json({ received: true, ignored: eventType });
  }

  // Extract payment details from Dodo payload (support both root and nested data)
  const data = body.data || body;
  const dodoId = data.payment_id || data.paymentId || data.id || data.dodo_payment_id || body.payment_id;
  const metadata = data.metadata || body.metadata || {};
  const topupId = metadata.topup_id || data.topup_id;
  const userId = metadata.user_id || data.user_id || data.customer?.customer_id;
  const amount = metadata.amount_cents || data.total_amount || data.amount_cents || data.amount || 0;

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // 1. Find the topup record
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let topup = null;
  if (topupId && UUID.test(String(topupId))) {
    const { data: t } = await supa.from('topups').select('*').eq('id', topupId).maybeSingle();
    topup = t;
  }
  if (!topup && dodoId) {
    const { data: t } = await supa.from('topups').select('*').eq('dodo_payment_id', dodoId).maybeSingle();
    topup = t;
  }
  if (!topup && userId) {
    const { data: t } = await supa.from('topups').select('*').eq('user_id', userId).eq('status', 'pending').order('created_at', { ascending: false }).limit(1).maybeSingle();
    topup = t;
  }

  // The pending row this checkout created is the authority on the amount; the
  // payload's own figure is the fallback. Never invent one — a default here
  // would credit the wrong number of votes for every unmatched payment.
  const parsedAmount = Math.round(Number(amount));
  const cents = topup?.amount_cents
    || (Number.isFinite(parsedAmount) && parsedAmount > 0 ? parsedAmount : null);
  const targetUserId = topup?.user_id || userId;

  if (!targetUserId || !cents) {
    console.warn(`[payment-done] ${eventId}: cannot resolve user (${targetUserId}) or amount (${cents}) — crediting nothing`);
    return res.status(200).json({ received: true, warning: 'Could not resolve user or amount' });
  }

  if (topup && topup.status === 'confirmed') {
    return res.status(200).json({ received: true, duplicate: true });
  }

  const paymentId = dodoId || `dodo_${eventId}`;

  // 2 + 3. Settle the top-up and credit the wallet in one statement.
  // confirm_topup() is idempotent on dodo_payment_id and does the balance
  // update inside the database, so a retried delivery cannot double-credit and
  // two concurrent ones cannot lose an increment to a read-then-write race.
  const { data: newBalance, error: creditErr } = await supa.rpc('confirm_topup', {
    p_topup_id: topup?.id ?? null,
    p_user_id: targetUserId,
    p_amount_cents: cents,
    p_payment_id: paymentId
  });
  if (creditErr) throw new HttpError(500, `confirm_topup failed: ${creditErr.message}`);

  console.log(`[payment-done] ${eventId}: credited ${cents} cents (${cents / 100} votes) to ${targetUserId}. New balance: ${newBalance}`);
  return res.status(200).json({ received: true, credited: cents, newBalance });
});
