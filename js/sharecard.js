/*
 * Shareable "My Top 10" card, drawn on a 1080×1350 canvas (a 4:5 portrait
 * post). Covers come through the same-origin art proxy when available so the
 * canvas can be exported.
 */
(function () {
  const W = 1080, H = 1350;
  const DISPLAY = '"Fraunces", Georgia, serif';
  const BODY = '"Archivo", system-ui, -apple-system, sans-serif';
  const INK = '#16100c', CREAM = '#f2e8d5', CREAM2 = 'rgba(242,232,213,.62)', CREAM3 = 'rgba(242,232,213,.4)', ACCENT = '#d65a24';

  function loadImage(src, timeout = 5000) {
    return new Promise((resolve) => {
      if (!src) return resolve(null);
      const img = new Image();
      img.crossOrigin = 'anonymous';
      const t = setTimeout(() => resolve(null), timeout);
      img.onload = () => { clearTimeout(t); resolve(img); };
      img.onerror = () => { clearTimeout(t); resolve(null); };
      img.src = src;
    });
  }
  function fit(ctx, text, max) {
    if (ctx.measureText(text).width <= max) return text;
    let s = text;
    while (s.length > 1 && ctx.measureText(s + '…').width > max) s = s.slice(0, -1);
    return s.trimEnd() + '…';
  }
  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else { ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); }
  }

  /**
   * items: [{ title, artist, score, art:url }]
   * Returns a PNG Blob.
   */
  async function render({ heading = 'My Top 10', sub = '', items }) {
    await Promise.all([
      document.fonts?.load(`700 80px ${DISPLAY}`), document.fonts?.load(`700 30px ${BODY}`), document.fonts?.load(`500 26px ${BODY}`),
    ].filter(Boolean)).catch(() => {});
    const imgs = await Promise.all(items.map((it) => loadImage(it.art)));
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    // Stage: warm black, a record's grooves bleeding off the right edge, paper grain.
    ctx.fillStyle = INK;
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.translate(W + 120, 250);
    for (let r = 40; r < 560; r += 7) { ctx.strokeStyle = `rgba(242,232,213,${r % 21 === 0 ? 0.07 : 0.035})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke(); }
    ctx.fillStyle = ACCENT; ctx.beginPath(); ctx.arc(0, 0, 150, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    const n = document.createElement('canvas'); n.width = n.height = 160;
    const nc = n.getContext('2d'); const id = nc.createImageData(160, 160);
    for (let i = 0; i < id.data.length; i += 4) { const v = 180 + Math.random() * 75; id.data[i] = v; id.data[i + 1] = v * 0.95; id.data[i + 2] = v * 0.85; id.data[i + 3] = 14; }
    nc.putImageData(id, 0, 0);
    ctx.fillStyle = ctx.createPattern(n, 'repeat'); ctx.fillRect(0, 0, W, H);

    // Header.
    const M = 64;
    ctx.fillStyle = ACCENT;
    ctx.font = `800 22px ${BODY}`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '6px';
    ctx.fillText('ENCORE', M + 44, 92);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    ctx.fillStyle = '#0b0908'; ctx.beginPath(); ctx.arc(M + 14, 84, 16, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = ACCENT; ctx.beginPath(); ctx.arc(M + 14, 84, 6, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = CREAM;
    let hs = 96; // shrink the headline until it fits on one line
    do { ctx.font = `900 ${hs}px ${DISPLAY}`; hs -= 4; } while (hs > 44 && ctx.measureText(heading).width > W - M * 2);
    ctx.fillText(fit(ctx, heading, W - M * 2), M, 206);
    ctx.fillStyle = CREAM2;
    ctx.font = `500 30px ${BODY}`;
    ctx.fillText(fit(ctx, sub, W - M * 2), M, 258);

    // Rows.
    const rowH = 94;
    // Centre short lists in the space under the header.
    const top = 312 + Math.max(0, (10 - Math.min(10, items.length)) * rowH) / 2;
    items.slice(0, 10).forEach((it, i) => {
      const y = top + i * rowH;
      if (i > 0) { ctx.fillStyle = 'rgba(242,232,213,.1)'; ctx.fillRect(M, y - 6, W - M * 2, 1); }
      ctx.fillStyle = i < 3 ? ACCENT : CREAM3;
      ctx.font = `800 ${i === 0 ? 38 : 32}px ${DISPLAY}`;
      ctx.textAlign = 'center';
      ctx.fillText(String(i + 1), M + 18, y + 52);
      ctx.textAlign = 'left';
      // Cover.
      const cx = M + 58, cs = 74;
      ctx.save();
      rr(ctx, cx, y + 2, cs, cs, 3); ctx.clip();
      if (imgs[i]) ctx.drawImage(imgs[i], cx, y + 2, cs, cs);
      else {
        ctx.fillStyle = '#382a20'; ctx.fillRect(cx, y + 2, cs, cs);
      }
      ctx.restore();
      // Text.
      const tx = cx + cs + 26, tmax = W - M - 96 - tx;
      ctx.fillStyle = CREAM;
      ctx.font = `700 31px ${BODY}`;
      ctx.fillText(fit(ctx, it.title, tmax), tx, y + 34);
      ctx.fillStyle = CREAM2;
      ctx.font = `500 25px ${BODY}`;
      ctx.fillText(fit(ctx, it.artist, tmax), tx, y + 68);
      // Price-sticker score.
      const rx = W - M - 34, ry = y + 39;
      ctx.save(); ctx.translate(rx, ry); ctx.rotate(-0.14);
      ctx.fillStyle = it.score >= 9 ? ACCENT : CREAM; ctx.beginPath(); ctx.arc(0, 0, 32, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = INK; ctx.font = `850 24px ${DISPLAY}`; ctx.textAlign = 'center';
      ctx.fillText(it.score >= 9.995 ? '10' : it.score.toFixed(1), 0, 8);
      ctx.restore();
      ctx.textAlign = 'left';
    });

    ctx.fillStyle = CREAM3;
    ctx.font = `700 20px ${BODY}`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '4px';
    ctx.fillText('RATED HEAD TO HEAD ON ENCORE', M, H - 44);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';

    return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('export failed'))), 'image/png'));
  }

  /** Native share sheet with the image when possible, otherwise a download. */
  async function deliver(blob, filename) {
    const file = new File([blob], filename, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'My Top 10 on Encore' }); return 'shared'; }
      catch (err) { if (err && err.name === 'AbortError') return 'cancelled'; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return 'downloaded';
  }

  window.ShareCard = { render, deliver };
})();
