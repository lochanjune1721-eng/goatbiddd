// /api/health.js — deployment diagnostics.
// Reports only whether each secret is PRESENT, never its value.
import { withHandler, nearMiss, demoMode } from './_lib.js';
import { isConfigured as dodoConfigured, mode as dodoMode } from './_dodo.js';
import { upiVpa, upiPayeeName } from './_pay-upi.js';
import { publicTiers } from './_pricing.js';

// Required means the site cannot serve at all without it. A payment rail is not
// on that list: a missing key closes the checkout, which the rail blocks below
// report plainly, rather than making the whole site read as unhealthy.
const REQUIRED = ['SUPABASE_SERVICE_ROLE_KEY', 'ADMIN_PASSWORD'];
const OPTIONAL = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SITE_URL', 'RESOLVER_SECRET',
  'INR_PER_VOTE', 'UPI_VPA', 'UPI_PAYEE_NAME',
  // Listed so "did the secret actually land on the Worker" is answerable from
  // this page. A secret set on the wrong project, or saved as a plaintext
  // Variable and then wiped by the next deploy, both read as false here.
  'DODO_API_KEY', 'DODO_WEBHOOK_SECRET', 'DODO_PRODUCT_ID', 'DODO_MODE'];

// Which rails to draw, and what backs each one.
//
// The page sees two ideas: "card" and "UPI". Which company processes the UPI
// payment is our problem, not the payer's, so it is resolved here:
//
//   direct — pay our VPA straight. No callback exists for that, so it can only
//            be settled by a human matching the reference. A fallback, never
//            the default.
//
// Both rails are offered wherever both work; the country only decides which one
// is preselected, because a UPI app is what an Indian payer reaches for and a
// card is what everyone else reaches for.
export function railsFor(country, ready){
  const inIndia = country === 'IN';

  const offer = [];
  if (ready.dodoReady) offer.push('card');
  if (ready.upiReady) offer.push('upi');

  // Card is preferred wherever it works, including India — Dodo's own checkout
  // offers UPI to an Indian payer and confirms it by itself. Direct UPI is the
  // fallback and cannot confirm anything: it is our VPA, with no callback, so a
  // person has to match the reference by hand. Preselecting that would make
  // every Indian top-up a manual job.
  const preferred = offer.includes('card') ? 'card' : (offer[0] || null);

  return {
    country: country || null,
    inIndia,
    offer,
    preferred,
    cardProvider: ready.dodoReady ? 'dodo' : null,
    upiProvider: ready.upiReady ? 'direct' : null,
    // Direct UPI cannot confirm itself. The page says so rather than promising
    // votes that need a human first.
    upiAutoConfirms: false,
    currency: preferred === 'upi' ? 'INR' : 'USD'
  };
}

export default withHandler(async function handler(req, res){
  const present = name => Boolean(process.env[name]);
  const missing = REQUIRED.filter(n => !present(n));

  const checks = { supabaseClient: 'ok' };
  try { await import('@supabase/supabase-js'); }
  catch (err) { checks.supabaseClient = `failed: ${err?.message || err}`; }

  // The only card processor. Reported whatever is set, so "is the rail actually
  // able to take money" is answerable from one page rather than by trying it.
  const dodo = {
    configured: dodoConfigured(),
    mode: dodoMode(),
    webhookConfigured: present('DODO_WEBHOOK_SECRET'),
    // Dodo bills against products. Without one the amount is sent on its own,
    // which only works on accounts that allow it — worth seeing here.
    productConfigured: present('DODO_PRODUCT_ID'),
    ready: dodoConfigured() && present('DODO_WEBHOOK_SECRET')
  };

  // Direct UPI needs only a VPA and a price. It cannot confirm payments by
  // itself, so it is always a reviewed rail — see api/_pay-upi.js.
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
  // under a near-miss name — VITE_DODO_API_KEY rather than
  // DODO_API_KEY, say. Reporting only `false` sends you to re-check a
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
    demo: demoMode(),
    // In a demonstration build no rail is offered at all, whatever is
    // configured — the checkout then says payments are unavailable rather than
    // opening an order nothing can settle.
    rails: demoMode()
      ? { country, inIndia: country === 'IN', offer: [], preferred: null, upiProvider: null,
          upiAutoConfirms: false, currency: country === 'IN' ? 'INR' : 'USD',
          blocked: 'This is a demonstration build — payments are disabled.' }
      : railsFor(country, { upiReady: upi.ready, dodoReady: dodo.configured }),
    // The price list the checkout draws its buttons from, so the page can never
    // advertise a bonus the server will not honour.
    tiers: publicTiers(),
    dodo,
    upi,
    env: Object.fromEntries([...REQUIRED, ...OPTIONAL].map(n => [n, present(n)])),
    missingRequired: missing,
    // { nameYouSet: nameTheCodeReads } — rename these and they take effect.
    renameTo,
    checks
  });
});
