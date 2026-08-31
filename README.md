# The True GOAT — Who is the Greatest of All Time?

The definitive pay-to-rank Hall of Fame. $1 = 1 vote. Top up once, vote with one tap.

Live at [thetruegoat.com](https://www.thetruegoat.com).

## Core Loop
1. **Sign In**: Email magic-link or Google OAuth. Land back where you were with your balance in the topbar.
2. **Top Up**: Load wallet credit once ($5 / $10 / $25 / $50 / $100) via PayPal.
3. **Vote**: 1-tap voting directly from the homepage head-to-head duels or category boards.
4. **Outbid**: Become the #1 Greatest Fan of All Time on any contender's page by outbidding the leader.
5. **Real-time Live Activity**: Live ticker and activity feed updated instantly as votes happen.

## Architecture
- Vanilla HTML / CSS / JS — clean, lightning-fast, zero-framework overhead.
- Supabase: Auth, PostgreSQL database, Storage for avatars & portraits, Realtime.
- Cloudflare Workers: one Worker (`worker.js`) serves the API and hands
  everything else to the static assets in `public/`.
  - `/api/pay` — every top-up a signed-in visitor can start, dispatched on an
    `action` in the body: PayPal, UroPay (UPI gateway), and direct UPI.
  - `/api/payment-done` and `/api/uropay-webhook` — the provider webhooks.
  - `/api/img` — edge-cached contender portraits.
  - `/api/health` — configuration and platform diagnostics.

## Deploying
`npm install` runs `scripts/build-assets.mjs`, which assembles `public/` from
the pages, `css/`, `js/`, `downloads/` and the data files the browser reads.
`wrangler deploy` then publishes the Worker and those assets.

Secrets are Worker secrets, not repo files — set them under the Worker's
Settings → Variables and Secrets. `/api/health` lists which are missing and
reports the colo that answered, so a value set on the wrong host is visible
rather than a mystery.
