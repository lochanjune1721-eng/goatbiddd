// api/_lib.js — shared helpers for the serverless functions.
// Files prefixed with "_" are not turned into routes by Vercel.
//
// Anything that throws (or rejects) inside a handler surfaces on Vercel as a
// bare FUNCTION_INVOCATION_FAILED / 500 page with no usable body, so every
// route goes through withHandler() and every request body through
// readJsonBody(). That turns a crash into a JSON response you can read.

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
// Order matters: Vercel's Node runtime exposes `req.body` as a lazy getter
// that consumes the stream to parse it, so whoever looks first wins. Read the
// stream before touching `body`, and cache the result so a later
// readJsonBody() on the same request still works.
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

// Vercel pre-parses JSON bodies, but only when Content-Type says so. Callers
// that omit the header (and webhook senders that use a vendor content type)
// leave req.body as a string, a Buffer, or undefined — handle all of them.
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

// Returns the requested env vars, or throws a 500 naming exactly which ones
// are missing — a misconfigured project should say so, not crash.
export function requireEnv(...names){
  const missing = names.filter(n => !process.env[n]);
  if (missing.length) throw new HttpError(500, `Missing environment variable(s): ${missing.join(', ')}`);
  return Object.fromEntries(names.map(n => [n, process.env[n]]));
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
      // goes to the Vercel log only; the client just gets the message.
      if (status >= 500) console.error('[api] request failed', req.method, req.url, '\n', err?.stack || err);
      else console.warn('[api]', status, req.method, req.url, '-', err?.message);
      if (res.headersSent) { try { res.end(); } catch {} return; }
      res.status(status).json({ error: err?.message || 'Internal server error' });
    }
  };
}
