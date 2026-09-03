// <bee-video src="…webm" size="136" zoom="440" track> — alpha WebM with green despill
// and optional auto-tracking so a bee that flies around the frame stays centred and large.
if (!customElements.get('bee-video')) {
class BeeVideo extends HTMLElement {
  connectedCallback() {
    if (this._init) return;
    this._init = true;

    const size = parseInt(this.getAttribute('size') || '136', 10);
    const win = parseInt(this.getAttribute('zoom') || '440', 10); // source-px crop window
    const track = this.hasAttribute('track');
    const despill = !this.hasAttribute('no-despill');

    this.style.display = 'block';
    this.style.width = size + 'px';
    this.style.height = size + 'px';

    const canvas = document.createElement('canvas');
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    this.appendChild(canvas);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';

    const v = document.createElement('video');
    v.src = this.getAttribute('src');
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.autoplay = true;
    v.crossOrigin = 'anonymous';
    v.style.display = 'none';
    this.appendChild(v);

    // scratch buffers
    const work = document.createElement('canvas');
    const wctx = work.getContext('2d', { willReadFrequently: true });
    const probe = document.createElement('canvas');
    probe.width = 160; probe.height = 90;
    const pctx = probe.getContext('2d', { willReadFrequently: true });

    let cx = null, cy = null;      // smoothed bee centre in source px
    let started = false;

    const centre = (W, H) => {
      pctx.clearRect(0, 0, 160, 90);
      pctx.drawImage(v, 0, 0, 160, 90);
      const d = pctx.getImageData(0, 0, 160, 90).data;
      let sx = 0, sy = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 40) continue;
        const g = d[i + 1];
        if (g > d[i] * 1.2 && g > d[i + 2] * 1.2) continue; // ignore green fringe
        const p = i / 4, px = p % 160;
        sx += px; sy += (p - px) / 160; n++;
      }
      if (!n) return null;
      return [(sx / n) * (W / 160), (sy / n) * (H / 90)];
    };

    const draw = () => {
      const W = v.videoWidth, H = v.videoHeight;
      if (W && H && v.readyState >= 2) {
        if (work.width !== W) { work.width = W; work.height = H; }
        wctx.clearRect(0, 0, W, H);
        wctx.drawImage(v, 0, 0);

        let sx = 0, sy = 0, sw = W, sh = H;
        if (track) {
          const c = centre(W, H);
          if (c) {
            cx = cx === null ? c[0] : cx + (c[0] - cx) * 0.14;
            cy = cy === null ? c[1] : cy + (c[1] - cy) * 0.14;
          }
          if (cx !== null) {
            sw = sh = Math.min(win, H);
            sx = Math.max(0, Math.min(W - sw, cx - sw / 2));
            sy = Math.max(0, Math.min(H - sh, cy - sh / 2));
          }
        }

        if (despill) {
          const img = wctx.getImageData(sx | 0, sy | 0, sw | 0, sh | 0);
          const d = img.data;
          for (let i = 0; i < d.length; i += 4) {
            const a = d[i + 3];
            if (!a) continue;
            const r = d[i], g = d[i + 1], b = d[i + 2];
            const lim = Math.max(r, b);
            if (g > lim) {
              const spill = g - lim;
              d[i + 1] = lim;
              // PM-424：0.18 → 0.28。去綠之後把更多能量回補到紅通道，
              //   蜂身的黃才會偏暖而不是被去成灰。
              d[i] = Math.min(255, r + spill * 0.28);
              d[i + 2] = Math.min(255, b + spill * 0.10);
              if (spill > 18) d[i + 3] = Math.max(0, a - (spill - 18) * 4.2);
            }
          }
          const tmp = document.createElement('canvas');
          tmp.width = img.width; tmp.height = img.height;
          tmp.getContext('2d').putImageData(img, 0, 0);
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
        } else {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(work, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        }
        if (!started) { started = true; this.dispatchEvent(new CustomEvent('bee-ready')); }
      }
      this._raf = requestAnimationFrame(draw);
    };

    v.addEventListener('loadeddata', () => v.play().catch(() => {}));
    draw();
  }
  disconnectedCallback() { cancelAnimationFrame(this._raf); }
}
customElements.define('bee-video', BeeVideo);
}
