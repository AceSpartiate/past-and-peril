/* coach.js — point at a thing on screen and say what it is for.
 *
 *     Coach.point('portal', { text: 'This appears when you are standing in a
 *                             doorway. It takes you inside.' });
 *     Coach.clear();
 *
 * WHY THIS EXISTS
 *
 * The tutorial used to say "Press the green button to go in" and "Open MAP KEY"
 * while pointing at nothing. A twelve-year-old reading that has to find the
 * green button first, and a sentence naming a colour is a poor substitute for
 * an arrow. A teacher testing it asked for pop-ups that point at things and
 * say what they are used for, which is exactly right.
 *
 * HOW IT DIMS
 *
 * Not with an SVG mask or mix-blend-mode: four plain rectangles above, below,
 * left and right of the target's box. That leaves a real hole with no
 * compositing, works identically in every browser a Chromebook might have, and
 * costs nothing to reposition.
 *
 * WHY IT NEVER SWALLOWS A TAP
 *
 * The whole overlay is pointer-events: none, including the bubble. A coach mark
 * that told a child to press a button and then ate the press would be the worst
 * possible outcome, and it is the classic way these go wrong. Nothing here can
 * receive an event, so the thing being pointed at stays pressable.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not point at a hex. The map already rings its own target hex with GO
 * HERE, drawn inside the canvas where it can follow the terrain. Two competing
 * pointers on one screen is worse than either alone. */

(function () {
  'use strict';

  const NS = 'coach';
  let host = null;          // the overlay root
  let cur = null;           // { el, opts }
  let raf = 0;

  function build() {
    if (host) return host;
    host = document.createElement('div');
    host.className = NS;
    host.setAttribute('aria-hidden', 'true');   // the text is spoken elsewhere
    host.innerHTML =
      '<div class="' + NS + '-dim ' + NS + '-t"></div>' +
      '<div class="' + NS + '-dim ' + NS + '-b"></div>' +
      '<div class="' + NS + '-dim ' + NS + '-l"></div>' +
      '<div class="' + NS + '-dim ' + NS + '-r"></div>' +
      '<div class="' + NS + '-ring"></div>' +
      '<div class="' + NS + '-bub"><div class="' + NS + '-caret"></div>' +
        '<div class="' + NS + '-title mono"></div>' +
        '<div class="' + NS + '-text"></div></div>';
    document.body.appendChild(host);
    return host;
  }

  function resolve(target) {
    if (!target) return null;
    if (typeof target === 'string') return document.getElementById(target);
    if (target.nodeType === 1) return target;
    return null;
  }

  /* Is it actually on screen? A hidden element has a zero box, and anchoring to
   * a zero box puts the bubble in the top-left corner pointing at nothing —
   * which is how a coach mark turns into a bug report. */
  function boxOf(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    if (el.hidden) return null;
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return null;
    return r;
  }

  function place() {
    if (!cur) return;
    const el = cur.el;
    const box = boxOf(el);
    if (!box) { hide(); return; }

    const pad = cur.opts.pad === undefined ? 6 : cur.opts.pad;
    const x = box.left - pad, y = box.top - pad;
    const w = box.width + pad * 2, h = box.height + pad * 2;
    const W = window.innerWidth, H = window.innerHeight;

    host.classList.add('on');
    const set = (sel, s) => {
      const n = host.querySelector('.' + NS + '-' + sel);
      Object.keys(s).forEach((k) => { n.style[k] = s[k]; });
    };
    /* four rectangles, leaving the target's box uncovered */
    set('t', { left: '0px', top: '0px', width: W + 'px', height: Math.max(0, y) + 'px' });
    set('b', { left: '0px', top: (y + h) + 'px', width: W + 'px', height: Math.max(0, H - y - h) + 'px' });
    set('l', { left: '0px', top: y + 'px', width: Math.max(0, x) + 'px', height: h + 'px' });
    set('r', { left: (x + w) + 'px', top: y + 'px', width: Math.max(0, W - x - w) + 'px', height: h + 'px' });
    set('ring', { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });

    /* the bubble: below if there is room, otherwise above */
    const bub = host.querySelector('.' + NS + '-bub');
    const caret = host.querySelector('.' + NS + '-caret');
    bub.style.left = '0px'; bub.style.top = '0px';        // measure unclamped
    const bw = Math.min(300, W - 24);
    bub.style.width = bw + 'px';
    const bh = bub.offsetHeight;

    const gap = 12;
    const below = y + h + gap + bh <= H - 8;
    const top = below ? (y + h + gap) : Math.max(8, y - gap - bh);
    let left = box.left + box.width / 2 - bw / 2;
    left = Math.max(12, Math.min(W - bw - 12, left));

    bub.style.left = left + 'px';
    bub.style.top = top + 'px';
    bub.classList.toggle('above', !below);

    /* the caret sits under the target's centre, clamped inside the bubble so it
     * never hangs off a corner */
    const cx = Math.max(16, Math.min(bw - 16, box.left + box.width / 2 - left));
    caret.style.left = cx + 'px';
  }

  function hide() {
    if (host) host.classList.remove('on');
  }

  function follow() {
    cancelAnimationFrame(raf);
    /* Cheap and reliable: re-place every frame while a mark is up. The boxes
     * move when the turn bar appears, when an action card list grows, and when
     * a Chromebook is rotated — watching for all of that is more code and more
     * ways to be wrong than simply keeping up. */
    (function loop() {
      if (!cur) return;
      place();
      raf = requestAnimationFrame(loop);
    })();
  }

  const Coach = {
    /* target: an element id, or an element. opts: { title, text, pad } */
    point: function (target, opts) {
      const el = resolve(target);
      if (!el) { Coach.clear(); return false; }
      build();
      cur = { el: el, opts: opts || {} };
      host.querySelector('.' + NS + '-title').textContent = (opts && opts.title) || '';
      host.querySelector('.' + NS + '-title').hidden = !(opts && opts.title);
      host.querySelector('.' + NS + '-text').textContent = (opts && opts.text) || '';
      place();
      follow();
      return true;
    },
    clear: function () {
      cur = null;
      cancelAnimationFrame(raf);
      hide();
    },
    get active() { return !!cur; },
  };

  window.addEventListener('resize', function () { if (cur) place(); });
  window.Coach = Coach;
}());
