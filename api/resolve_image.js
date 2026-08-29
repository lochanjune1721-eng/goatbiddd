import { createClient } from '@supabase/supabase-js';
import { HttpError, readJsonBody, requireEnv, requireMethod, unwrap, withHandler } from './_lib.js';

export default withHandler(async function handler(req, res){
  requireMethod(req, 'POST');

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = requireEnv('SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY');

  const body = await readJsonBody(req);
  const { name, category, entity_id } = body;
  if (!name) throw new HttpError(400, 'Missing name parameter');

  // The resolver lives outside api/, so it is bundled only if the build traces
  // it. Import it lazily: a bundling miss then becomes a readable 500 rather
  // than a cold-start crash that takes the whole function down.
  let resolveWikimediaImage;
  try {
    ({ resolveWikimediaImage } = await import('../scripts/wikimedia_resolver.mjs'));
  } catch (err) {
    throw new HttpError(500, `Image resolver module failed to load: ${err?.message || err}`);
  }

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { status, data } = await resolveWikimediaImage({ name, category: category || '' });

  if (entity_id && data?.wikimedia_thumbnail_url) {
    unwrap(
      await supa.from('people').update({
        photo_path: data.wikimedia_thumbnail_url,
        photo_credit: data.image_author,
        photo_license: data.image_license
      }).eq('id', entity_id),
      'update person photo'
    );
  }

  return res.status(200).json({ ok: true, status, data });
});
