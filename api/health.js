// /api/health.js — deployment diagnostics.
// Reports only whether each secret is PRESENT, never its value.
import { withHandler, nearMiss } from './_lib.js';
import { payPalBase } from './_paypal.js';
import { upiVpa, upiPayeeName } from './_pay-upi.js';

// All three PayPal values are required, not optional: without the client
// credentials a top-up cannot start, and without the webhook id the webhook
// refuses to credit a wallet. A site that cannot take money is not healthy,
// so say so here rather than letting the first paying visitor discover it.
const REQUIRED = ['SUPABASE_SERVICE_ROLE_KEY', 'ADMIN_PASSWORD', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID'];
const OPTIONAL = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SITE_URL', 'PAYPAL_ENV', 'RESOLVER_SECRET',
  'UROPAY_API_KEY', 'UROPAY_API_SECRET', 'UROPAY_WEBHOOK_SECRET',
  'INR_PER_VOTE', 'UROPAY_INR_PER_VOTE',
  'UROPAY_VPA', 'UPI_VPA', 'UPI_PAYEE_NAME'];

// India pays in rupees, everyone else pays by card. Splitting it here means
// the wallet page renders one list and never has to hold the policy itself.
// A rail that is not configured is never offered, whatever the country: an
// offered button that 503s is worse than a button that was never there.
//
// India is deliberately given ONE rail, direct UPI, not a choice between two.
// Two buttons that both say "UPI" is a decision the payer has no basis to
// make, and UroPay is only distinguishable to us. UroPay stays wired up and
// tested as a fallback for when direct UPI has no VPA configured — a fallback,
// never a second button.
export function railsFor(country, ready){
  const inIndia = country === 'IN';
  const offer = [];
  if (inIndia) {
    if (ready.upiReady) offer.push('upi');
    else if (ready.uropayReady) offer.push('uropay');
    // Nothing rupee-denominated is configured — fall back rather than leaving
    // an Indian visitor with no way to pay at all.
    else if (ready.paypalReady) offer.push('paypal');
  } else {
    if (ready.paypalReady) offer.push('paypal');
  }
  return { country: country || null, inIndia, offer, currency: inIndia && offer[0] !== 'paypal' ? 'INR' : 'USD' };
}

export default withHandler(async function handler(req, res){
  const present = name => Boolean(process.env[name]);
  const missing = REQUIRED.filter(n => !present(n));

  const checks = { supabaseClient: 'ok' };
  try { await import('@supabase/supabase-js'); }
  catch (err) { checks.supabaseClient = `failed: ${err?.message || err}`; }

  // Live credentials do not work against sandbox and vice versa, and the error
  // PayPal returns for the mismatch is an unhelpful 401. Say plainly which one
  // this deployment is pointed at.
  const paypal = {
    env: process.env.PAYPAL_ENV === 'sandbox' ? 'sandbox' : 'live',
    api: payPalBase(),
    credentialsConfigured: present('PAYPAL_CLIENT_ID') && present('PAYPAL_CLIENT_SECRET'),
    webhookConfigured: present('PAYPAL_WEBHOOK_ID')
  };

  // UPI is an additional rail, so its absence is not "unhealthy" — but a
  // half-configured one is worth surfacing, since the checkout refuses without
  // a rupee price and the account's KYC state decides TEST vs PRODUCTION.
  const inrPerVote = Number(process.env.INR_PER_VOTE || process.env.UROPAY_INR_PER_VOTE) || null;
  const uropay = {
    configured: present('UROPAY_API_KEY') && present('UROPAY_API_SECRET'),
    inrPerVote,
    // Which secret verifies inbound webhooks, so a mismatch is visible.
    webhookSecret: present('UROPAY_WEBHOOK_SECRET') ? 'UROPAY_WEBHOOK_SECRET' : 'UROPAY_API_SECRET',
    ready: present('UROPAY_API_KEY') && present('UROPAY_API_SECRET') && inrPerVote > 0
  };

  // Direct UPI needs only a VPA and a price. It cannot confirm payments by
  // itself, so it is always a reviewed rail — see api/_pay-upi.js.
  // UROPAY_VPA and UPI_VPA are the same setting under two names.
  const vpa = upiVpa();
  const upi = {
    configured: Boolean(vpa),
    vpa: vpa ? vpa.replace(/^(.{2}).*(@.*)$/, '$1***$2') : null,
    payeeName: upiPayeeName(),
    inrPerVote,
    manualReview: true,
    ready: Boolean(vpa) && inrPerVote > 0
  };

  // Which host is actually answering, and from where. Secrets are set per
  // platform, so "I added it and it still says missing" is usually a value set
  // on one host while the domain is served by another.
  const onWorkers = Boolean(req?.cf) || (typeof navigator !== 'undefined' && /Cloudflare/i.test(navigator.userAgent || ''));
  const platform = onWorkers ? 'cloudflare-workers' : 'node';

  // Where the visitor is, as Cloudflare sees them (ISO-3166-1 alpha-2). The
  // wallet uses this to decide which rails to offer: a UPI deep link is
  // useless outside India, and a rupee price is meaningless to someone paying
  // in dollars. Presentational only — it decides what is shown, never what is
  // allowed, so a VPN or a null here degrades to the international rail rather
  // than locking anyone out.
  const country = req?.cf?.country || null;

  // A variable can be set correctly and still read as missing because it is
  // under a near-miss name — VITE_PAYPAL_CLIENT_ID rather than
  // PAYPAL_CLIENT_ID, say. Reporting only `false` sends you to re-check a
  // dashboard that already looks right, so name the value that is actually
  // there. Only names, never values.
  const renameTo = {};
  for (const name of [...REQUIRED, ...OPTIONAL]) {
    if (present(name)) continue;
    const alt = nearMiss(name);
    if (alt) renameTo[alt] = name;
  }

  const degraded = missing.length > 0 || Object.values(checks).some(v => v !== 'ok');
  return res.status(degraded ? 503 : 200).json({
    ok: !degraded,
    platform,
    runtime: typeof process !== 'undefined' ? process.version : null,
    colo: req?.cf?.colo || null,
    country,
    // Which rails to offer this visitor, decided server-side so the page does
    // not have to know the rule. India gets the rupee rails; everyone else
    // gets the card rail.
    rails: railsFor(country, { upiReady: upi.ready, uropayReady: uropay.ready, paypalReady: paypal.credentialsConfigured }),
    paypal,
    uropay,
    upi,
    env: Object.fromEntries([...REQUIRED, ...OPTIONAL].map(n => [n, present(n)])),
    missingRequired: missing,
    // { nameYouSet: nameTheCodeReads } — rename these and they take effect.
    renameTo,
    checks
  });
});
