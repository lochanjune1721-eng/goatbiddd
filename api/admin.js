import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { HttpError, readJsonBody, requireEnv, requireMethod, unwrap, withHandler, supabaseUrl } from './_lib.js';

export default withHandler(async function handler(req, res){
  requireMethod(req, 'POST');

  const { ADMIN_PASSWORD } = requireEnv('ADMIN_PASSWORD');
  const body = await readJsonBody(req);
  const { password, action, id } = body;

  const given = Buffer.from(String(password || ''), 'utf8');
  const want = Buffer.from(ADMIN_PASSWORD, 'utf8');
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) throw new HttpError(401, 'Unauthorized');
  if (!action) return res.status(200).json({ ok: true });

  const { SUPABASE_SERVICE_ROLE_KEY } = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const SUPABASE_URL = supabaseUrl();
  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // 30-min grace: list confirmed donations with no matching payment (donation_confirmed true, payment_confirmed false, created >30m ago)
  if (action === 'pending_donations') {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const entries = unwrap(
      await supa.from('entries').select('*').eq('donation_confirmed', true).eq('payment_confirmed', false).lt('last_bid_at', cutoff).order('last_bid_at', { ascending: false }).limit(50),
      'pending_donations'
    );
    return res.status(200).json({ entries });
  }
  if (action === 'approve_donation') {
    if (!id) throw new HttpError(400, 'Missing id');
    unwrap(await supa.from('entries').update({ status: 'live', payment_confirmed: true }).eq('id', id), 'approve_donation');
    return res.status(200).json({ ok: true });
  }
  if (action === 'reject') {
    if (!id) throw new HttpError(400, 'Missing id');
    unwrap(await supa.from('entries').update({ status: 'rejected' }).eq('id', id), 'reject');
    return res.status(200).json({ ok: true });
  }
  // ── Direct UPI review queue ────────────────────────────────────────────
  // A UPI transfer to a VPA has no callback, so these are the top-ups a payer
  // has claimed and nobody has checked yet. Match the reference and amount
  // against the bank statement before approving: approving is what creates the
  // votes, and there is no undo short of an adjustment.
  if (action === 'pending_upi') {
    const rows = unwrap(
      await supa.from('topups')
        .select('id,user_id,amount_cents,provider_amount,provider_currency,provider_payment_id,provider_order_id,claimed_at,created_at,users(display_name,email)')
        .eq('provider', 'upi').eq('status', 'review')
        .order('claimed_at', { ascending: true }).limit(100),
      'pending_upi'
    );
    return res.status(200).json({ topups: rows });
  }

  if (action === 'approve_upi') {
    if (!id) throw new HttpError(400, 'Missing id');
    const topup = unwrap(
      await supa.from('topups').select('*').eq('id', id).eq('provider', 'upi').maybeSingle(),
      'approve_upi lookup'
    );
    if (!topup) throw new HttpError(404, 'Top-up not found');
    if (topup.status === 'confirmed') return res.status(200).json({ ok: true, duplicate: true });
    if (topup.status !== 'review') throw new HttpError(409, `That top-up is ${topup.status}, not awaiting review`);
    if (!topup.provider_payment_id) throw new HttpError(409, 'That top-up has no payment reference');

    const { data: newBalance, error } = await supa.rpc('confirm_topup', {
      p_topup_id: topup.id,
      p_user_id: topup.user_id,
      p_amount_cents: topup.amount_cents,
      p_payment_id: topup.provider_payment_id,
      p_provider: 'upi'
    });
    if (error) throw new HttpError(500, `confirm_topup failed: ${error.message}`);

    await supa.from('topups').update({ reviewed_at: new Date().toISOString() }).eq('id', topup.id);
    console.log(`[admin] approved UPI topup ${topup.id} (${topup.provider_amount} INR, UTR ${topup.provider_payment_id}) -> balance ${newBalance}`);
    return res.status(200).json({ ok: true, credited: topup.amount_cents, newBalance });
  }

  if (action === 'reject_upi') {
    if (!id) throw new HttpError(400, 'Missing id');
    // The reference is cleared so an honest payer who mistyped can resubmit it.
    unwrap(
      await supa.from('topups')
        .update({ status: 'failed', provider_payment_id: null, reviewed_at: new Date().toISOString(),
                  review_note: typeof body.note === 'string' ? body.note.slice(0, 500) : null })
        .eq('id', id).eq('provider', 'upi').eq('status', 'review'),
      'reject_upi'
    );
    return res.status(200).json({ ok: true });
  }

  throw new HttpError(400, 'Unknown action');
});
