// js/optimized-image.js — Bulletproof Image Rendering Component for GOAT.lol
// Delivers fast, zero-failure images via local caching & auto-healing proxy in dev.

(function(){
  const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
  if(!isBrowser) return;

  /**
   * Resolve an image URL cleanly
   */
  function getThumb(sourceUrl, size = 120, name = '') {
    const clean = (sourceUrl || '').trim().split('?')[0];
    if(!clean && !name) return null;

    let fullUrl = clean;
    if (clean && !clean.startsWith('http://') && !clean.startsWith('https://') && !clean.startsWith('data:')) {
      const baseUrl = window.GOAT?.SUPABASE_URL || 'https://orzcszqpnvicreqvpncu.supabase.co';
      fullUrl = `${baseUrl}/storage/v1/object/public/people/${clean.replace(/^\/+/, '')}`;
    }

    // Always route through caching proxy to guarantee Wikimedia User-Agent compliance & zero 403 blocks
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
  function render({ photoPath, name, size = 120, priority = 'lazy', className = '', style = '', slug = '', enableVideo = true }) {
    const safeName = (name || '').replace(/"/g, '&quot;');
    const resolvedUrl = getThumb(photoPath, size, name);
    const styleAttr = style ? ` style="${style}"` : '';
    const classAttr = className ? `goat-photo ${className}` : 'goat-photo';

    let imgHtml = '';
    if(!resolvedUrl) {
      const initials = window.GOAT?.initials ? window.GOAT.initials(name) : (name ? name.slice(0,2).toUpperCase() : '?');
      imgHtml = `<div class="fallback"${styleAttr}>${initials}</div>`;
    } else {
      const eagerAttrs = priority === 'eager' ? 'fetchpriority="high" loading="eager"' : 'loading="lazy"';
      imgHtml = `<img src="${resolvedUrl}" alt="${safeName}" width="${size}" height="${size}" ${eagerAttrs} decoding="async" referrerpolicy="no-referrer" class="${classAttr}"${styleAttr} onerror="window.onGoatImgError(this, '${safeName}')">`;
    }

    // Check if candidate has an associated video in downloads/
    const videoSrc = (enableVideo && window.PersonMedia) ? window.PersonMedia.getVideo(name, slug) : null;
    if (videoSrc) {
      const vidHtml = `
        <video class="goat-video" loop playsinline muted preload="metadata" data-video-src="${videoSrc}"></video>
        <div class="goat-sound-indicator" title="Hover for sound" aria-label="Audio available">
          <span class="sound-wave"><span class="sound-bar paused"></span><span class="sound-bar paused"></span></span>
          <span class="sound-text">HOVER FOR AUDIO</span>
        </div>
      `;
      return imgHtml + vidHtml;
    }

    return imgHtml;
  }

  window.OptimizedImage = {
    render,
    getThumb,
    handleError
  };
})();
