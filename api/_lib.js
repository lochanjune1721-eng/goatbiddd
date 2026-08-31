// api/_lib.js — shared helpers for the serverless functions.
// Files prefixed with "_" are helpers, not routes.
//
// An uncaught throw inside a handler becomes an opaque 500 with no usable
// body, so every route goes through withHandler() and every request body
// through readJsonBody(). That turns a crash into a JSON response you can
// read.

export class HttpError extends Error {
  constructor(status, message){
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

async function readRawBody(req){
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// The exact bytes of the request body, which is what a webhook signature is
// computed over — re-serialising a parsed object does not reproduce them.
//
// On Workers the adapter in worker.js has already read the body and set
// __rawBodyText, so this returns it untouched. Running under Node directly
// (the test suites), it reads the stream before anything touches `req.body` —
// a lazy body getter would consume the stream first — and caches the result so
// a later readJsonBody() on the same request still works.
export async function readRawBodyText(req){
  if (typeof req.__rawBodyText === 'string') return req.__rawBodyText;

  let text = null;
  if (req.readable) {
    try { text = await readRawBody(req); } catch { text = null; }
  }
  if (text === null) {
    const raw = req.rawBody ?? req.body;
    if (Buffer.isBuffer(raw)) text = raw.toString('utf8');
    else if (typeof raw === 'string') text = raw;
    else if (raw && typeof raw === 'object') text = JSON.stringify(raw);
    else text = '';
  }

  req.__rawBodyText = text;
  return text;
}

// Callers that omit a JSON Content-Type — and webhook senders using a vendor
// one — can leave the body as a string, a Buffer, or undefined. Handle all of
// them rather than trusting a pre-parsed req.body.
export async function readJsonBody(req){
  const raw = (await readRawBodyText(req)).trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

export function requireMethod(req, method){
  if (req.method !== method) throw new HttpError(405, 'Method not allowed');
}

// The Supabase project URL is not a secret — it already ships to every browser
// in js/supabase.js — so it falls back rather than being required. Only the
// service-role key, which bypasses row-level security, has to come from the
// environment.
const DEFAULT_SUPABASE_URL = 'https://orzcszqpnvicreqvpncu.supabase.co';
export function supabaseUrl(){
  return process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || DEFAULT_SUPABASE_URL;
}

// Returns the requested env vars, or throws a 500 naming exactly which ones
// are missing — a misconfigured project should say so, not crash.
//
// The hint is there because "I added it and it still says missing" has one
// common cause on Workers: a value added as a plaintext Variable rather than a
// Secret. `wrangler deploy` treats the config file as the source of truth for
// plaintext vars and wrangler.jsonc declares none, so those are wiped on every
// deploy. Secrets are encrypted and survive.
export function requireEnv(...names){
  const missing = names.filter(n => !process.env[n]);
  if (!missing.length) return Object.fromEntries(names.map(n => [n, process.env[n]]));

  const onWorkers = typeof navigator !== 'undefined' && /Cloudflare/i.test(navigator.userAgent || '');
  const hint = onWorkers
    ? ' — set it as a Secret (encrypted) on the Worker, not a plaintext Variable: a plaintext one is wiped on each deploy.'
    : '';
  throw new HttpError(500, `Missing environment variable(s): ${missing.join(', ')}${hint}`);
}

// Supabase client calls return { error } instead of throwing; unwrap them so
// the failure travels the same path as everything else.
export function unwrap(result, context){
  if (result?.error) throw new HttpError(500, `${context}: ${result.error.message || result.error}`);
  return result?.data;
}

export function withHandler(handler){
  return async function wrapped(req, res){
    try {
      await handler(req, res);
    } catch (err) {
      const status = Number.isInteger(err?.status) ? err.status : 500;
      // Client errors are routine — one line. Server errors get the stack, which
      // goes to the platform log only; the client just gets the message.
      if (status >= 500) console.error('[api] request failed', req.method, req.url, '\n', err?.stack || err);
      else console.warn('[api]', status, req.method, req.url, '-', err?.message);
      if (res.headersSent) { try { res.end(); } catch {} return; }
      res.status(status).json({ error: err?.message || 'Internal server error' });
    }
  };
}
