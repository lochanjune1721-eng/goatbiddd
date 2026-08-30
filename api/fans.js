// api/fans.js — Public top fans leaderboard & stats
import { createClient } from '@supabase/supabase-js';
import { requireMethod, withHandler } from './_lib.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://orzcszqpnvicreqvpncu.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9yemNzenFwbnZpY3JlcXZwbmN1Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NzY0MjA0MiwiZXhwIjoyMTAzMjE4MDQyfQ.ox7ew17e3rm4QlNWNeglDJB_b1KFP55S3053B5uAadM';

export default withHandler(async function handler(req, res){
  requireMethod(req, 'GET');

  const supa = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: users } = await supa
    .from('users')
    .select('id,display_name,is_anonymous,total_spent_cents,photo_path,social_handle,social_platform')
    .gt('total_spent_cents', 0)
    .order('total_spent_cents', { ascending: false })
    .limit(50);

  // Cache for 10s on CDN
  res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');
  return res.status(200).json({ ok: true, fans: users || [] });
});
