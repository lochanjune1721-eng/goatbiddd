// js/optimized-image.js — Bulletproof Image Rendering Component for The True GOAT
// Delivers fast, zero-failure images via local caching & auto-healing proxy in dev.

(function(){
  const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
  if(!isBrowser) return;

  /**
   * Resolve an image URL cleanly
   */
  // Hosts a browser can load straight from. Wikimedia serves images to browsers
  // without any User-Agent ceremony, and Supabase public storage is public.
  const DIRECT_HOSTS = /^(upload\.wikimedia\.org|commons\.wikimedia\.org|[a-z0-9-]+\.supabase\.co)$/i;

  function isDirectlyLoadable(url){
    try { return DIRECT_HOSTS.test(new URL(url).hostname); }
    catch(e){ return false; }
  }

  function getThumb(sourceUrl, size = 120, name = '') {
    const clean = (sourceUrl || '').trim().split('?')[0];
    if(!clean && !name) return null;

    let fullUrl = clean;
    if (clean && !clean.startsWith('http://') && !clean.startsWith('https://') && !clean.startsWith('data:')) {
      const baseUrl = window.GOAT?.SUPABASE_URL || 'https://orzcszqpnvicreqvpncu.supabase.co';
      fullUrl = `${baseUrl}/storage/v1/object/public/people/${clean.replace(/^\/+/, '')}`;
    }

    if (clean.startsWith('data:')) return clean;

    // Everything used to be proxied through /img "to guarantee User-Agent
    // compliance". That made a serverless invocation out of every portrait —
    // around a hundred per homepage view, each pulling a full 800px image —
    // and it put the whole site's photos behind one function. When that
    // function is down, throttled, or over quota, every photo on the site
    // turns into initials at once.
    //
    // A browser needs no help with an absolute URL on a public host, so send
    // it straight there. /img is kept for what actually needs it: a name with
    // no URL (it looks the portrait up server-side), and any other host.
    if (fullUrl && isDirectlyLoadable(fullUrl)) return fullUrl;

    return `/img?name=${encodeURIComponent(name || '')}&url=${encodeURIComponent(fullUrl || '')}`;
  }

  /**
   * Handle image error with initials avatar fallback
   */
  function handleError(img, name) {
    if(!img) return;
    const initials = window.GOAT?.initials ? window.GOAT.initials(name) : (name ? name.slice(0,2).toUpperCase() : '?');
    const parent = img.parentElement;
    if(parent) {
      img.style.display = 'none';
      let fb = parent.querySelector('.fallback');
      if(!fb) {
        fb = document.createElement('div');
        fb.className = 'fallback';
        fb.style.cssText = 'width:100%;height:100%;display:grid;place-items:center;position:absolute;inset:0;';
        fb.textContent = initials;
        parent.appendChild(fb);
      } else {
        fb.style.display = 'grid';
      }
    }
  }
  window.onGoatImgError = handleError;

  /**
   * OptimizedImage.render: Generates resilient HTML for contender portraits with video layer
   */
  function render({ photoPath, videoPath, name, size = 120, priority = 'lazy', className = '', style = '', slug = '', enableVideo = true }) {
    const safeName = (name || '').replace(/"/g, '&quot;');
    const resolvedUrl = getThumb(photoPath, size, name);
    const styleAttr = style ? ` style="${style}"` : '';
    const classAttr = className ? `goat-photo ${className}` : 'goat-photo';

    let videoSrc = (enableVideo && window.PersonMedia) ? window.PersonMedia.getVideo(name, slug) : null;
    if (!videoSrc && videoPath && window.GOAT?.getVideoUrl) {
      videoSrc = window.GOAT.getVideoUrl(videoPath);
    } else if (!videoSrc && videoPath) {
      videoSrc = videoPath;
    }
    const videoAttr = videoSrc ? ` data-video="${String(videoSrc).replace(/"/g,'&quot;')}"` : '';

    const eagerAttrs = priority === 'eager' ? 'fetchpriority="high" loading="eager"' : 'loading="lazy"';

    if(!resolvedUrl) {
      const initials = window.GOAT?.initials ? window.GOAT.initials(name) : (name ? name.slice(0,2).toUpperCase() : '?');
      return `<div class="fallback"${styleAttr}${videoAttr}>${initials}</div>`;
    }

    return `<img src="${resolvedUrl}" alt="${safeName}" width="${size}" height="${size}" ${eagerAttrs} decoding="async" referrerpolicy="no-referrer" class="${classAttr}"${styleAttr}${videoAttr} onerror="window.onGoatImgError(this, '${safeName}')">`;
  }

  window.OptimizedImage = {
    render,
    getThumb,
    handleError
  };
})();
