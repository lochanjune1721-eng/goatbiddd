// api/img.js — Vercel Serverless Function for High-Performance Edge-Cached Contender Portraits
// Complies with Wikimedia User-Agent Policy and provides auto-healing image fallback

const USER_AGENT = "GOAT-App/1.0 (https://thetruegoat.com; admin@thetruegoat.com)";

// Generate fallback SVG avatar when no image is available
function generateSvgAvatar(name) {
  const initials = name ? name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() : '?';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">
    <rect width="100%" height="100%" fill="#1a1815"/>
    <text x="50%" y="54%" font-family="system-ui, -apple-system, sans-serif" font-weight="700" font-size="96" fill="#f59e0b" text-anchor="middle" dominant-baseline="middle">${initials}</text>
  </svg>`;
}

// Search Wikipedia for a thumbnail on the fly
async function queryWikiForPortrait(name) {
  if (!name) return null;
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&prop=pageimages|pageprops&piprop=thumbnail&pithumbsize=800&redirects=1&titles=${encodeURIComponent(name)}&format=json`;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return null;
    const j = await res.json();
    const page = Object.values(j.query?.pages || {})[0];
    const thumb = page?.thumbnail?.source?.split('?')[0];
    if (thumb && !thumb.endsWith('.gif')) return thumb;
  } catch (e) {}
  return null;
}

export default async function handler(req, res) {
  const { url, name } = req.query || {};
  let targetUrl = url ? decodeURIComponent(url).trim().split('?')[0] : '';
  const personName = name ? decodeURIComponent(name).trim() : '';

  // Auto-upgrade Wikimedia thumbnail URLs to high-resolution 800px
  if (targetUrl && targetUrl.includes('upload.wikimedia.org') && /\/\d+px-/.test(targetUrl)) {
    targetUrl = targetUrl.replace(/\/\d+px-/, '/800px-');
  }

  // Set long-lived cache headers for Vercel Edge Network
  res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=31536000, stale-while-revalidate=86400, immutable');
  res.setHeader('Access-Control-Allow-Origin', '*');

  let imageBuffer = null;
  let contentType = 'image/jpeg';

  // This route answers 200 no matter what — an initials SVG is nicer than a
  // broken image. That also means a dead upstream, an exhausted quota and a
  // contender who genuinely has no photo all look identical from outside.
  // These headers are how you tell them apart in DevTools.
  let source = 'fallback';
  let reason = targetUrl ? '' : 'no url and no name match';

  // 1. Fetch remote image if valid HTTP URL
  if (targetUrl && (targetUrl.startsWith('http://') || targetUrl.startsWith('https://'))) {
    try {
      const remoteRes = await fetch(targetUrl, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
        }
      });

      if (remoteRes.ok) {
        const ct = remoteRes.headers.get('content-type');
        if (ct && ct.startsWith('image/')) {
          contentType = ct;
          const arrayBuffer = await remoteRes.arrayBuffer();
          imageBuffer = Buffer.from(arrayBuffer);
          source = 'remote';
        }
      }
      if (!imageBuffer) reason = `upstream ${remoteRes.status}`;
    } catch (e) {
      reason = `upstream fetch failed: ${e?.message || e}`;
    }
  }

  // 2. Fallback: Search Wikipedia API on the fly if targetUrl failed or missing
  if (!imageBuffer && personName) {
    try {
      const wikiThumb = await queryWikiForPortrait(personName);
      if (wikiThumb) {
        const wikiRes = await fetch(wikiThumb, {
          headers: {
            'User-Agent': USER_AGENT,
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
          }
        });
        if (wikiRes.ok) {
          const ct = wikiRes.headers.get('content-type');
          if (ct && ct.startsWith('image/')) {
            contentType = ct;
            const arrayBuffer = await wikiRes.arrayBuffer();
            imageBuffer = Buffer.from(arrayBuffer);
            source = 'wiki';
          }
        }
      }
      if (!imageBuffer && !reason) reason = 'no wikipedia thumbnail for that name';
    } catch (e) {
      reason = `wikipedia lookup failed: ${e?.message || e}`;
    }
  }

  // 3. Return image or SVG fallback
  res.setHeader('X-Goat-Img', source);
  if (imageBuffer) {
    res.setHeader('Content-Type', contentType);
    return res.status(200).send(imageBuffer);
  }

  // Final fallback: SVG avatar
  if (reason) res.setHeader('X-Goat-Img-Reason', String(reason).slice(0, 180));
  console.warn(`[img] fallback for "${personName || '(no name)'}" url="${targetUrl || '(none)'}": ${reason || 'unknown'}`);
  res.setHeader('Content-Type', 'image/svg+xml');
  return res.status(200).send(generateSvgAvatar(personName));
}
