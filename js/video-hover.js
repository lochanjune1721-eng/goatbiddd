// js/video-hover.js — High-performance contender video engine with single-audio enforcement
(function(){
  if(typeof window === 'undefined') return;

  const live = new Map();         // card element -> HTMLVideoElement
  let activeAudioVideo = null;    // currently unmuted video
  let currentHoveredCard = null;  // currently hovered container card

  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Global single-audio enforcement: immediately silence & pause every other video on the DOM
  function silenceAllOtherVideos(exceptVideo){
    document.querySelectorAll('video, audio').forEach(media => {
      if(media !== exceptVideo){
        media.muted = true;
        media.volume = 0;
        if(media.classList && media.classList.contains('goat-clip')) {
          media.pause();
        }
      }
    });
    for(const [c, v] of live.entries()){
      if(v !== exceptVideo){
        teardownCard(c);
      }
    }
  }

  // Pre-unlock browser audio on any user gesture
  const unlockAudio = () => {
    if(activeAudioVideo && activeAudioVideo.muted) {
      silenceAllOtherVideos(activeAudioVideo);
      activeAudioVideo.muted = false;
      activeAudioVideo.volume = 1.0;
      activeAudioVideo.play().catch(() => { activeAudioVideo.muted = true; });
    }
  };
  ['pointerdown','keydown','touchstart','mousedown','click'].forEach(evt =>
    window.addEventListener(evt, unlockAudio, { passive: true })
  );

  function getCard(target){
    if(!target || !target.closest) return null;
    return target.closest('.duel-side, .board-row, .cat-tile, .person-card, #photo-wrap');
  }

  function getVideoSrc(card){
    if(!card) return null;
    if(card.dataset && card.dataset.video) return card.dataset.video;
    const elWithVideo = card.querySelector('[data-video]');
    if(elWithVideo && elWithVideo.dataset && elWithVideo.dataset.video) return elWithVideo.dataset.video;
    return null;
  }

  function getPhotoContainer(card){
    if(!card) return null;
    if(card.classList && (card.classList.contains('photo') || card.classList.contains('person-photo'))) return card;
    return card.querySelector('.photo, .person-photo') || card;
  }

  function teardownCard(card){
    if(!card) return;
    const v = live.get(card);
    if(v){
      if(activeAudioVideo === v) activeAudioVideo = null;
      live.delete(card);
      v.muted = true;
      v.pause();
      v.removeAttribute('src');
      try { v.load(); } catch(e){}
      v.remove();
    }
    card.classList.remove('video-playing', 'video-active');
    const photoBox = getPhotoContainer(card);
    if(photoBox) {
      photoBox.classList.remove('video-playing', 'video-active');
      const still = photoBox.querySelector('img, .fallback');
      if(still) still.style.visibility = '';
    }
  }

  function playCard(card){
    if(!card || live.has(card) || reduced) return;
    const src = getVideoSrc(card);
    if(!src) return;

    const photoBox = getPhotoContainer(card);
    if(!photoBox) return;

    const v = document.createElement('video');
    v.className = 'goat-clip';
    v.muted = false;
    v.volume = 1.0;
    v.loop = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.setAttribute('aria-hidden', 'true');
    v.src = src;

    // Strict single-source sound
    silenceAllOtherVideos(v);
    activeAudioVideo = v;

    const reveal = () => {
      if(!live.has(card)) return;
      v.classList.add('ready');
      card.classList.add('video-playing', 'video-active');
      photoBox.classList.add('video-playing', 'video-active');
      const still = photoBox.querySelector('img, .fallback');
      if(still) still.style.visibility = 'hidden';
    };

    v.addEventListener('loadeddata', reveal, { once: true });
    v.addEventListener('canplay', reveal, { once: true });
    v.addEventListener('playing', () => {
      silenceAllOtherVideos(v);
      reveal();
    }, { once: true });
    v.addEventListener('error', () => teardownCard(card));

    photoBox.appendChild(v);
    live.set(card, v);

    const p = v.play();
    if(p && p.catch){
      p.catch(() => {
        // Fallback to muted if unmuted playback is restricted
        v.muted = true;
        v.play().catch(() => {});
      });
    }
  }

  // Hover detection using stable card containers
  function handleCardHover(e){
    const card = getCard(e.target);
    if(card === currentHoveredCard) return;

    // Leaving previous card -> teardown to clean square still & silence
    if(currentHoveredCard){
      teardownCard(currentHoveredCard);
      currentHoveredCard = null;
    }

    if(!card) {
      silenceAllOtherVideos(null);
      activeAudioVideo = null;
      return;
    }

    currentHoveredCard = card;

    // Entered new card -> start video & audio exclusively
    playCard(card);
  }

  document.addEventListener('mouseover', handleCardHover, true);
  document.addEventListener('pointerenter', handleCardHover, true);
  document.addEventListener('mouseleave', () => {
    if(currentHoveredCard){
      teardownCard(currentHoveredCard);
      currentHoveredCard = null;
    }
    silenceAllOtherVideos(null);
    activeAudioVideo = null;
  });

  document.addEventListener('visibilitychange', ()=>{
    if(document.hidden){
      if(currentHoveredCard) teardownCard(currentHoveredCard);
      currentHoveredCard = null;
      silenceAllOtherVideos(null);
    }
  });

  window.VideoHover = { scan: ()=>{}, play: playCard, teardown: ()=> [...live.keys()].forEach(teardownCard) };
})();
