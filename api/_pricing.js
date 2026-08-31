// api/_pricing.js — the rupee price of a vote, shared by both Indian rails.
//
// There is no defensible default exchange rate, so this is configuration. Both
// UPI routes refuse rather than invent one.
import { HttpError } from './_lib.js';

export function inrPerVote(){
  const raw = process.env.INR_PER_VOTE || process.env.UROPAY_INR_PER_VOTE;
  const value = Number(raw);
  if (!raw || !Number.isFinite(value) || value <= 0) {
    throw new HttpError(503, 'UPI top-ups are unavailable: INR_PER_VOTE is not set to the rupee price of one vote.');
  }
  return value;
}

export function rupeesForVotes(votes){
  return Math.round(votes * inrPerVote() * 100) / 100;
}
