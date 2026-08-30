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

  const MAX_PLAYING = 6;          // cap concurrent decodes
  const VISIBLE = 0.5;            // half the card on screen before it plays
  const live = new Map();         // img -> video
  const order = [];               // play order, oldest first

  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Browsers only allow audio after the user has interacted with the page.
  // Until then a hover cannot unmute, so track the first real gesture.
  let canUnmute = false;
  const arm = () => { canUnmute = true; };
  ['pointerdown','keydown','touchstart'].forEach(e=>
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
    v.muted = true;            // muted autoplay is the only kind browsers allow
    v.loop = true;
    v.playsInline = true;
    v.preload = 'metadata';
    v.setAttribute('playsinline','');
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
      else teardown(e.target);
    }
  }, { threshold:[0, VISIBLE, 1] }) : null;

  // Sound follows the pointer, and only where a clip is actually playing.
  document.addEventListener('pointerover', e=>{
    const img = e.target.closest && e.target.closest('img[data-video]');
    if(!img) return;
    const v = live.get(img);
    if(!v || !canUnmute) return;
    v.muted = false;
    v.volume = 0.85;
    const p = v.play();
    if(p && p.catch) p.catch(()=>{ v.muted = true; });
  }, true);

  document.addEventListener('pointerout', e=>{
    const img = e.target.closest && e.target.closest('img[data-video]');
    if(!img) return;
    const v = live.get(img);
    if(v) v.muted = true;
  }, true);

  // A background tab should not keep playing audio.
  document.addEventListener('visibilitychange', ()=>{
    if(document.hidden) for(const img of [...order]) teardown(img);
  });

  function scan(root){
    if(!io || reduced) return;
    for(const img of (root || document).querySelectorAll('img[data-video]')){
      if(img.dataset.clipWatched) continue;
      img.dataset.clipWatched = '1';
      io.observe(img);
    }
  }

  // Cards are rendered asynchronously and re-rendered on filter changes, so
  // watch the DOM rather than scanning once.
  if('MutationObserver' in window){
    new MutationObserver(()=> scan()).observe(document.documentElement, { childList:true, subtree:true });
  }
  document.addEventListener('DOMContentLoaded', ()=> scan());
  scan();

  window.VideoHover = { scan, teardown: ()=> [...order].forEach(teardown) };
})();
