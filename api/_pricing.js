// api/_pricing.js — what money buys, and what a vote costs in rupees.
//
// One table, on the server. The checkout page displays it and the checkout
// endpoint computes from it; the browser never gets to say how many votes it
// bought, or a visitor would simply claim a thousand.
import { HttpError } from './_lib.js';

// Buying more at once earns more votes. Exact amounts only — these are the
// offers, not a curve, so $7 is not "$5's bonus plus two".
export const TIERS = [
  { cents:   500, votes:   6 },
  { cents:  1000, votes:  12 },
  { cents:  2000, votes:  24 },
  { cents:  5000, votes:  60 },
  { cents: 10000, votes: 150 }
];

export const MIN_CENTS = 100;
export const MAX_CENTS = 500000;

// Votes granted for a payment. A tier amount gets the tier's votes; anything
// else is the plain dollar-a-vote rate, rounded down so a stray cent cannot
// round up into a free vote.
export function votesForCents(cents){
  const n = Number(cents);
  if (!Number.isInteger(n) || n < MIN_CENTS) throw new HttpError(400, 'Minimum top-up is $1 (1 vote)');
  if (n > MAX_CENTS) throw new HttpError(400, 'Maximum top-up is $5,000');
  const tier = TIERS.find(t => t.cents === n);
  return tier ? tier.votes : Math.floor(n / 100);
}

// What settlement credits: votes as balance, where 100 cents = 1 vote. Stored
// on the top-up row at checkout, so repricing a tier never changes the payout
// of an order that is already open.
export function creditCentsForCents(cents){
  return votesForCents(cents) * 100;
}

export function bonusVotesForCents(cents){
  return votesForCents(cents) - Math.floor(Number(cents) / 100);
}

// Shipped to the page so the buttons show the same numbers the server will
// honour. No secrets here — this is a price list.
export function publicTiers(){
  return TIERS.map(t => ({
    cents: t.cents,
    usd: t.cents / 100,
    votes: t.votes,
    bonus: t.votes - t.cents / 100
  }));
}

// ── Rupees ───────────────────────────────────────────────────────────────────
// There is no defensible default exchange rate, so this is configuration. Both
// Indian routes refuse rather than invent one.
export function inrPerVote(){
  const raw = process.env.INR_PER_VOTE || process.env.UROPAY_INR_PER_VOTE;
  const value = Number(raw);
  if (!raw || !Number.isFinite(value) || value <= 0) {
    throw new HttpError(503, 'UPI top-ups are unavailable: INR_PER_VOTE is not set to the rupee price of one vote.');
  }
  return value;
}

// Charged on the dollar amount, not on the bonused vote count — the bonus is a
// discount, so charging for it would hand it straight back.
export function rupeesForCents(cents){
  return Math.round((Number(cents) / 100) * inrPerVote() * 100) / 100;
}

// Kept for callers that still think in votes. Same rate, same rounding.
export function rupeesForVotes(votes){
  return Math.round(Number(votes) * inrPerVote() * 100) / 100;
}
