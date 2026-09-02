// api/_country.js — which rail a fan may use, decided by the country they gave
// us at sign-in.
//
// Read from their own row, never from the request: a Cloudflare country is a
// guess about a network — wrong for anyone travelling or behind a VPN, and it
// can differ between two clicks of the same checkout. The rail a payment opens
// on has to be stable, so it follows what the fan said about themselves.
import { HttpError } from './_lib.js';

export const INDIA = 'IN';

// India pays by UPI, everyone else by card. One rail each, deliberately: the
// two are not interchangeable — a UPI order is denominated in rupees and a UPI
// app only exists on an Indian bank account.
export function railForCountry(country){
  return country === INDIA ? 'upi' : 'card';
}

export async function userCountry(supa, uid){
  const { data } = await supa.from('users').select('country').eq('id', uid).maybeSingle();
  const raw = String(data?.country || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(raw) ? raw : null;
}

// Refuse a rail this fan is not on. Unknown country is allowed through rather
// than blocked: someone who signed up before we asked should still be able to
// pay, and the checkout asks them for it at the next opportunity.
export function assertRail(country, rail){
  if (!country) return;
  const allowed = railForCountry(country);
  if (allowed === rail) return;
  throw new HttpError(400, allowed === 'upi'
    ? 'Accounts in India pay by UPI. Nothing has been charged.'
    : 'UPI is only available for accounts in India. Pay by card instead — nothing has been charged.');
}
