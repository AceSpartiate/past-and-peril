/* stage.js — the projector. A pure view: it owns nothing, it renders state.
 *
 * design/09-screens-and-cloud.md: the Stage shows only story. No controls, no
 * chrome, nothing the room should not see. design/14-autopilot.md adds READ,
 * ROLL and RECORD so the Stage can carry the beats the teacher used to voice. */

(function () {
  const $ = function (id) { return document.getElementById(id); };
  const views = ['idle', 'read', 'beat', 'seq', 'list', 'tally', 'record'];
  const kb = KenBurns.Player($('kb'));

  let lastSegId = null;
  let lastBlock = -1;
  let lastRollKey = null;

  window.addEventListener('resize', function () { kb.resize(); });

  function show(name) {
    views.forEach(function (v) {
      const el = $('v-' + v);
      if (el) el.classList.toggle('on', v === name);
    });
    if (name !== 'seq') kb.stop();
  }

  function mmss(sec) {
    sec = Math.max(0, Math.ceil(sec));
    const m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  /* --- dice, drawn not typed. Pre-teens need to see the dice. */
  const PIPS = {
    1: [[.5, .5]],
    2: [[.28, .28], [.72, .72]],
    3: [[.26, .26], [.5, .5], [.74, .74]],
    4: [[.28, .28], [.72, .28], [.28, .72], [.72, .72]],
    5: [[.27, .27], [.73, .27], [.5, .5], [.27, .73], [.73, .73]],
    6: [[.28, .24], [.72, .24], [.28, .5], [.72, .5], [.28, .76], [.72, .76]],
  };
  function drawDie(svg, n) {
    const pips = (PIPS[n] || []).map(function (p) {
      return '<circle cx="' + (p[0] * 48).toFixed(1) + '" cy="' + (p[1] * 48).toFixed(1) +
        '" r="4.1" fill="#1B2A33"/>';
    }).join('');
    svg.innerHTML =
      '<rect x="1.4" y="1.4" width="45.2" height="45.2" rx="6.5" fill="#F2F3EE" stroke="#4A5B63" stroke-width="1.7"/>' + pips;
  }

  function renderBoard(s) {
    const ck = $('board-clocks');
    const ids = Object.keys(s.clocks);
    ck.innerHTML = ids.map(function (id) {
      const c = s.clocks[id];
      let segs = '';
      for (let i = 0; i < c.segments; i++) segs += '<i class="' + (i < c.filled ? 'on' : '') + '"></i>';
      return '<div class="clock-row"><span class="cl">' + c.label +
        '</span><span class="clock-segs">' + segs + '</span></div>';
    }).join('');

    const lg = $('board-ledger');
    lg.innerHTML = Object.keys(s.ledger).map(function (id) {
      const l = s.ledger[id];
      return '<div class="led"><div class="ll">' + l.label + '</div><div class="lv">' +
        l.value + ' <small>' + (l.unit || '') + '</small></div></div>';
    }).join('');
  }

  function render(s) {
    if (!s) return;

    if (s.meta) {
      $('fl-date').textContent = s.meta.datestamp || '';
      $('fl-right').textContent = 'SESSION ' + s.meta.session;
      $('idle-sub').textContent = s.meta.title || '';
    }
    renderBoard(s);
    $('paused').classList.toggle('on', s.started && !s.running);

    if (!s.started) {
      show('idle');
      $('idle-title').textContent = 'The Gonzales Company';
      $('idle-note').textContent = 'waiting for the room';
      lastSegId = null;
      return;
    }

    const seg = s.segment;
    if (!seg) { show('idle'); return; }
    const fresh = seg.id !== lastSegId;
    if (fresh) { lastSegId = seg.id; lastBlock = -1; }

    // Narration fires once per segment, and is suppressed when the teacher
    // has taken the read (design/10-voice-cast.md manual override).
    function sayOnce(voice) {
      if (!fresh) return;
      if (s.manualRead) { Narrator.stop(); return; }
      Narrator.say(voice);
    }

    switch (seg.kind) {

      case 'read': {
        show('read');
        $('read-eyebrow').textContent = seg.eyebrow || '';
        $('read-text').textContent = (seg.voice && seg.voice.text) || '';
        $('read-speaker').textContent = (seg.voice && seg.voice.speaker) || '';
        sayOnce(seg.voice);
        break;
      }

      case 'beat': {
        show('beat');
        $('beat-label').textContent = seg.label || '';
        const c = $('beat-count');
        c.textContent = mmss(s.remaining);
        c.classList.toggle('low', s.remaining <= 10);
        $('beat-instruction').textContent = seg.instruction || '';
        $('beat-bar').style.width = (s.length ? (100 * s.elapsed / s.length) : 0) + '%';

        const dice = $('beat-dice');
        if (seg.roll && s.lastRoll) {
          dice.hidden = false;
          const key = seg.id + ':' + s.lastRoll.a + ':' + s.lastRoll.b;
          if (key !== lastRollKey) {
            lastRollKey = key;
            drawDie($('die-a'), s.lastRoll.a);
            drawDie($('die-b'), s.lastRoll.b);
          }
        } else {
          dice.hidden = true;
        }
        if (fresh) Narrator.stop();
        break;
      }

      case 'sequence': {
        show('seq');
        if (fresh) {
          kb.resize();
          kb.play(seg.shots, s.length * 1000, function (shot) {
            $('seq-speaker').textContent = (shot.voice && shot.voice.speaker) || '';
            $('seq-caption').textContent = (shot.voice && shot.voice.text) || '';
            if (!s.manualRead) Narrator.say(shot.voice);
          });
        }
        break;
      }

      case 'checklist': {
        show('list');
        $('list-eyebrow').textContent = seg.eyebrow || '';
        $('list-title').textContent = seg.title || '';
        $('list-items').innerHTML = (seg.items || []).map(function (it, i) {
          return '<li><b>' + String(i + 1).padStart(2, '0') + '</b><span>' + it + '</span></li>';
        }).join('');
        sayOnce(seg.voice);
        break;
      }

      case 'tally': {
        show('tally');
        $('tally-q').textContent = seg.question || '';
        const counts = s.tally || {};
        const max = Math.max(1, ...Object.keys(counts).map(function (k) { return counts[k]; }));
        $('tally-rows').innerHTML = (seg.options || []).map(function (o) {
          const n = counts[o.key] || 0;
          return '<div class="tally-row"><span class="tk mono">' + o.key +
            '</span><span class="tl">' + o.label +
            '</span><span class="tbar"><i style="width:' + (100 * n / max) + '%"></i></span>' +
            '<span class="tn mono">' + n + '</span></div>';
        }).join('');
        if (fresh) Narrator.stop();
        break;
      }

      case 'record': {
        show('record');
        const blocks = seg.blocks || [];
        // Walk the blocks across the segment's duration, automatically.
        const per = s.length / Math.max(1, blocks.length);
        let bi = Math.min(blocks.length - 1, Math.floor(s.elapsed / per));
        const b = blocks[bi] || {};
        $('rec-head').textContent = b.head || '';
        $('rec-body').textContent = b.body || '';
        const showExit = bi === blocks.length - 1 && s.elapsed > s.length * 0.82;
        $('rec-exit').hidden = !showExit || !seg.exitLine;
        if (seg.exitLine) $('rec-exit').textContent = '“' + seg.exitLine + '”';
        if (bi !== lastBlock) {
          lastBlock = bi;
          if (!s.manualRead) {
            Narrator.say({ speaker: (b.voice && b.voice.speaker) || 'HISTORIAN', text: b.body || '' });
          }
        }
        break;
      }

      default: {
        // Unknown segment kind → the title card. Never a blank projector.
        show('idle');
        $('idle-title').textContent = seg.title || 'Gonzales';
        $('idle-note').textContent = seg.eyebrow || '';
      }
    }
  }

  /* The Stage is a pure subscriber now. It opens its own stream to the server
   * and renders whatever the room says, so it can be opened on any display, in
   * any window, before or after the console, with nothing to pair. */
  let heard = false;
  Net.on('state', function (s) { heard = true; render(s); });
  Net.on('online', function (up) {
    if (!up) $('idle-note').textContent = 'reconnecting…';
  });

  Net.probe().then(function (hello) {
    if (!hello) {
      $('idle-note').textContent = 'no classroom server — run: node server/serve.js';
      return;
    }
    Net.connect({ role: 'view' });
  });

  setTimeout(function () {
    if (!heard) $('idle-note').textContent = 'waiting for the room';
  }, 3200);
})();
