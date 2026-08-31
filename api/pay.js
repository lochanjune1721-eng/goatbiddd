// api/pay.js — the single browser-facing payment endpoint.
//
// Every rail a signed-in visitor can start goes through here, dispatched on
// `action` in the JSON body. They were six separate routes once; splitting
// them bought nothing at runtime, since they share their auth, their body
// parsing and their settlement path anyway.
//
// The two provider webhooks stay on their own routes: they are called by
// PayPal and UroPay at fixed URLs with provider-defined bodies, so they cannot
// carry an `action` and must not share this one's assumptions.
import { HttpError, readJsonBody, requireMethod, withHandler } from './_lib.js';
import { payPalCheckout, payPalCapture } from './_pay-paypal.js';
import { uroPayCheckout, uroPayConfirm } from './_pay-uropay.js';
import { upiIntent, upiClaim } from './_pay-upi.js';

const ACTIONS = {
  'paypal-checkout': payPalCheckout,   // open a PayPal order
  'paypal-capture':  payPalCapture,    // capture it when the payer returns
  'uropay-checkout': uroPayCheckout,   // open a UroPay (UPI gateway) order
  'uropay-confirm':  uroPayConfirm,    // confirm it when the payer returns
  'upi-intent':      upiIntent,        // direct UPI: QR + deep link to our VPA
  'upi-claim':       upiClaim          // direct UPI: payer submits their UTR
};

export default withHandler(async function handler(req, res){
  requireMethod(req, 'POST');

  const body = await readJsonBody(req);
  const action = String(body.action || '');
  const handle = Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : null;

  if (!handle) {
    throw new HttpError(400, `Unknown payment action${action ? ` "${action}"` : ''}. Expected one of: ${Object.keys(ACTIONS).join(', ')}`);
  }
  return handle(req, res, body);
});
