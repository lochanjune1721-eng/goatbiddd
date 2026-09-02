// worker.js — Cloudflare Workers entry point.
//
// The API is written as Node-style handlers: (req, res) with
// res.status().json(). Rather than rewrite eight of them — including the
// payment code, which is tested — this adapts the two shapes. A Workers
// Request becomes the `req` object they expect, and their `res` calls resolve
// a Response. Keeping that boundary means the handlers stay testable under
// plain Node, which is how every suite in this repo runs.
//
// The seam that makes this cheap already existed: api/_lib.js reads a request
// body through readRawBodyText(), which returns req.__rawBodyText when it is
// already set. The adapter reads the body once and sets it, so webhook
// signature checks still see the exact bytes that were sent.
import admin from './api/admin.js';
import fans from './api/fans.js';
import topFans from './api/top-fans.js';
import health from './api/health.js';
import img from './api/img.js';
import pay from './api/pay.js';
import paymentDone from './api/payment-done.js';
import resolveImage from './api/resolve_image.js';
import uropayWebhook from './api/uropay-webhook.js';
import dodoWebhook from './api/dodo-webhook.js';

const ROUTES = {
  'admin': admin,
  'fans': fans,
  'top-fans': topFans,
  'health': health,
  'img': img,
  'pay': pay,
  'payment-done': paymentDone,
  'resolve_image': resolveImage,
  'uropay-webhook': uropayWebhook,
  'dodo-webhook': dodoWebhook,
};

function makeReq(request, url, rawBody){
  const headers = Object.create(null);
  for (const [k, v] of request.headers) headers[k.toLowerCase()] = v;
  return {
    method: request.method,
    url: url.pathname + url.search,
    headers,
    // api/img.js reads req.query, which Workers does not supply.
    query: Object.fromEntries(url.searchParams),
    // Cloudflare's per-request metadata (colo, country). /api/health reports
    // the colo so you can see which edge answered.
    cf: request.cf || null,
    // Signals to readRawBodyText() that the body is already in hand, so it
    // does not try to consume a Node stream that isn't there.
    readable: false,
    __rawBodyText: rawBody
  };
}

function makeRes(){
  const headers = new Headers();
  let status = 200;
  let settle;
  const sent = new Promise(resolve => { settle = resolve; });

  const res = {
    headersSent: false,
    setHeader(key, value){ headers.set(key, String(value)); return res; },
    getHeader(key){ return headers.get(key); },
    status(code){ status = code; return res; },
    json(body){
      headers.set('content-type', 'application/json; charset=utf-8');
      res.headersSent = true;
      settle(new Response(JSON.stringify(body), { status, headers }));
      return res;
    },
    send(body){
      res.headersSent = true;
      // Buffer is a Uint8Array under nodejs_compat, which Response accepts.
      settle(new Response(body ?? null, { status, headers }));
      return res;
    },
    end(body){
      if (!res.headersSent) { res.headersSent = true; settle(new Response(body ?? null, { status, headers })); }
      return res;
    }
  };
  return { res, sent };
}

function json(body, status){
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

export default {
  async fetch(request, env, ctx){
    // Everything server-side reads configuration through process.env; on
    // Workers it arrives as bindings instead. Copy it across before dispatch
    // so requireEnv() and the provider clients behave exactly as they do on
    // Node. Only strings — a KV or R2 binding is not configuration.
    //
    // Defensive, because how process.env behaves under nodejs_compat depends
    // on the compatibility date: it may already be populated from bindings,
    // and on some configurations it is not writable. Neither should take a
    // request down, so keys are copied one at a time and a rejected write just
    // means the runtime has already done this for us.
    if (typeof process !== 'undefined' && process.env) {
      for (const [key, value] of Object.entries(env)) {
        if (typeof value !== 'string') continue;
        try { process.env[key] = value; } catch { /* already populated, or read-only */ }
      }
    }

    const url = new URL(request.url);

    // A Supabase magic link can land on a path that does not exist. If the
    // project's Site URL is set to the wildcard pattern that belongs in the
    // Redirect URLs allow-list (".../**"), Supabase builds the callback from it
    // literally and the visitor arrives at https://host/**#access_token=...
    // The page 404s, no script runs, and a valid session is thrown away.
    //
    // "*" is never part of a real asset path here, so treat it as that
    // misconfiguration and send the visitor to the page the magic link was
    // meant for. The token rides along on its own: a redirect response carries
    // no fragment of its own, so the browser reattaches the original
    // "#access_token=..." to the new location and supabase-js consumes it
    // there. This does not fix the dashboard setting — it stops it from
    // costing someone their sign-in.
    if (!url.pathname.startsWith('/api/') && url.pathname.includes('*')) {
      const target = '/wallet' + url.search;
      return new Response(null, { status: 302, headers: { location: target, 'cache-control': 'no-store' } });
    }

    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    const name = url.pathname.slice('/api/'.length).replace(/\.js$/, '').replace(/\/+$/, '');
    const handler = Object.prototype.hasOwnProperty.call(ROUTES, name) ? ROUTES[name] : null;
    if (!handler) return json({ error: `No such API route: /api/${name}` }, 404);

    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    let rawBody = '';
    if (hasBody) {
      try { rawBody = await request.text(); }
      catch { return json({ error: 'Could not read request body' }, 400); }
    }

    const req = makeReq(request, url, rawBody);
    const { res, sent } = makeRes();

    try {
      // withHandler() catches everything and always answers, so this resolves.
      await handler(req, res);
    } catch (err) {
      console.error('[worker] handler threw past withHandler', name, err?.stack || err);
      if (!res.headersSent) return json({ error: 'Internal server error' }, 500);
    }

    if (!res.headersSent) {
      console.error('[worker] handler returned without responding:', name);
      return json({ error: 'Internal server error' }, 500);
    }
    return sent;
  }
};
