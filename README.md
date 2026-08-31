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
- Vercel Serverless Functions (`/api/checkout`, `/api/payment-done`).
