// /api/health.js — deployment diagnostics.
// Reports only whether each secret is PRESENT, never its value.
import { withHandler } from './_lib.js';

// Both Dodo values are required, not optional: without the API key a top-up
// cannot start, and without the signing secret the webhook refuses to credit a
// wallet. A site that cannot take money is not healthy, so say so here rather
// than letting the first paying visitor discover it.
const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ADMIN_PASSWORD', 'DODO_API_KEY', 'DODO_WEBHOOK_SECRET'];
const OPTIONAL = ['SUPABASE_ANON_KEY', 'SITE_URL', 'RESOLVER_SECRET'];

export default withHandler(async function handler(req, res){
  const present = name => Boolean(process.env[name]);
  const missing = REQUIRED.filter(n => !present(n));

  const checks = { supabaseClient: 'ok', imageResolver: 'ok' };
  try { await import('@supabase/supabase-js'); }
  catch (err) { checks.supabaseClient = `failed: ${err?.message || err}`; }
  try { await import('../scripts/wikimedia_resolver.mjs'); }
  catch (err) { checks.imageResolver = `failed: ${err?.message || err}`; }

  const degraded = missing.length > 0 || Object.values(checks).some(v => v !== 'ok');
  return res.status(degraded ? 503 : 200).json({
    ok: !degraded,
    node: process.version,
    region: process.env.VERCEL_REGION || null,
    env: Object.fromEntries([...REQUIRED, ...OPTIONAL].map(n => [n, present(n)])),
    missingRequired: missing,
    checks
  });
});
