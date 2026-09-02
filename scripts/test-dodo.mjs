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

// ── Which processor the checkout calls ──────────────────────────────────────
{
  const both = railsFor('US', { dodoReady:true, paypalReady:true, upiReady:false, uropayReady:false });
  assert.equal(both.cardProvider, 'dodo', 'Dodo takes the card rail when it is configured');
  assert.deepEqual(both.offer, ['card'], 'the payer is offered a rail, not a company');
  assert.equal(both.preferred, 'card');

  const fallback = railsFor('US', { dodoReady:false, paypalReady:true, upiReady:false, uropayReady:false });
  assert.equal(fallback.cardProvider, 'paypal', 'PayPal still takes it when Dodo is not configured');
  assert.deepEqual(fallback.offer, ['card']);

  const none = railsFor('US', { dodoReady:false, paypalReady:false, upiReady:false, uropayReady:false });
  assert.deepEqual(none.offer, [], 'no processor means no card rail rather than a broken button');
  assert.equal(none.cardProvider, null);

  const india = railsFor('IN', { dodoReady:true, paypalReady:false, upiReady:true, uropayReady:true });
  assert.equal(india.preferred, 'upi', 'an Indian account still lands on UPI');
  assert.deepEqual(india.offer, ['upi', 'card'], 'and card is still there, not hidden');
}
console.log('PASS — the card rail resolves to Dodo, and falls back rather than breaking');
