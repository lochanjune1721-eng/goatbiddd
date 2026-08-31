// /api/health.js — deployment diagnostics.
// Reports only whether each secret is PRESENT, never its value.
import { withHandler } from './_lib.js';
import { payPalBase } from './_paypal.js';

// All three PayPal values are required, not optional: without the client
// credentials a top-up cannot start, and without the webhook id the webhook
// refuses to credit a wallet. A site that cannot take money is not healthy,
// so say so here rather than letting the first paying visitor discover it.
const REQUIRED = ['SUPABASE_SERVICE_ROLE_KEY', 'ADMIN_PASSWORD', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID'];
const OPTIONAL = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SITE_URL', 'PAYPAL_ENV', 'RESOLVER_SECRET',
  'UROPAY_API_KEY', 'UROPAY_API_SECRET', 'INR_PER_VOTE', 'UROPAY_INR_PER_VOTE',
  'UPI_VPA', 'UPI_PAYEE_NAME'];

export default withHandler(async function handler(req, res){
  const present = name => Boolean(process.env[name]);
  const missing = REQUIRED.filter(n => !present(n));

  const checks = { supabaseClient: 'ok', imageResolver: 'ok' };
  try { await import('@supabase/supabase-js'); }
  catch (err) { checks.supabaseClient = `failed: ${err?.message || err}`; }
  try { await import('../scripts/wikimedia_resolver.mjs'); }
  catch (err) { checks.imageResolver = `failed: ${err?.message || err}`; }

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
    ready: present('UROPAY_API_KEY') && present('UROPAY_API_SECRET') && inrPerVote > 0
  };

  // Direct UPI needs only a VPA and a price. It cannot confirm payments by
  // itself, so it is always a reviewed rail — see api/_pay-upi.js.
  const upi = {
    configured: present('UPI_VPA') && present('UPI_PAYEE_NAME'),
    vpaConfigured: present('UPI_VPA'),
    inrPerVote,
    manualReview: true,
    ready: present('UPI_VPA') && present('UPI_PAYEE_NAME') && inrPerVote > 0
  };

  const degraded = missing.length > 0 || Object.values(checks).some(v => v !== 'ok');
  return res.status(degraded ? 503 : 200).json({
    ok: !degraded,
    node: process.version,
    region: process.env.VERCEL_REGION || null,
    paypal,
    uropay,
    upi,
    env: Object.fromEntries([...REQUIRED, ...OPTIONAL].map(n => [n, present(n)])),
    missingRequired: missing,
    checks
  });
});
