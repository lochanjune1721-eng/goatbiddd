// js/certificate.js — the Greatest Fan of All Time certificate.
//
//   GoatCertificate.open({ fanName, fanPhotoUrl, contenderName, contenderPhotoUrl,
//                          amountCents, slug, since })
//
// Draws the certificate on a canvas, shows it, and offers it as a PNG to
// download or share.
//
// ── Why the text is drawn here and not generated ────────────────────────────
//
// An image model cannot spell. Ask one for a certificate reading "presented to
// Anujeet Sharma for backing $101" and you get a different misspelling every
// run, on a document whose whole job is to state a name and an amount exactly.
// So the words, the name and the money are drawn by this file, where they are
// the values they are meant to be, and a generated image — if one is used at
// all — is only ever the picture behind them.
//
// 1080x1350 because that is Instagram's portrait frame, and this is made to be
// posted.
(function(){
  const W = 1080, H = 1350;
  const GOLD = '#c9a86a', GOLD_LIT = '#e8cf9a', INK = '#f2efe8', MUTED = '#9a9384';

  const esc = s => String(s == null ? '' : s);
  const money = cents => '$' + Math.floor((cents || 0) / 100).toLocaleString('en-US');

  // A canvas is tainted by an image drawn from another origin unless that origin
  // says otherwise, and a tainted canvas cannot be exported — the download and
  // the share both fail at the last step. So every image is requested with CORS
  // and a failure falls back to initials rather than poisoning the export.
  function loadImage(url){
    return new Promise(resolve => {
      if(!url) return resolve(null);
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.referrerPolicy = 'no-referrer';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  function initials(name){
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if(!parts.length) return '?';
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }

  // Shrink to fit rather than overflow: a long name is common and a certificate
  // that runs off its own edge is worse than one set a little smaller.
  function fitText(ctx, text, family, weight, max, start, min){
    let size = start;
    do {
      ctx.font = `${weight} ${size}px ${family}`;
      if(ctx.measureText(text).width <= max) break;
      size -= 2;
    } while(size > min);
    return size;
  }

  function roundRect(ctx, x, y, w, h, r){
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y,     x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x,     y + h, r);
    ctx.arcTo(x,     y + h, x,     y,     r);
    ctx.arcTo(x,     y,     x + w, y,     r);
    ctx.closePath();
  }

  function circleImage(ctx, img, cx, cy, r, fallbackText){
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    if(img){
      // Cover, centred, with the crop biased up so a face is not cut at the chin.
      const scale = Math.max((r * 2) / img.width, (r * 2) / img.height);
      const w = img.width * scale, h = img.height * scale;
      ctx.drawImage(img, cx - w / 2, cy - h / 2 - h * 0.06, w, h);
    } else {
      ctx.fillStyle = '#1a1610';
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
      ctx.fillStyle = GOLD;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `400 ${Math.round(r * 0.8)}px Anton, Impact, sans-serif`;
      ctx.fillText(fallbackText, cx, cy);
    }
    ctx.restore();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = GOLD; ctx.lineWidth = 6; ctx.stroke();
  }

  async function draw(data){
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');

    // Wait for the real faces before drawing, or the certificate renders with
    // initials and then it is too late — the canvas is already exported.
    try { if(document.fonts?.ready) await document.fonts.ready; } catch(e){}
    const [fanImg, conImg] = await Promise.all([
      loadImage(data.fanPhotoUrl), loadImage(data.contenderPhotoUrl)
    ]);

    // Ground
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#14110c'); bg.addColorStop(0.5, '#0b0a08'); bg.addColorStop(1, '#14110c');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

    // Double rule, the way a certificate is bordered
    ctx.strokeStyle = GOLD; ctx.lineWidth = 6;
    roundRect(ctx, 34, 34, W - 68, H - 68, 22); ctx.stroke();
    ctx.strokeStyle = 'rgba(201,168,106,.42)'; ctx.lineWidth = 2;
    roundRect(ctx, 52, 52, W - 104, H - 104, 14); ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    // Wordmark
    ctx.fillStyle = INK;
    ctx.font = '400 46px Anton, Impact, sans-serif';
    ctx.fillText('THE TRUE', W / 2 - 52, 150);
    ctx.fillStyle = GOLD;
    ctx.fillText('GOAT', W / 2 + 118, 150);

    ctx.fillStyle = MUTED;
    ctx.font = '700 17px "JetBrains Mono", ui-monospace, monospace';
    ctx.letterSpacing = '6px';
    ctx.fillText('CERTIFICATE OF RECORD', W / 2, 196);
    ctx.letterSpacing = '0px';

    ctx.strokeStyle = 'rgba(201,168,106,.5)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(300, 224); ctx.lineTo(W - 300, 224); ctx.stroke();

    // The fan
    circleImage(ctx, fanImg, W / 2, 420, 150, initials(data.fanName));

    // Crown over the portrait
    ctx.font = '400 74px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
    ctx.fillText('👑', W / 2, 272);

    ctx.fillStyle = MUTED;
    ctx.font = '600 22px Inter, system-ui, sans-serif';
    ctx.fillText('This certificate is presented to', W / 2, 640);

    ctx.fillStyle = INK;
    const nameSize = fitText(ctx, data.fanName, 'Anton, Impact, sans-serif', '400', W - 200, 84, 34);
    ctx.font = `400 ${nameSize}px Anton, Impact, sans-serif`;
    ctx.fillText(data.fanName, W / 2, 640 + nameSize + 14);

    let y = 640 + nameSize + 70;

    ctx.fillStyle = MUTED;
    ctx.font = '600 22px Inter, system-ui, sans-serif';
    ctx.fillText('as the Greatest Fan of All Time of', W / 2, y);
    y += 46;

    // The contender, beside their name
    const conSize = fitText(ctx, data.contenderName, 'Anton, Impact, sans-serif', '400', W - 380, 56, 26);
    ctx.font = `400 ${conSize}px Anton, Impact, sans-serif`;
    const conW = ctx.measureText(data.contenderName).width;
    const chip = 84, gap = 26;
    const blockW = chip + gap + conW;
    const startX = (W - blockW) / 2;
    circleImage(ctx, conImg, startX + chip / 2, y + 14, chip / 2, initials(data.contenderName));
    ctx.fillStyle = GOLD_LIT;
    ctx.textAlign = 'left';
    ctx.fillText(data.contenderName, startX + chip + gap, y + 14 + conSize * 0.36);
    ctx.textAlign = 'center';
    y += 108;

    ctx.fillStyle = MUTED;
    ctx.font = '600 22px Inter, system-ui, sans-serif';
    ctx.fillText('after backing', W / 2, y);
    y += 74;

    ctx.fillStyle = GOLD;
    ctx.font = '400 92px Anton, Impact, sans-serif';
    ctx.fillText(money(data.amountCents), W / 2, y);
    y += 44;

    ctx.fillStyle = MUTED;
    ctx.font = '600 20px Inter, system-ui, sans-serif';
    ctx.fillText('of their own money behind them', W / 2, y);

    // Seal and provenance
    const sealY = H - 168;
    ctx.beginPath(); ctx.arc(W / 2, sealY, 58, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(201,168,106,.14)'; ctx.fill();
    ctx.strokeStyle = GOLD; ctx.lineWidth = 3; ctx.stroke();
    ctx.beginPath(); ctx.arc(W / 2, sealY, 46, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(201,168,106,.55)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = GOLD;
    ctx.font = '400 40px Anton, Impact, sans-serif';
    ctx.fillText('GOAT', W / 2, sealY + 14);

    ctx.fillStyle = MUTED;
    ctx.font = '600 16px "JetBrains Mono", ui-monospace, monospace';
    const when = data.since ? new Date(data.since) : new Date();
    const stamp = isNaN(when) ? new Date() : when;
    ctx.fillText(
      `thetruegoat.com  ·  held since ${stamp.toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' })}`,
      W / 2, H - 74);

    return canvas;
  }

  function filenameFor(data){
    const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return `goat-certificate-${slug(data.fanName)}-${slug(data.contenderName)}.png`;
  }

  function shareText(data){
    return `I'm the Greatest Fan of All Time of ${data.contenderName} on The True GOAT — ${money(data.amountCents)} behind them. Come take it off me.`;
  }

  async function open(data){
    document.getElementById('goat-cert-modal')?.remove();

    const wrap = document.createElement('div');
    wrap.id = 'goat-cert-modal';
    wrap.className = 'goat-cert-modal';
    wrap.innerHTML = `
      <div class="goat-cert-sheet" role="dialog" aria-modal="true" aria-label="Your certificate">
        <button class="goat-cert-close" aria-label="Close">×</button>
        <div class="goat-cert-canvas"><div class="goat-cert-loading">Drawing your certificate…</div></div>
        <div class="goat-cert-acts">
          <button class="goat-cert-btn primary" data-download>Download</button>
          <button class="goat-cert-btn" data-share hidden>Share</button>
          <a class="goat-cert-btn" data-x target="_blank" rel="noopener">Post on X</a>
        </div>
        <p class="goat-cert-note">Instagram has no web share — download it, then post it from your phone.</p>
      </div>`;
    document.body.appendChild(wrap);

    const close = () => wrap.remove();
    wrap.querySelector('.goat-cert-close').onclick = close;
    wrap.addEventListener('click', e => { if(e.target === wrap) close(); });
    document.addEventListener('keydown', function onKey(e){
      if(e.key === 'Escape'){ close(); document.removeEventListener('keydown', onKey); }
    });

    const canvas = await draw(data);
    const holder = wrap.querySelector('.goat-cert-canvas');
    holder.innerHTML = '';
    canvas.style.cssText = 'width:100%;height:auto;display:block;border-radius:10px';
    holder.appendChild(canvas);

    const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
    const name = filenameFor(data);

    wrap.querySelector('[data-download]').onclick = () => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    };

    // Sharing the file itself — which is what puts it in WhatsApp, Instagram or
    // a DM — only exists on some browsers, and only for file types they accept.
    // Offered when it is really there rather than shown and then failing.
    const file = new File([blob], name, { type: 'image/png' });
    const shareBtn = wrap.querySelector('[data-share]');
    if(navigator.canShare?.({ files: [file] })){
      shareBtn.hidden = false;
      shareBtn.onclick = async () => {
        try { await navigator.share({ files: [file], text: shareText(data) }); }
        catch(e){}
      };
    }

    const x = wrap.querySelector('[data-x]');
    x.href = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(shareText(data)) +
             '&url=' + encodeURIComponent('https://thetruegoat.com/person?slug=' + esc(data.slug || ''));
  }

  window.GoatCertificate = { open, draw, filenameFor };
})();
