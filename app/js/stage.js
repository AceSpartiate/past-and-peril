/* stage.js — the projector. A pure view: it owns nothing, it renders state.
 *
 * design/09-screens-and-cloud.md: the Stage shows only story. No controls, no
 * chrome, nothing the room should not see. design/14-autopilot.md adds READ,
 * ROLL and RECORD so the Stage can carry the beats the teacher used to voice. */

(function () {
  const $ = function (id) { return document.getElementById(id); };
  const views = ['idle', 'read', 'beat', 'boss', 'seq', 'list', 'tally', 'record'];
  const kb = KenBurns.Player($('kb'));

  let lastSegKey = null;
  let lastBlock = -1;
  let lastRollKey = null;
  let lastRailKey = null;
  let lastElapsed = 0;
  let latestState = null;
  let connected = true;
  let activeVoice = null;
  let voiceStarted = false;

  function syncNarration() {
    if (!latestState || !latestState.started || latestState.manualRead) {
      Narrator.stop();
      voiceStarted = false;
    } else if (!connected || !latestState.running) {
      Narrator.pause();
    } else if (activeVoice && !voiceStarted) {
      Narrator.say(activeVoice);
      voiceStarted = true;
    } else {
      Narrator.resume();
    }
  }

  function setVoice(voice) {
    Narrator.stop();
    activeVoice = voice || null;
    voiceStarted = false;
    syncNarration();
  }

  window.addEventListener('resize', function () { kb.resize(); });

  function show(name) {
    const ob = $('list-orders');
    if (ob && name !== 'list') ob.hidden = true;
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

  /* ============================================ WHAT TO DO, ALWAYS
   *
   * Never returns nothing. Every branch answers the only question that matters
   * from the back row — what am I supposed to be doing right now — in an
   * imperative a twelve-year-old can act on without asking a neighbour.
   *
   * The authored `instruction` on a segment is deliberately NOT used here. It
   * is the teacher's flavour line ("One unarmed man, doing something perfectly
   * legal. Watch.") and it already has a home in the beat view. Flavour and
   * instruction are different jobs, and conflating them is how fourteen
   * segments ended up saying nothing at all.
   *
   * The counts during a turn are the most useful line in the room: a student
   * who has not gone can see they are the holdup, and one who has can see the
   * class is still working. */
  function whatToDo(s) {
    if (!s || !s.started) {
      return { now: 'Open the link on your device.', sub: whereLine || '' };
    }
    if (!s.running) return { now: 'Hold. Eyes up front.', sub: '' };

    const seg = s.segment || {};
    const rs = s.room_status || {};

    if (s.turnOpen) {
      const n = rs.connected || 0;
      const gone = rs.acted || 0;
      /* In the fight the useful instruction is not "choose" — it is where
       * to stand. Five hexes at the battery, and cover is one step out. */
      if (seg.boss) {
        return {
          now: 'Get to the plaza, or get behind something.',
          sub: n ? gone + ' of ' + n + ' have gone' : '',
        };
      }
      return {
        now: 'Move, then choose what you do.',
        sub: n ? gone + ' of ' + n + ' have gone' : '',
      };
    }

    switch (seg.kind) {
      case 'sequence':
        return { now: 'Watch. You are standing in the town.', sub: '' };
      case 'read':
        return { now: 'Listen. Your screen is locked.', sub: '' };
      case 'tally':
        return { now: 'Hands up when your company is called.', sub: '' };
      case 'checklist':
        return { now: 'Follow along.', sub: '' };
      case 'record':
        return { now: 'Read the board.', sub: '' };
      default:
        return { now: 'Eyes up front.', sub: '' };
    }
  }

  /* The address, for the one moment it is the instruction. */
  let whereLine = '';
  fetch('api/where', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (w) {
      if (!w || !w.ok) return;
      const best = (w.confirmed && w.confirmed[0]) || w.student[0] || '';
      whereLine = best.replace(/^https?:\/\//, '');
    })
    .catch(function () {});

  /* ============================================================ THE BOSS
   *
   * A beat carrying seg.boss draws this instead of the plain beat view. A
   * beat WITHOUT it falls through untouched, so a Stage on older content
   * never reaches any of this and nothing has to be versioned.
   *
   * decision 8, in the teacher's words: "say it, and name the event." The
   * name of the mechanic and the real date, together, at the top.
   */
  function renderBoss(s, seg, fresh) {
    const b = seg.boss || {};
    show('boss');
    $('boss-name').textContent = b.name || seg.label || '';
    $('boss-date').textContent = b.date || '';

    /* Both bars at roughly three times the board's size. The one filling
     * against the room is inked differently from the one they are filling. */
    const want = b.bars || Object.keys(s.clocks);
    $('boss-bars').innerHTML = want.map(function (id) {
      const c = s.clocks[id];
      if (!c) return '';
      let segs = '';
      for (let i = 0; i < c.segments; i++) segs += '<i class="' + (i < c.filled ? 'on' : '') + '"></i>';
      const against = id === 'TOLL' ? ' against' : '';
      return '<div class="boss-bar' + against + '"><div class="bl">' + c.label +
             '</div><div class="boss-segs">' + segs + '</div></div>';
    }).join('');

    let pips = '';
    for (let i = 1; i <= (b.phases || 0); i++) pips += '<i class="' + (i <= (b.phase || 0) ? 'on' : '') + '"></i>';
    $('boss-phase').innerHTML = (seg.label || '') + pips;

    const c = $('boss-count');
    c.textContent = mmss(s.remaining);
    c.classList.toggle('low', s.remaining <= 10);
    $('boss-instruction').textContent = seg.instruction || '';

    /* THE BROADCAST RAIL. spotlight() has computed a fair, per-student
     * guaranteed kill-feed since the beginning and sent it to a client that
     * threw it away — `broadcast` appeared zero times in app/js. This is the
     * first time any of it reaches a wall. */
    const rail = $('boss-rail');
    const feed = (s.broadcasts || []).slice(0, 3);
    const key = feed.map(function (x) { return x.t; }).join(',');
    if (key !== lastRailKey) {
      lastRailKey = key;
      rail.innerHTML = feed.map(function (x) {
        const d = document.createElement('div');
        d.textContent = x.text;
        return d.outerHTML;
      }).join('');
    }
    if (fresh) Narrator.stop();
  }

  function paintNow(s) {
    const w = whatToDo(s);
    $('now-do').textContent = w.now;
    $('now-sub').textContent = w.sub || '';
  }

  function render(s) {
    if (!s) return;
    latestState = s;

    /* FIRST, and outside every conditional. The band's whole promise is that
     * it is never blank, and painting it inside `if (s.meta)` would have
     * broken exactly that on the states where a student is most likely to be
     * lost — before the room has started and has no meta yet. */
    paintNow(s);

    if (s.meta) {
      $('fl-date').textContent = s.meta.datestamp || '';
      $('fl-right').textContent = 'SESSION ' + s.meta.session;
      /* A rehearsal must be legible from the back of the room. The console
       * saying so is not enough - the projector is the screen a person who
       * walks in is looking at, and it is the one that gets photographed. */
      $('fl-test').hidden = !s.testMode;
      $('idle-sub').textContent = s.meta.title || '';
    }
    renderBoard(s);
    $('paused').classList.toggle('on', s.started && !s.running);

    if (!s.started) {
      show('idle');
      $('idle-title').textContent = 'Past & Peril';
      $('idle-note').textContent = 'waiting for the room';
      lastSegKey = null;
      lastElapsed = 0;
      setVoice(null);
      return;
    }

    const seg = s.segment;
    if (!seg) { show('idle'); setVoice(null); return; }
    /* A replay is a new occurrence of the same authored segment. Pause and
     * resume keep its revision; a new projector seeks straight to elapsed. */
    const key = [s.sessionIndex || 0, seg.id, s.segmentRevision || 0].join(':');
    const elapsed = Number(s.elapsed) || 0;
    const fresh = key !== lastSegKey ||
      (s.segmentRevision === undefined && elapsed < lastElapsed);
    lastElapsed = elapsed;
    if (fresh) {
      lastSegKey = key;
      lastBlock = -1;
      setVoice(null);
    }

    // Narration fires once per segment, and is suppressed when the teacher
    // has taken the read (design/10-voice-cast.md manual override).
    function sayOnce(voice) {
      if (fresh) setVoice(voice);
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
        /* A boss beat draws the boss. Anything else is the beat it always was. */
        if (seg.boss) { renderBoss(s, seg, fresh); break; }
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
            setVoice(shot.voice);
          }, { elapsed: elapsed * 1000, running: s.running });
        } else {
          kb.sync(elapsed * 1000, s.length * 1000, s.running);
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
        /* THE DAY'S WORK, under the checklist. Three orders for the whole
         * period — about twenty-six words of instruction. A student who
         * reads none of it still has a ring on their map and a chore at the
         * top of their list; this is for the ones who do read, and for the
         * teacher saying them out loud. */
        const ob = $('list-orders');
        if (ob) {
          const orders = seg.orders || [];
          ob.hidden = !orders.length;
          $('orders-title').textContent = seg.ordersTitle || '';
          $('orders-items').innerHTML = orders.map(function (o) {
            return '<li>' + o + '</li>';
          }).join('');
        }
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
          setVoice({ speaker: (b.voice && b.voice.speaker) || 'HISTORIAN', text: b.body || '' });
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
    syncNarration();
  }

  /* The Stage is a pure subscriber now. It opens its own stream to the server
   * and renders whatever the room says, so it can be opened on any display, in
   * any window, before or after the console, with nothing to pair. */
  let heard = false;
  Net.on('state', function (s) { heard = true; connected = true; render(s); });
  Net.on('online', function (up) {
    if (!up) {
      connected = false;
      $('idle-note').textContent = 'reconnecting…';
      kb.pause();
      syncNarration();
    }
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
