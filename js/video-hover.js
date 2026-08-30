// js/video-hover.js — Reliable auto-play muted on screen, unmute on hover, single audio
// data-video lives on <img> / <div class="fallback"> inside .photo — we watch for that.
(function(){
  if(typeof window === 'undefined') return;

  const live = new Map();           // photoBox -> HTMLVideoElement
  let audioPhotoBox = null;         // which photoBox has audio on
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ─── helpers ─── */

  function getPhotoBox(el){
    if(!el || !el.closest) return null;
    // .photo or .person-photo is the visual container that holds the img
    return el.closest('.photo, .person-photo');
  }

  function getDuelSide(photoBox){
    if(!photoBox) return null;
    return photoBox.closest('.duel-side, .board-row, .cat-tile, .person-card');
  }

  function getVideoSrc(photoBox){
    if(!photoBox) return null;
    // data-video can be on the img, a fallback div, or the photoBox itself
    const el = photoBox.matches('[data-video]') ? photoBox : photoBox.querySelector('[data-video]');
    return el && el.dataset.video ? el.dataset.video : null;
  }

  /* ─── mount / unmount ─── */

  function mountVideo(photoBox){
    if(!photoBox || live.has(photoBox) || reduced) return;
    const src = getVideoSrc(photoBox);
    if(!src) return;

    const v = document.createElement('video');
    v.className = 'goat-clip';
    v.muted = true;       // MUST start muted — browsers require this for autoplay
    v.loop = true;
    v.playsInline = true;
    v.preload = 'metadata';
    v.setAttribute('playsinline','');
    v.setAttribute('webkit-playsinline','');
    v.setAttribute('aria-hidden','true');
    v.src = src;

    function onReady(){
      if(!live.has(photoBox)) return;
      v.classList.add('ready');
      photoBox.classList.add('video-playing');
      const side = getDuelSide(photoBox);
      if(side) side.classList.add('video-playing');
    }

    v.addEventListener('loadeddata', onReady, { once: true });
    v.addEventListener('canplay',    onReady, { once: true });
    v.addEventListener('playing',    onReady, { once: true });
    v.addEventListener('error', () => unmountVideo(photoBox));

    photoBox.appendChild(v);
    live.set(photoBox, v);

    v.play().catch(() => {
      // If even muted play fails, try again muted
      v.muted = true;
      v.play().catch(() => {});
    });
  }

  function unmountVideo(photoBox){
    if(!photoBox) return;
    const v = live.get(photoBox);
    if(v){
      live.delete(photoBox);
      v.muted = true;
      v.pause();
      v.removeAttribute('src');
      try{ v.load(); }catch(e){}
      v.remove();
    }
    photoBox.classList.remove('video-playing');
    const side = getDuelSide(photoBox);
    if(side) side.classList.remove('video-playing');
    if(audioPhotoBox === photoBox) audioPhotoBox = null;
  }

  /* ─── IntersectionObserver: auto-play when visible ─── */

  const io = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
    for(const entry of entries){
      const photoBox = entry.target;
      if(entry.isIntersecting){
        mountVideo(photoBox);
      } else {
        // Only unmount if no audio is on — keep playing off-screen if user is hovering
        if(audioPhotoBox !== photoBox) unmountVideo(photoBox);
      }
    }
  }, { rootMargin: '150px 0px 150px 0px', threshold: 0.05 }) : null;

  const watched = new WeakSet();

  function observePhotoBox(photoBox){
    if(!photoBox || watched.has(photoBox)) return;
    if(!getVideoSrc(photoBox)) return;   // no video yet on this element — wait
    watched.add(photoBox);
    if(io) io.observe(photoBox);
  }

  /* ─── Scan DOM for photo boxes that have data-video ─── */

  function scan(root){
    const scope = root instanceof Element ? root : (root || document);
    scope.querySelectorAll('[data-video]').forEach(el => {
      const pb = getPhotoBox(el) || (el.matches('.photo, .person-photo') ? el : null);
      if(pb) observePhotoBox(pb);
    });
    // Also re-scan known photo boxes in case data-video was just added
    scope.querySelectorAll('.photo, .person-photo').forEach(pb => {
      if(!watched.has(pb) && getVideoSrc(pb)) observePhotoBox(pb);
    });
  }

  /* ─── MutationObserver: catch dynamically added cards ─── */

  if('MutationObserver' in window){
    const mo = new MutationObserver(mutations => {
      for(const m of mutations){
        for(const node of m.addedNodes){
          if(node.nodeType !== 1) continue;
          // If the added node itself has data-video
          if(node.dataset && node.dataset.video){
            const pb = getPhotoBox(node);
            if(pb) observePhotoBox(pb);
          }
          // Scan inside it too
          scan(node);
        }
        // If an attribute changed to data-video
        if(m.type === 'attributes' && m.attributeName === 'data-video'){
          const pb = getPhotoBox(m.target);
          if(pb) observePhotoBox(pb);
        }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-video'] });
  }

  /* ─── Hover: audio on / off ─── */

  function setAudio(photoBox){
    if(photoBox === audioPhotoBox) return;

    // Mute previous
    if(audioPhotoBox){
      const pv = live.get(audioPhotoBox);
      if(pv){ pv.muted = true; pv.volume = 0; }
      audioPhotoBox = null;
    }

    if(!photoBox) return;

    audioPhotoBox = photoBox;
    let v = live.get(photoBox);

    if(!v){
      // Video not mounted yet (card just entered viewport or was off-screen) — mount it first
      mountVideo(photoBox);
      v = live.get(photoBox);
    }

    if(v){
      v.muted = false;
      v.volume = 1.0;
      if(v.paused){
        v.play().catch(() => { v.muted = true; v.play().catch(()=>{}); });
      }
    }
  }

  document.addEventListener('mouseover', e => {
    const pb = getPhotoBox(e.target);
    if(pb && (getVideoSrc(pb) || live.has(pb))){
      setAudio(pb);
    } else if(!pb || (!getVideoSrc(pb) && !live.has(pb))){
      setAudio(null);
    }
  }, true);

  document.addEventListener('mouseleave', () => setAudio(null), true);

  // Pause all when tab hidden; resume when visible
  document.addEventListener('visibilitychange', () => {
    if(document.hidden){
      setAudio(null);
      for(const v of live.values()) v.pause();
    } else {
      for(const v of live.values()) v.play().catch(()=>{});
    }
  });

  // Initial scan after DOM is ready
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', () => scan());
  } else {
    scan();
  }
  // Also scan after a short delay to catch any late JS renders
  setTimeout(() => scan(), 800);
  setTimeout(() => scan(), 2500);

  window.VideoHover = { scan, play: mountVideo, teardown: () => [...live.keys()].forEach(unmountVideo) };
})();
