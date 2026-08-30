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

  // IntersectionObserver: automatically stream and play video when on screen, pause when offscreen
  const io = ('IntersectionObserver' in window) ? new IntersectionObserver(entries => {
    for(const entry of entries){
      if(entry.isIntersecting){
        play(entry.target);
      } else {
        teardown(entry.target);
      }
    }
  }, {
    rootMargin: '200px 0px 200px 0px',
    threshold: [0, 0.05, 0.5]
  }) : null;

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

  // Smooth hover audio handler: card-level tracking to eliminate flickering
  function handleCardHover(e){
    const card = e.target && e.target.closest ? e.target.closest('.photo, .person-photo, #photo-wrap, .duel-side, .board-row, .cat-tile, .contender-card, [data-video]') : null;
    if(card === currentHoveredCard) return;

    // Leaving previous card
    if(currentHoveredCard && (!card || !currentHoveredCard.contains(card))){
      const prevVideo = resolveVideo(currentHoveredCard);
      if(prevVideo){
        prevVideo.muted = true;
      }
      if(activeAudioVideo === prevVideo){
        activeAudioVideo = null;
      }
    }

    currentHoveredCard = card;
    if(!card) return;

    // Ensure video is playing for current card
    const targetWithVideo = card.matches('[data-video]') ? card : card.querySelector('[data-video]');
    if(targetWithVideo && !live.has(targetWithVideo)){
      play(targetWithVideo);
    }

    const v = resolveVideo(card);
    if(!v) return;

    // Mute any other video
    if(activeAudioVideo && activeAudioVideo !== v){
      activeAudioVideo.muted = true;
    }

    // Turn audio on immediately on hover
    v.muted = false;
    v.volume = 1.0;
    activeAudioVideo = v;

    if(v.paused){
      v.play().catch(() => {
        v.muted = true;
        v.play().catch(() => {});
      });
    }
  }

  document.addEventListener('mouseover', handleCardHover, true);
  document.addEventListener('pointerenter', handleCardHover, true);
  document.addEventListener('mouseleave', () => {
    if(activeAudioVideo){
      activeAudioVideo.muted = true;
      activeAudioVideo = null;
    }
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
    } else {
      scan();
    }
  });

  function scan(root){
    if(!io || reduced) return;
    for(const el of (root || document).querySelectorAll('[data-video]')){
      if(el.dataset.clipWatched) continue;
      el.dataset.clipWatched = '1';
      io.observe(el);
    }
  }

  if('MutationObserver' in window){
    new MutationObserver(()=> scan()).observe(document.documentElement, { childList: true, subtree: true });
  }

  document.addEventListener('DOMContentLoaded', ()=> scan());
  scan();

  window.VideoHover = { scan, play, teardown: ()=> [...live.keys()].forEach(teardown) };
})();
