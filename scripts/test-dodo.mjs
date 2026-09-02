// scripts/test-dodo.mjs — the two parts of the Dodo rail that must not be wrong.
//
//   node scripts/test-dodo.mjs
//
// The webhook signature is what stands between "Dodo says this was paid" and
// "anyone who knows the URL says this was paid", and it is the path that grants
// credit. And railsFor decides which processor the checkout actually calls, so
// a wrong answer there is a payer sent to a rail that is not configured.
//
// Neither needs a network or a database, so both are checked properly rather
// than by reading them.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const SECRET_RAW = crypto.randomBytes(24).toString('base64');
process.env.DODO_WEBHOOK_SECRET = 'whsec_' + SECRET_RAW;

const { verifyWebhook } = await import('../api/_dodo.js');
const { railsFor } = await import('../api/health.js');

const now = () => Math.floor(Date.now() / 1000);
function sign(id, ts, body, secretB64 = SECRET_RAW){
  return crypto.createHmac('sha256', Buffer.from(secretB64, 'base64'))
    .update(`${id}.${ts}.${body}`).digest('base64');
}
const body = JSON.stringify({ type:'payment.succeeded', data:{ payment_id:'pay_1', status:'succeeded' } });

function headers(over = {}){
  const id = 'msg_1', ts = String(now());
  return { 'webhook-id': id, 'webhook-timestamp': ts,
           'webhook-signature': 'v1,' + sign(id, ts, body), ...over };
}
const refuses = (h, b, why) => {
  assert.throws(() => verifyWebhook(h, b), why);
};

// ── A genuine delivery ──────────────────────────────────────────────────────
assert.equal(verifyWebhook(headers(), body), true, 'a correctly signed body must verify');

// Header names arrive lowercased on some runtimes and not others.
{
  const h = headers();
  const upper = { 'Webhook-Id': h['webhook-id'], 'Webhook-Timestamp': h['webhook-timestamp'],
                  'Webhook-Signature': h['webhook-signature'] };
  assert.equal(verifyWebhook(upper, body), true, 'header lookup must not be case sensitive');
}

// A secret stored without the whsec_ prefix is the same secret.
{
  process.env.DODO_WEBHOOK_SECRET = SECRET_RAW;
  assert.equal(verifyWebhook(headers(), body), true, 'the whsec_ prefix is optional');
  process.env.DODO_WEBHOOK_SECRET = 'whsec_' + SECRET_RAW;
}

// During a rotation Dodo sends both signatures; one valid is enough.
{
  const id = 'msg_2', ts = String(now());
  const old = crypto.createHmac('sha256', crypto.randomBytes(24)).update('nonsense').digest('base64');
  const h = { 'webhook-id': id, 'webhook-timestamp': ts,
              'webhook-signature': `v1,${old} v1,${sign(id, ts, body)}` };
  assert.equal(verifyWebhook(h, body), true, 'one of several offered signatures matching is enough');
}

// ── Everything that must be refused ─────────────────────────────────────────

// The whole point: a body nobody signed cannot grant credit.
refuses(headers({ 'webhook-signature': 'v1,' + Buffer.from('not-a-signature').toString('base64') }),
        body, /did not verify/);

// A body altered after signing — the amount raised, say.
{
  const tampered = JSON.stringify({ type:'payment.succeeded', data:{ payment_id:'pay_1', status:'succeeded', total_amount: 999999 } });
  refuses(headers(), tampered, /did not verify/);
}

// A real delivery, captured and replayed days later.
{
  const id = 'msg_3', ts = String(now() - 4000);
  refuses({ 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': 'v1,' + sign(id, ts, body) },
          body, /tolerance window/);
}

// Signed for a different message id — a signature lifted from another delivery.
{
  const ts = String(now());
  refuses({ 'webhook-id': 'msg_4', 'webhook-timestamp': ts, 'webhook-signature': 'v1,' + sign('msg_other', ts, body) },
          body, /did not verify/);
}

// Signed with somebody else's secret.
refuses({ 'webhook-id':'msg_5', 'webhook-timestamp':String(now()),
          'webhook-signature':'v1,' + sign('msg_5', String(now()), body, crypto.randomBytes(24).toString('base64')) },
        body, /did not verify/);

for(const missing of ['webhook-id', 'webhook-timestamp', 'webhook-signature']){
  const h = headers(); delete h[missing];
  refuses(h, body, /Missing webhook signature headers/);
}

console.log('PASS — the webhook only credits bodies Dodo actually signed');

// ── Which rail the checkout offers ─────────────────────────────────────────
{
  const ready = railsFor('US', { dodoReady:true, upiReady:false });
  assert.equal(ready.cardProvider, 'dodo', 'Dodo is the card processor');
  assert.deepEqual(ready.offer, ['card'], 'the payer is offered a rail, not a company');
  assert.equal(ready.preferred, 'card');
  assert.equal(ready.currency, 'USD');

  // Card is preferred in India too: Dodo's checkout offers UPI there and
  // confirms it, where direct UPI needs a person to match the reference.
  const india = railsFor('IN', { dodoReady:true, upiReady:true });
  assert.equal(india.preferred, 'card', 'an Indian payer lands on the rail that confirms itself');
  assert.deepEqual(india.offer, ['card', 'upi'], 'direct UPI is still there, just not the default');
  assert.equal(india.upiAutoConfirms, false, 'direct UPI can never confirm itself');

  // With no card processor the rail is simply absent, not a button that fails.
  const upiOnly = railsFor('IN', { dodoReady:false, upiReady:true });
  assert.deepEqual(upiOnly.offer, ['upi']);
  assert.equal(upiOnly.cardProvider, null, 'there is no processor to fall back to any more');
  assert.equal(upiOnly.currency, 'INR');

  const none = railsFor('US', { dodoReady:false, upiReady:false });
  assert.deepEqual(none.offer, [], 'nothing configured means no rail rather than a broken button');
  assert.equal(none.preferred, null);
}
console.log('PASS — card is the rail, Dodo is the only thing behind it');
