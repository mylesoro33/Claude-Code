/*
 * Shareable "My Top 10" card, drawn on a 1080×1350 canvas (a 4:5 portrait
 * post). Covers come through the same-origin art proxy when available so the
 * canvas can be exported.
 */
(function () {
  const W = 1080, H = 1350;
  const DISPLAY = '"Unbounded", "Arial Black", system-ui, sans-serif';
  const BODY = '"Manrope", system-ui, -apple-system, sans-serif';

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
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  /**
   * items: [{ title, artist, score, rgb:[r,g,b], art:url }]
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
    const c0 = items[0]?.rgb || [255, 79, 123];
    const c1 = items[1]?.rgb || c0;

    // Stage: near-black with two colored glows taken from the top covers.
    ctx.fillStyle = '#07070b';
    ctx.fillRect(0, 0, W, H);
    let g = ctx.createRadialGradient(140, 120, 0, 140, 120, 900);
    g.addColorStop(0, rgba(c0, 0.55)); g.addColorStop(1, rgba(c0, 0));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    g = ctx.createRadialGradient(W - 80, H - 60, 0, W - 80, H - 60, 820);
    g.addColorStop(0, rgba(c1, 0.35)); g.addColorStop(1, rgba(c1, 0));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // Film grain.
    const n = document.createElement('canvas'); n.width = n.height = 160;
    const nc = n.getContext('2d'); const id = nc.createImageData(160, 160);
    for (let i = 0; i < id.data.length; i += 4) { const v = Math.random() * 255; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 18; }
    nc.putImageData(id, 0, 0);
    ctx.fillStyle = ctx.createPattern(n, 'repeat'); ctx.fillRect(0, 0, W, H);

    // Header.
    const M = 64;
    ctx.fillStyle = 'rgba(255,255,255,.62)';
    ctx.font = `700 22px ${BODY}`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '6px';
    ctx.fillText('ENCORE', M + 44, 92);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    ctx.lineWidth = 6; ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.beginPath(); ctx.arc(M + 14, 84, 14, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = rgba(c0, 1); ctx.beginPath(); ctx.arc(M + 14, 84, 14, -Math.PI / 2, Math.PI * 1.1); ctx.stroke();

    ctx.fillStyle = '#f6f3ff';
    ctx.font = `700 84px ${DISPLAY}`;
    ctx.fillText(fit(ctx, heading, W - M * 2), M, 206);
    ctx.fillStyle = 'rgba(255,255,255,.6)';
    ctx.font = `500 30px ${BODY}`;
    ctx.fillText(fit(ctx, sub, W - M * 2), M, 258);

    // Rows.
    const top = 312, rowH = 94;
    items.slice(0, 10).forEach((it, i) => {
      const y = top + i * rowH;
      const rgb = it.rgb || c0;
      if (i === 0) {
        ctx.fillStyle = 'rgba(255,255,255,.07)';
        rr(ctx, M - 20, y - 8, W - (M - 20) * 2, rowH - 4, 26); ctx.fill();
        ctx.strokeStyle = rgba(rgb, 0.45); ctx.lineWidth = 2; ctx.stroke();
      }
      ctx.fillStyle = i === 0 ? rgba(rgb, 1) : 'rgba(255,255,255,.45)';
      ctx.font = `700 ${i === 0 ? 36 : 30}px ${DISPLAY}`;
      ctx.textAlign = 'center';
      ctx.fillText(String(i + 1), M + 18, y + 52);
      ctx.textAlign = 'left';
      // Cover.
      const cx = M + 58, cs = 74;
      ctx.save();
      rr(ctx, cx, y + 2, cs, cs, 14); ctx.clip();
      if (imgs[i]) ctx.drawImage(imgs[i], cx, y + 2, cs, cs);
      else {
        const gg = ctx.createLinearGradient(cx, y, cx + cs, y + cs);
        gg.addColorStop(0, rgba(rgb, 1)); gg.addColorStop(1, rgba(rgb.map((v) => v * 0.45), 1));
        ctx.fillStyle = gg; ctx.fillRect(cx, y + 2, cs, cs);
      }
      ctx.restore();
      // Text.
      const tx = cx + cs + 26, tmax = W - M - 96 - tx;
      ctx.fillStyle = '#f6f3ff';
      ctx.font = `700 31px ${BODY}`;
      ctx.fillText(fit(ctx, it.title, tmax), tx, y + 34);
      ctx.fillStyle = 'rgba(255,255,255,.58)';
      ctx.font = `500 25px ${BODY}`;
      ctx.fillText(fit(ctx, it.artist, tmax), tx, y + 68);
      // Score ring.
      const rx = W - M - 34, ry = y + 39, r = 31;
      ctx.lineWidth = 7;
      ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.beginPath(); ctx.arc(rx, ry, r, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = rgba(rgb, 1); ctx.beginPath(); ctx.arc(rx, ry, r, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * it.score) / 10); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = `700 21px ${DISPLAY}`; ctx.textAlign = 'center';
      ctx.fillText(it.score.toFixed(1), rx, ry + 8);
      ctx.textAlign = 'left';
    });

    ctx.fillStyle = 'rgba(255,255,255,.42)';
    ctx.font = `600 22px ${BODY}`;
    ctx.fillText('Ranked head-to-head on Encore', M, H - 44);

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
