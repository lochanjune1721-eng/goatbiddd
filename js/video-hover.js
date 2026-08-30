// js/video-hover.js — Single unified video engine
// - Looks for data-video on img/fallback inside .photo containers
// - Auto-plays muted when card scrolls into view → expands to 16:9
// - Unmutes on mouseenter, re-mutes on mouseleave
// - Only one audio source at a time, globally
(function(){
  if(typeof window === 'undefined') return;

  const LIVE = new Map();      // photoBox element -> <video>
  let audioBox = null;         // photoBox currently unmuted
  const observed = new WeakSet();
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ─── Get the nearest .photo/.person-photo ancestor (or self) ─── */
  function toPhotoBox(el){
    if(!el || !el.closest) return null;
    if(el.classList && (el.classList.contains('photo') || el.classList.contains('person-photo'))) return el;
    return el.closest('.photo, .person-photo');
  }

  /* ─── Get the card container wrapping a photoBox ─── */
  function toCard(pb){
    return pb && pb.closest ? pb.closest('.duel-side, .board-row, .cat-tile, .person-card') : null;
  }

  /* ─── Get data-video URL from a photoBox ─── */
  function videoSrc(pb){
    if(!pb) return null;
    // Attribute may be on the img, fallback div, or the photoBox itself
    if(pb.dataset && pb.dataset.video) return pb.dataset.video;
    const child = pb.querySelector('[data-video]');
    return child && child.dataset && child.dataset.video ? child.dataset.video : null;
  }

  /* ─── Mount: create and play a muted video inside photoBox ─── */
  function mount(pb){
    if(!pb || LIVE.has(pb) || reduced) return;
    const src = videoSrc(pb);
    if(!src) return;

    const v = document.createElement('video');
    v.className = 'goat-clip';
    v.muted = true;          // start muted — required for browser autoplay
    v.loop = true;
    v.playsInline = true;
    v.preload = 'metadata';
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.setAttribute('aria-hidden', 'true');
    v.src = src;

    function reveal(){
      if(!LIVE.has(pb)) return;
      v.classList.add('ready');
      pb.classList.add('video-playing');
      const card = toCard(pb);
      if(card) card.classList.add('video-playing');
    }
    v.addEventListener('loadeddata', reveal, { once: true });
    v.addEventListener('canplay',    reveal, { once: true });
    v.addEventListener('playing',    reveal, { once: true });
    v.addEventListener('error',      () => unmount(pb));

    pb.appendChild(v);
    LIVE.set(pb, v);
    v.play().catch(() => { v.muted = true; v.play().catch(()=>{}); });
  }

  /* ─── Unmount: remove video, clean up classes ─── */
  function unmount(pb){
    if(!pb) return;
    const v = LIVE.get(pb);
    if(v){
      LIVE.delete(pb);
      v.muted = true;
      v.pause();
      v.removeAttribute('src');
      try{ v.load(); }catch(e){}
      v.remove();
    }
    pb.classList.remove('video-playing');
    const card = toCard(pb);
    if(card) card.classList.remove('video-playing');
    if(audioBox === pb) audioBox = null;
  }

  /* ─── IntersectionObserver: mount on-screen, unmount off-screen ─── */
  const io = typeof IntersectionObserver !== 'undefined'
    ? new IntersectionObserver(entries => {
        for(const e of entries){
          if(e.isIntersecting){ mount(e.target); }
          else if(audioBox !== e.target){ unmount(e.target); }
        }
      }, { rootMargin: '200px 0px 200px 0px', threshold: 0 })
    : null;

  /* ─── Register a photoBox for observation ─── */
  function observe(pb){
    if(!pb || observed.has(pb)) return;
    if(!videoSrc(pb)) return;   // no video yet, wait for data-video attribute
    observed.add(pb);
    if(io) io.observe(pb);
  }

  /* ─── Scan: find all photoBoxes that have (or contain) data-video ─── */
  function scan(root){
    const scope = (root instanceof Element) ? root : document;
    // Find all elements with data-video and resolve their photoBox
    scope.querySelectorAll('[data-video]').forEach(el => {
      const pb = toPhotoBox(el);
      if(pb) observe(pb);
    });
    // Also check .photo / .person-photo directly in case data-video is on them
    scope.querySelectorAll('.photo, .person-photo').forEach(pb => {
      if(!observed.has(pb) && videoSrc(pb)) observe(pb);
    });
  }

  /* ─── MutationObserver: catch dynamically injected cards & data-video attrs ─── */
  if(typeof MutationObserver !== 'undefined'){
    new MutationObserver(mutations => {
      for(const m of mutations){
        if(m.type === 'attributes' && m.attributeName === 'data-video'){
          const pb = toPhotoBox(m.target);
          if(pb) observe(pb);
        }
        for(const node of m.addedNodes){
          if(node.nodeType !== 1) continue;
          // Node itself might have data-video
          if(node.dataset && node.dataset.video){ const pb = toPhotoBox(node); if(pb) observe(pb); }
          // Or its descendants do
          scan(node);
        }
      }
    }).observe(document.documentElement, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['data-video']
    });
  }

  /* ─── Hover: set/clear audio ─── */
  function setAudio(pb){
    if(pb === audioBox) return;

    // Mute old
    if(audioBox){
      const ov = LIVE.get(audioBox);
      if(ov){ ov.muted = true; ov.volume = 0; }
      audioBox = null;
    }

    if(!pb) return;
    audioBox = pb;

    // If video not mounted yet (rare), mount on demand
    if(!LIVE.has(pb)) mount(pb);
    const v = LIVE.get(pb);
    if(v){
      v.muted = false;
      v.volume = 1.0;
      if(v.paused) v.play().catch(() => { v.muted = true; v.play().catch(()=>{}); });
    }
  }

  // Use mouseover / mouseleave on the photoBox itself
  document.addEventListener('mouseover', e => {
    const pb = toPhotoBox(e.target);
    // Only set audio if this photoBox has (or will have) a video
    if(pb && (LIVE.has(pb) || videoSrc(pb))){
      setAudio(pb);
    } else {
      setAudio(null);
    }
  }, { passive: true, capture: true });

  document.addEventListener('mouseleave', () => setAudio(null), { passive: true });

  /* ─── Visibility: pause/resume all ─── */
  document.addEventListener('visibilitychange', () => {
    if(document.hidden){
      setAudio(null);
      for(const v of LIVE.values()) v.pause();
    } else {
      for(const v of LIVE.values()) v.play().catch(()=>{});
    }
  });

  /* ─── Initial scans (staggered for late JS renders) ─── */
  function initScan(){
    scan();
    setTimeout(scan, 500);
    setTimeout(scan, 1500);
    setTimeout(scan, 3000);
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', initScan);
  } else {
    initScan();
  }

  window.VideoHover = { scan, mount, unmount, teardown: () => [...LIVE.keys()].forEach(unmount) };
})();
