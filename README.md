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

## Going live
Two things have to be true, and only one of them is in the deploy.

**The flag.** `DEMO_MODE` in `wrangler.jsonc` is `"0"`, so every configured rail
takes real money. It is enforced in the payment handlers themselves, so setting
it back to `"1"` closes the rails against a hand-made POST as well as a button.

**The database.** No deploy touches it, and it is where the demonstration build
actually lives: 180 seeded backers holding $192,764 across the boards, and the
demo wallet credit. Left in place with the rails open, the first genuine payer is
bidding against money nobody paid — on a page that tells them every dollar on a
board is one somebody actually put down. Nothing on the front end shows the
difference, so check it in SQL:

```
data/go-live-check.sql        -- read-only; every row should say 'ok'
data/demo-backing-remove.sql  -- clears the seeded backers and recomputes the boards
data/demo-credit-remove.sql   -- clears the demo wallet credit
```

Run the check, clear whatever it names, run it again.

### Offline payments
Money settled directly rather than through a rail — bank transfer, UPI, cash —
is credited by hand and recorded on its own `offline` rail, so a granted balance
is never mistaken for one a provider confirmed, and each credit carries the
reference that matches it to a statement.

```
supabase-offline-rail.sql     -- once per database; adds the rail
data/offline-payments.sql     -- the credits; put the real references in first
```

Both are idempotent. The credit goes through `confirm_topup`, the same function
the PayPal and UPI webhooks settle through, so the receipt and the balance move
together and a re-run credits nothing.
