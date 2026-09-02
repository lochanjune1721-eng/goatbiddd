// api/pay.js — the single browser-facing payment endpoint.
//
// Every rail a signed-in visitor can start goes through here, dispatched on
// `action` in the JSON body. They were six separate routes once; splitting
// them bought nothing at runtime, since they share their auth, their body
// parsing and their settlement path anyway.
//
// Dodo's webhook stays on its own route: it is called at a fixed URL with a
// provider-defined body, so it cannot carry an `action` and must not share this
// one's assumptions.
import { HttpError, readJsonBody, requireMethod, withHandler } from './_lib.js';
import { upiIntent, upiClaim } from './_pay-upi.js';
import { dodoCheckout, dodoConfirm } from './_pay-dodo.js';

const ACTIONS = {
  'dodo-checkout': dodoCheckout,   // open a Dodo Payments checkout
  'dodo-confirm':  dodoConfirm,    // confirm it when the payer returns
  'upi-intent':    upiIntent,      // direct UPI: QR + deep link to our VPA
  'upi-claim':     upiClaim        // direct UPI: payer submits their UTR
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
