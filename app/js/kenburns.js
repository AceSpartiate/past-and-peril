/* kenburns.js — implements design/12-ken-burns-sequences.md on a canvas.
 *
 * Crops are normalized and WIDTH-DRIVEN: [x, y, w] where x,y are the crop
 * centre as fractions of image width/height and w is the crop width as a
 * fraction of image width. Height is DERIVED from the 16:9 frame and is never
 * authored, so an image can never be stretched.
 *
 * Tier drives framing, not the author's memory:
 *   tier 1/2 → full bleed
 *   tier 3   → matted, bordered, banner, and PUSH is refused
 * because Ken Burns motion confers documentary authority and a romantic
 * painting must not receive it.
 *
 * No image on disk → a MARKED placeholder naming the image, the tier, the move
 * and the provenance. That is the designed behaviour, not a failure state. */

const KenBurns = (function () {
  const PAPER = '#E9EBE4';
  const cache = {};

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }
  /* TRACK and DESCEND run LINEAR so they read as a camera on a dolly.
   * Easing a lateral pan makes it read as a zoom that went sideways. */
  function easeFor(move) {
    return (move === 'TRACK' || move === 'DESCEND') ? function (t) { return t; } : easeInOutCubic;
  }

  function load(src) {
    if (cache[src]) return cache[src];
    const p = new Promise(function (resolve) {
      const img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { resolve(null); };
      img.src = src;
    });
    cache[src] = p;
    return p;
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  function crosshatch(ctx, w, h) {
    ctx.fillStyle = '#CFC7B4';
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.strokeStyle = 'rgba(27,42,51,.055)';
    ctx.lineWidth = 1;
    for (let i = -h; i < w + h; i += 9) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + h, h); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(27,42,51,.04)';
    for (let i = -h; i < w + h; i += 9) {
      ctx.beginPath(); ctx.moveTo(i + h, 0); ctx.lineTo(i, h); ctx.stroke();
    }
    ctx.restore();
  }

  function drawPlaceholder(ctx, w, h, shot) {
    crosshatch(ctx, w, h);
    const pad = Math.round(w * 0.026);
    ctx.save();
    ctx.textBaseline = 'top';

    const boxTxt = 'PLACEHOLDER · TIER ' + (shot.tier || '?');
    ctx.font = '600 ' + Math.round(h * 0.019) + 'px "IBM Plex Mono", monospace';
    const tw = ctx.measureText(boxTxt).width;
    const bh = Math.round(h * 0.045);
    ctx.strokeStyle = '#B3A992';
    ctx.lineWidth = 1;
    ctx.strokeRect(pad, pad, tw + pad, bh);
    ctx.fillStyle = '#6E6552';
    ctx.fillText(boxTxt, pad + pad / 2, pad + bh / 2 - Math.round(h * 0.011));

    ctx.font = Math.round(h * 0.019) + 'px "IBM Plex Mono", monospace';
    const lines = [
      (shot.image || 'unnamed').toUpperCase(),
      'MOVE: ' + (shot.move || 'HOLD') + '   w ' + shot.from[2].toFixed(2) + ' → ' + shot.to[2].toFixed(2),
    ];
    let y = pad + bh + Math.round(h * 0.035);
    lines.forEach(function (l) {
      ctx.fillText(l, pad + pad / 2, y);
      y += Math.round(h * 0.032);
    });
    ctx.restore();
  }

  function drawCredit(ctx, w, h, shot) {
    if (!shot.provenance) return;
    ctx.save();
    ctx.font = Math.round(h * 0.0165) + 'px "IBM Plex Mono", monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    const pad = Math.round(w * 0.02);
    const txt = shot.provenance;
    const tw = ctx.measureText(txt).width;
    ctx.fillStyle = 'rgba(20,16,10,.44)';
    ctx.fillRect(w - pad - tw - 10, h - pad - Math.round(h * 0.032), tw + 20, Math.round(h * 0.032));
    ctx.fillStyle = '#E4E0D2';
    ctx.fillText(txt, w - pad, h - pad - Math.round(h * 0.006));
    ctx.restore();
  }

  function drawTier3Chrome(ctx, w, h, shot) {
    ctx.save();
    ctx.strokeStyle = '#A9B2A8';
    ctx.lineWidth = 2;
    const m = Math.round(w * 0.07);
    ctx.strokeRect(m, m, w - m * 2, h - m * 2);
    if (shot.label) {
      ctx.font = '600 ' + Math.round(h * 0.024) + 'px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#9E3729';
      ctx.fillText(shot.label.toUpperCase(), w / 2, Math.round(h * 0.028));
    }
    ctx.restore();
  }

  function Player(canvas) {
    const ctx = canvas.getContext('2d');
    let raf = null;
    let shots = [];
    let idx = -1;
    let anchor = 0;
    let elapsed = 0;
    let length = 0;
    let shotMs = 0;
    let img = null;
    let onShot = null;
    let running = false;
    let generation = 0;

    function size() {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(320, Math.round(r.width * dpr));
      canvas.height = Math.max(180, Math.round(r.height * dpr));
    }

    /* Smooth the quarter-second server updates locally, but always seek back
     * to its elapsed time on the next update. A pause holds this exact crop. */
    function position(now) {
      return Math.max(0, Math.min(length, elapsed + (running ? now - anchor : 0)));
    }

    function paint(now) {
      if (!shots.length) return;
      const at = position(now);
      const next = Math.min(shots.length - 1, Math.floor(at / shotMs));
      if (next !== idx) {
        idx = next;
        img = null;
        const version = ++generation;
        const selected = shots[idx];
        if (onShot) onShot(selected, idx);
        load('images/' + selected.image).then(function (loaded) {
          /* A slow image must not replace the next shot, or resurrect a
           * sequence that the teacher has already left. */
          if (version !== generation) return;
          img = loaded;
          paint(performance.now());
        });
      }
      const shot = shots[idx];
      const w = canvas.width, h = canvas.height;
      const raw = Math.min(1, (at - idx * shotMs) / shotMs);
      const t = easeFor(shot.move)(raw);

      ctx.fillStyle = PAPER;
      ctx.fillRect(0, 0, w, h);

      const tier3 = shot.tier === 3;
      const inset = tier3 ? Math.round(w * 0.07) : 0;
      const vw = w - inset * 2, vh = h - inset * 2;

      if (img) {
        const cx = lerp(shot.from[0], shot.to[0], t);
        const cy = lerp(shot.from[1], shot.to[1], t);
        const cw = lerp(shot.from[2], shot.to[2], t);

        let sw = cw * img.naturalWidth;
        let sh = sw * (vh / vw);
        if (sh > img.naturalHeight) { sh = img.naturalHeight; sw = sh * (vw / vh); }
        let sx = cx * img.naturalWidth - sw / 2;
        let sy = cy * img.naturalHeight - sh / 2;
        sx = Math.max(0, Math.min(img.naturalWidth - sw, sx));
        sy = Math.max(0, Math.min(img.naturalHeight - sh, sy));

        ctx.drawImage(img, sx, sy, sw, sh, inset, inset, vw, vh);
      } else {
        ctx.save();
        ctx.translate(inset, inset);
        drawPlaceholder(ctx, vw, vh, shot);
        ctx.restore();
      }

      if (tier3) drawTier3Chrome(ctx, w, h, shot);
      drawCredit(ctx, w, h, shot);

    }

    function frame(now) {
      raf = null;
      paint(now);
      schedule();
    }

    function schedule() {
      if (raf === null && running && shots.length && position(performance.now()) < length) {
        raf = requestAnimationFrame(frame);
      }
    }

    function cancel() {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
    }

    function sync(at, totalMs, isRunning) {
      cancel();
      length = Math.max(1, Number(totalMs) || 1);
      shotMs = length / Math.max(1, shots.length);
      elapsed = Math.max(0, Math.min(length, Number(at) || 0));
      anchor = performance.now();
      running = !!isRunning;
      paint(anchor);
      schedule();
    }

    return {
      /* totalMs is split across the shots — narration would set this per-shot
       * once real mp3s exist (design/12). */
      play: function (shotList, totalMs, cb, state) {
        this.stop();
        size();
        shots = (shotList || []).map(function (s) {
          const shot = Object.assign({ move: 'HOLD', tier: 1, from: [0.5, 0.5, 1], to: [0.5, 0.5, 1] }, s);
          // Tier 3 may only HOLD or PULL. Never push into a myth.
          if (shot.tier === 3 && shot.move === 'PUSH') shot.move = 'PULL';
          return shot;
        });
        if (!shots.length) return;
        onShot = cb || null;
        idx = -1;
        img = null;
        sync(state ? state.elapsed : 0, totalMs, state ? state.running : true);
      },
      sync: sync,
      pause: function () { sync(position(performance.now()), length, false); },
      stop: function () {
        running = false;
        cancel();
        generation += 1;
        shots = [];
        img = null;
      },
      resize: function () {
        size();
        if (shots.length) paint(performance.now());
        else { ctx.fillStyle = PAPER; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      },
      get shotMs() { return shotMs; },
    };
  }

  return { Player: Player };
})();
