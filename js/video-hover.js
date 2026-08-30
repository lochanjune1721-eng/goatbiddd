// js/video-hover.js — Auto-play muted on-screen, unmute on hover, single audio
(function(){
  if(typeof window === 'undefined') return;

  const live = new Map();       // card -> video element
  let currentAudioCard = null;  // card whose video is unmuted
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── helpers ── */

  function getCard(el){
    return el && el.closest ? el.closest('.duel-side, .board-row, .cat-tile, .person-card') : null;
  }

  function getVideoSrc(card){
    if(!card) return null;
    if(card.dataset && card.dataset.video) return card.dataset.video;
    const child = card.querySelector('[data-video]');
    return child && child.dataset && child.dataset.video ? child.dataset.video : null;
  }

  function getPhotoBox(card){
    if(!card) return null;
    if(card.classList.contains('photo') || card.classList.contains('person-photo')) return card;
    return card.querySelector('.photo, .person-photo') || card;
  }

  /* ── mount / unmount video ── */

  function mountVideo(card){
    if(!card || live.has(card) || reduced) return;
    const src = getVideoSrc(card);
    if(!src) return;
    const photoBox = getPhotoBox(card);
    if(!photoBox) return;

    const v = document.createElement('video');
    v.className = 'goat-clip';
    v.muted = true;         // always start muted — browser allows autoplay when muted
    v.loop = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.setAttribute('playsinline','');
    v.setAttribute('webkit-playsinline','');
    v.setAttribute('aria-hidden','true');
    v.src = src;

    const onReady = () => {
      if(!live.has(card)) return;
      v.classList.add('ready');
      card.classList.add('video-playing');
      photoBox.classList.add('video-playing');
    };
    v.addEventListener('loadeddata', onReady, { once: true });
    v.addEventListener('canplay',    onReady, { once: true });
    v.addEventListener('playing',    onReady, { once: true });
    v.addEventListener('error', () => unmountVideo(card));

    photoBox.appendChild(v);
    live.set(card, v);

    v.play().catch(() => {
      // Browser blocked unmuted play — already muted, this shouldn't fail
      v.muted = true;
      v.play().catch(() => {});
    });
  }

  function unmountVideo(card){
    if(!card) return;
    const v = live.get(card);
    if(v){
      live.delete(card);
      v.muted = true;
      v.pause();
      v.removeAttribute('src');
      try{ v.load(); } catch(e){}
      v.remove();
    }
    card.classList.remove('video-playing');
    const pb = getPhotoBox(card);
    if(pb) pb.classList.remove('video-playing');
    if(currentAudioCard === card) currentAudioCard = null;
  }

  /* ── IntersectionObserver: auto-play when on screen ── */

  const io = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
    for(const entry of entries){
      if(entry.isIntersecting){
        mountVideo(entry.target);
      } else {
        unmountVideo(entry.target);
      }
    }
  }, { rootMargin: '100px 0px 100px 0px', threshold: 0.1 }) : null;

  /* ── Hover: audio on / off ── */

  function setAudioCard(card){
    if(card === currentAudioCard) return;

    // Mute previous
    if(currentAudioCard){
      const pv = live.get(currentAudioCard);
      if(pv){ pv.muted = true; pv.volume = 0; }
    }

    currentAudioCard = card;

    if(!card) return;
    const v = live.get(card);
    if(!v) return;
    v.muted = false;
    v.volume = 1.0;
    // If browser blocked autoplay at mount, retry with sound now
    if(v.paused) v.play().catch(() => { v.muted = true; v.play().catch(()=>{}); });
  }

  document.addEventListener('mouseover', e => {
    const card = getCard(e.target);
    setAudioCard(card && live.has(card) ? card : null);
  }, true);

  document.addEventListener('mouseleave', () => setAudioCard(null), true);

  /* ── Scan DOM for video cards ── */

  function scan(root){
    if(!io || reduced) return;
    const scope = root || document;
    scope.querySelectorAll('.duel-side[data-video], .board-row[data-video], .duel-side :is([data-video]), .board-row :is([data-video])').forEach(el => {
      const card = getCard(el) || (el.matches('.duel-side, .board-row') ? el : null);
      if(!card || card.dataset.ioWatched) return;
      card.dataset.ioWatched = '1';
      io.observe(card);
    });
    // Also directly scan cards that ARE the containers
    scope.querySelectorAll('.duel-side, .board-row').forEach(card => {
      if(card.dataset.ioWatched) return;
      if(!getVideoSrc(card)) return;
      card.dataset.ioWatched = '1';
      io.observe(card);
    });
  }

  if('MutationObserver' in window){
    new MutationObserver(() => scan()).observe(document.documentElement, { childList: true, subtree: true });
  }
  document.addEventListener('DOMContentLoaded', () => scan());
  scan();

  // Pause all when tab hidden
  document.addEventListener('visibilitychange', () => {
    if(document.hidden){ for(const v of live.values()) v.pause(); }
    else { for(const v of live.values()) v.play().catch(()=>{}); }
  });

  window.VideoHover = { scan, play: mountVideo, teardown: () => [...live.keys()].forEach(unmountVideo) };
})();
