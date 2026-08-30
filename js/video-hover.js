// js/video-hover.js — Seamless contender video playback & responsive hover audio
(function(){
  if(typeof window === 'undefined') return;

  const VISIBLE_THRESHOLD = 0.05; // start loading immediately when even 5% is on screen
  const live = new Map();         // [data-video] element -> HTMLVideoElement
  let activeAudioVideo = null;    // currently unmuted video

  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Unlock browser audio context as early as possible on any gesture
  let audioUnlocked = false;
  const unlockAudio = () => { audioUnlocked = true; };
  ['pointerdown','pointermove','keydown','touchstart','mousedown','mousemove','mouseover','mouseenter','click'].forEach(evt =>
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
  }

  function play(el){
    if(live.has(el) || reduced) return;
    const src = el.dataset.video;
    if(!src) return;

    const v = document.createElement('video');
    v.className = 'goat-clip';
    v.muted = true;               // Browsers mandate muted autoplay
    v.loop = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.setAttribute('aria-hidden', 'true');
    v.src = src;

    // Show clip once frames are ready
    v.addEventListener('loadeddata', ()=>{
      if(!live.has(el)) return;
      v.classList.add('ready');
      el.style.visibility = 'hidden';
    }, { once: true });

    v.addEventListener('error', ()=> teardown(el));

    const parent = el.parentElement;
    if(!parent) return;
    parent.appendChild(v);
    live.set(el, v);

    const playPromise = v.play();
    if(playPromise && playPromise.catch){
      playPromise.catch(() => {
        // If autoplay fails, ensure video stays in DOM ready for hover
      });
    }
  }

  // IntersectionObserver: all visible videos in viewport play simultaneously
  const io = ('IntersectionObserver' in window) ? new IntersectionObserver(entries => {
    for(const entry of entries){
      if(entry.isIntersecting){
        play(entry.target);
      } else {
        teardown(entry.target);
      }
    }
  }, {
    rootMargin: '120px 0px 120px 0px',
    threshold: [0, VISIBLE_THRESHOLD, 0.5]
  }) : null;

  // Resolve the video element belonging to any hovered element or its container card
  function resolveVideo(target){
    if(!target) return null;
    if(target.matches && target.matches('video.goat-clip')) return target;
    const directVideo = target.closest ? target.closest('video.goat-clip') : null;
    if(directVideo) return directVideo;

    // Check if target has data-video
    if(target.dataset && target.dataset.video) return live.get(target) || null;

    // Search nearest contender container (photo box, duel side, category row, etc.)
    const box = target.closest ? target.closest('.photo, .person-photo, #photo-wrap, .duel-side, .board-row, .cat-tile, .contender-card, .duel-card') : null;
    if(box){
      const held = box.querySelector('video.goat-clip');
      if(held) return held;
      const elWithVideo = box.matches('[data-video]') ? box : box.querySelector('[data-video]');
      if(elWithVideo) return live.get(elWithVideo) || null;
    }
    return null;
  }

  // Ensure video is created and playing when hovered, and unmute
  function handleHoverIn(e){
    audioUnlocked = true;
    const container = e.target && e.target.closest ? e.target.closest('.photo, .person-photo, #photo-wrap, .duel-side, .board-row, .cat-tile, .contender-card, [data-video]') : null;
    if(container){
      const targetWithVideo = container.matches('[data-video]') ? container : container.querySelector('[data-video]');
      if(targetWithVideo && !live.has(targetWithVideo)){
        play(targetWithVideo);
      }
    }

    const v = resolveVideo(e.target);
    if(!v) return;

    // Mute any other currently unmuted video
    if(activeAudioVideo && activeAudioVideo !== v){
      activeAudioVideo.muted = true;
    }

    v.muted = false;
    v.volume = 1.0;
    activeAudioVideo = v;
    const p = v.play();
    if(p && p.catch) p.catch(() => {});
  }

  function handleHoverOut(e){
    const v = resolveVideo(e.target);
    if(v){
      v.muted = true;
      if(activeAudioVideo === v) activeAudioVideo = null;
    }
  }

  // Bind global hover sound listeners
  document.addEventListener('pointerover', handleHoverIn, true);
  document.addEventListener('mouseover', handleHoverIn, true);
  document.addEventListener('pointerout', handleHoverOut, true);
  document.addEventListener('mouseout', handleHoverOut, true);

  // Background tab should pause and mute
  document.addEventListener('visibilitychange', ()=>{
    if(document.hidden){
      if(activeAudioVideo){
        activeAudioVideo.muted = true;
        activeAudioVideo = null;
      }
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
