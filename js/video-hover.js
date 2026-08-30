// js/video-hover.js — stills that become clips.
//
// Every contender card renders a still. Where a clip exists (people.video_path,
// surfaced as data-video on the <img>), the still is replaced by a muted,
// looping video while the card is on screen, and paused and torn down when it
// scrolls away — so a page of 30 boards never has 60 videos decoding at once.
// Hovering a playing clip turns its sound on; leaving mutes it again.
//
// The still is never removed, only covered. If the clip 404s, stalls, or the
// browser refuses to play it, what remains on screen is exactly the image that
// was there before.
(function(){
  if(typeof window === 'undefined') return;

  const MAX_PLAYING = 8;          // cap concurrent decodes
  const VISIBLE = 0.15;           // start playing once visible in viewport
  const live = new Map();         // img/el -> video
  const order = [];               // play order, oldest first

  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Browsers allow audio after user interaction; arm on any interaction
  let canUnmute = false;
  const arm = () => { canUnmute = true; };
  ['pointerdown','keydown','touchstart','pointerover','mouseover','mouseenter','click'].forEach(e=>
    window.addEventListener(e, arm, { once:true, passive:true }));

  function teardown(img){
    const v = live.get(img);
    if(!v) return;
    live.delete(img);
    const i = order.indexOf(img); if(i>=0) order.splice(i,1);
    v.pause();
    v.removeAttribute('src');
    try { v.load(); } catch(e){}
    v.remove();
    img.style.visibility = '';
  }

  function play(img){
    if(live.has(img) || reduced) return;
    const src = img.dataset.video;
    if(!src) return;

    while(order.length >= MAX_PLAYING) teardown(order[0]);

    const v = document.createElement('video');
    v.className = 'goat-clip';
    v.muted = true;            // muted autoplay is required by browsers
    v.loop = true;
    v.playsInline = true;
    v.preload = 'metadata';
    v.setAttribute('playsinline','');
    v.setAttribute('webkit-playsinline','');
    v.setAttribute('aria-hidden','true');
    v.src = src;

    // Only reveal once frames are actually available, so a slow or dead clip
    // never blanks the card.
    v.addEventListener('loadeddata', ()=>{
      if(!live.has(img)) return;
      v.classList.add('ready');
      img.style.visibility = 'hidden';
    }, { once:true });
    v.addEventListener('error', ()=> teardown(img));

    const parent = img.parentElement;
    if(!parent) return;
    parent.appendChild(v);
    live.set(img, v);
    order.push(img);
    const p = v.play();
    if(p && p.catch) p.catch(()=> teardown(img));   // autoplay refused
  }

  const io = ('IntersectionObserver' in window) ? new IntersectionObserver(entries=>{
    for(const e of entries){
      if(e.isIntersecting && e.intersectionRatio >= VISIBLE) play(e.target);
      else if(!e.isIntersecting) teardown(e.target);
    }
  }, { threshold:[0, VISIBLE, 0.5, 1] }) : null;

  // Find the clip under the pointer
  function clipUnder(target){
    if(!target || !target.closest) return null;
    const v = target.closest('video.goat-clip');
    if(v) return v;
    const el = target.closest('[data-video]');
    if(el) return live.get(el) || null;
    const box = target.closest('.photo, .person-photo, #photo-wrap');
    if(box){
      const held = box.querySelector('video.goat-clip');
      if(held) return held;
    }
    return null;
  }

  // Sound follows the pointer, and only where a clip is actually playing.
  document.addEventListener('pointerover', e=>{
    const box = e.target && e.target.closest ? (e.target.closest('[data-video]') || e.target.closest('.photo, .person-photo, #photo-wrap')) : null;
    if(box){
      const targetWithVideo = box.matches('[data-video]') ? box : box.querySelector('[data-video]');
      if(targetWithVideo && !live.has(targetWithVideo)){
        play(targetWithVideo);
      }
    }
    const v = clipUnder(e.target);
    if(!v || !canUnmute) return;
    v.muted = false;
    v.volume = 0.85;
    const p = v.play();
    if(p && p.catch) p.catch(()=>{ v.muted = true; });
  }, true);

  document.addEventListener('pointerout', e=>{
    const v = clipUnder(e.target);
    if(v) v.muted = true;
  }, true);

  // Background tab should pause videos
  document.addEventListener('visibilitychange', ()=>{
    if(document.hidden) for(const img of [...order]) teardown(img);
  });

  function scan(root){
    if(!io || reduced) return;
    for(const img of (root || document).querySelectorAll('[data-video]')){
      if(img.dataset.clipWatched) continue;
      img.dataset.clipWatched = '1';
      io.observe(img);
    }
  }

  if('MutationObserver' in window){
    new MutationObserver(()=> scan()).observe(document.documentElement, { childList:true, subtree:true });
  }
  document.addEventListener('DOMContentLoaded', ()=> scan());
  scan();

  window.VideoHover = { scan, play, teardown: ()=> [...order].forEach(teardown) };
})();
