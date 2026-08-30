// js/video-hover.js — High-performance contender video engine with instant load & resilient hover audio
(function(){
  if(typeof window === 'undefined') return;

  const live = new Map();         // [data-video] element -> HTMLVideoElement
  let activeAudioVideo = null;    // currently unmuted video
  let currentHoveredCard = null;  // currently hovered contender card

  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Pre-unlock browser audio on any user gesture
  const unlockAudio = () => {
    if(activeAudioVideo && activeAudioVideo.muted) {
      activeAudioVideo.muted = false;
      activeAudioVideo.play().catch(() => { activeAudioVideo.muted = true; });
    }
  };
  ['pointerdown','keydown','touchstart','mousedown','click'].forEach(evt =>
    window.addEventListener(evt, unlockAudio, { passive: true })
  );

  function teardown(el){
    const v = live.get(el);
    if(!v) return;
    if(activeAudioVideo === v) {
      activeAudioVideo = null;
    }
    live.delete(el);
    v.pause();
    v.removeAttribute('src');
    try { v.load(); } catch(e){}
    v.remove();
    el.style.visibility = '';
    const box = el.closest ? el.closest('.duel-side, .photo, .person-photo, .person-card') : null;
    if(box) box.classList.remove('video-playing', 'video-active');
  }

  function play(el){
    if(live.has(el) || reduced) return;
    const src = el.dataset.video;
    if(!src) return;

    const v = document.createElement('video');
    v.className = 'goat-clip';
    v.muted = true;               // Always start muted so browsers start instant decode without permission blocks
    v.loop = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.setAttribute('aria-hidden', 'true');
    v.src = src;

    // Reveal video immediately as soon as initial frame or metadata is ready
    const reveal = () => {
      if(!live.has(el)) return;
      v.classList.add('ready');
      el.style.visibility = 'hidden';
      const box = el.closest ? el.closest('.duel-side, .photo, .person-photo, .person-card') : null;
      if(box) box.classList.add('video-playing', 'video-active');
    };

    v.addEventListener('loadeddata', reveal, { once: true });
    v.addEventListener('canplay', reveal, { once: true });
    v.addEventListener('playing', reveal, { once: true });
    v.addEventListener('error', () => teardown(el));

    const parent = el.parentElement;
    if(!parent) return;
    parent.appendChild(v);
    live.set(el, v);

    const p = v.play();
    if(p && p.catch){
      p.catch(() => {
        // Autoplay policy fallback: guarantee muted and retry
        v.muted = true;
        v.play().catch(() => {});
      });
    }
  }

  // Resolve the video element belonging to any card or element
  function resolveVideo(target){
    if(!target) return null;
    if(target.matches && target.matches('video.goat-clip')) return target;
    const directVideo = target.closest ? target.closest('video.goat-clip') : null;
    if(directVideo) return directVideo;

    if(target.dataset && target.dataset.video) return live.get(target) || null;

    const box = target.closest ? target.closest('.photo, .person-photo, #photo-wrap, .duel-side, .board-row, .cat-tile, .contender-card, .duel-card') : null;
    if(box){
      const held = box.querySelector('video.goat-clip');
      if(held) return held;
      const elWithVideo = box.matches('[data-video]') ? box : box.querySelector('[data-video]');
      if(elWithVideo) return live.get(elWithVideo) || null;
    }
    return null;
  }

  // Smooth hover video & audio handler: plays video + audio ONLY when hovering
  function handleCardHover(e){
    const card = e.target && e.target.closest ? e.target.closest('.photo, .person-photo, #photo-wrap, .duel-side, .board-row, .cat-tile, .contender-card, [data-video]') : null;
    if(card === currentHoveredCard) return;

    // Leaving previous card: teardown video completely so card returns to clean square portrait
    if(currentHoveredCard && (!card || !currentHoveredCard.contains(card))){
      const prevVideoTarget = currentHoveredCard.matches('[data-video]') ? currentHoveredCard : currentHoveredCard.querySelector('[data-video]');
      if(prevVideoTarget) {
        teardown(prevVideoTarget);
      }
      activeAudioVideo = null;
    }

    currentHoveredCard = card;
    if(!card) return;

    // Entered new card: mount & play video with sound immediately
    const targetWithVideo = card.matches('[data-video]') ? card : card.querySelector('[data-video]');
    if(targetWithVideo){
      play(targetWithVideo);
      const v = live.get(targetWithVideo);
      if(v){
        v.muted = false;
        v.volume = 1.0;
        activeAudioVideo = v;
        if(v.paused) v.play().catch(()=>{ v.muted = true; v.play().catch(()=>{}); });
      }
    }
  }

  document.addEventListener('mouseover', handleCardHover, true);
  document.addEventListener('pointerenter', handleCardHover, true);
  document.addEventListener('mouseleave', () => {
    if(currentHoveredCard){
      const el = currentHoveredCard.matches('[data-video]') ? currentHoveredCard : currentHoveredCard.querySelector('[data-video]');
      if(el) teardown(el);
    }
    if(activeAudioVideo) activeAudioVideo = null;
    currentHoveredCard = null;
  });

  // Background tab should pause and mute
  document.addEventListener('visibilitychange', ()=>{
    if(document.hidden){
      if(activeAudioVideo){
        activeAudioVideo.muted = true;
        activeAudioVideo = null;
      }
      currentHoveredCard = null;
      for(const [el] of live) teardown(el);
    }
  });

  window.VideoHover = { scan: ()=>{}, play, teardown: ()=> [...live.keys()].forEach(teardown) };
})();
