/* console.js — the teacher's desk.
 *
 * design/14-autopilot.md's governing rule: every control here is an OVERRIDE,
 * never a requirement. Once "Open the room" is pressed the period runs to the
 * bell without another touch. Everything below exists for when the teacher
 * WANTS in, not for when the software needs them. */

(function () {
  const $ = function (id) { return document.getElementById(id); };
  let SESSION = null;
  let wasIdle = null;      // so the setup panel folds on the TRANSITION only
  let ssArmed = null;      // a session index awaiting a confirming second press
  let LAST = null;      // newest state from the server

  function mmss(sec) {
    const neg = sec < 0;
    sec = Math.abs(Math.ceil(sec));
    const m = Math.floor(sec / 60), s = sec % 60;
    return (neg ? '-' : '') + m + ':' + String(s).padStart(2, '0');
  }

  /* ---------------------------------------------------------------- preflight
   * Honest about what this machine can actually do, before the bell. */
  function preflight() {
    const items = [];
    const v = Narrator.describe();
    const voiceOk = v.indexOf('no speech') !== 0;
    items.push([voiceOk ? '✓' : '⚠', 'Narration', v]);
    if (LAST && LAST.resumedFromDisk) {
      items.push(['⚠', 'This period was interrupted',
        'Picked up at beat ' + (LAST.index + 1) + ' of ' + LAST.count +
        ' — everything is where it was. Press Resume when the room is ready.']);
    }
    if (LAST && LAST.priorSessions) {
      items.push(['✓', 'Campaign in progress',
        LAST.priorSessions + (LAST.priorSessions === 1 ? ' session' : ' sessions') +
        ' already played by this class. What they earned came with them.']);
    }
    items.push([Net.isTeacher ? '✓' : '⚠', 'Teacher controls',
      Net.isTeacher ? 'This screen can run the lesson. Keep the address to yourself.'
                    : 'This screen can watch but not touch. Open the longer address from the black window that started the server.']);
    items.push(['✓', 'How students get in',
      'Class ' + Net.room + ' — they tap a name. Nothing to type, nothing to install.']);
    items.push(['✓', 'The timers watch the room',
      'A turn window gives itself another 30 seconds when fewer than 70% of the ' +
      'class have got going — up to a minute and a half, never past the bell. ' +
      'E still adds thirty seconds by hand.']);

    const total = SESSION.timeline.reduce(function (a, s) { return a + s.seconds; }, 0);
    const allowed = (SESSION.periodMinutes - SESSION.bellSlackMin) * 60;
    items.push([total <= allowed ? '✓' : '⚠', 'Today fits the bell',
      mmss(total) + ' of lesson in a ' + mmss(allowed) + ' period · ' +
      (total <= allowed ? mmss(allowed - total) + ' to spare' : mmss(total - allowed) + ' TOO LONG')]);

    items.push(['○', 'Pictures', 'None yet. The picture sequences will show labelled placeholders instead.']);

    $('preflight').innerHTML = items.map(function (i) {
      const col = i[0] === '✓' ? 'var(--d-teal)' : (i[0] === '⚠' ? 'var(--wheat)' : 'var(--d-faint)');
      return '<div><b style="color:' + col + '">' + i[0] + '</b><span><strong>' + i[1] +
        '</strong> — ' + i[2] + '</span></div>';
    }).join('');
  }

  /* ---------------------------------------------------------------- the stage
   *
   * The Stage opens its own stream to the server, so there is nothing to pair
   * and nothing to message. All this has to do is manage the on-this-screen
   * overlay for a teacher with one display. */
  function stageUrl() { return 'stage.html?room=' + encodeURIComponent(Net.room); }

  const Overlay = {
    open: function () {
      let h = $('stage-inline');
      if (!h) { h = document.createElement('div'); h.id = 'stage-inline'; document.body.appendChild(h); }
      if (!h.querySelector('iframe')) {
        const f = document.createElement('iframe');
        f.src = stageUrl();
        f.title = 'The Stage';
        h.appendChild(f);
      }
      h.hidden = false;
    },
    toggle: function () {
      const h = $('stage-inline');
      if (!h || !h.querySelector('iframe')) return this.open();
      h.hidden = !h.hidden;
    },
    get on() {
      const h = $('stage-inline');
      return !!(h && h.querySelector('iframe') && !h.hidden);
    },
  };

  /* ---------------------------------------------------------------- the room
   *
   * design/09: THE ROOM tells you who has acted and who has been idle, so you
   * find out at ninety seconds instead of at the bell. The server computes it,
   * so the console never has to count anything or trust a client's word. */
  function renderRoom(s) {
    const rs = s.room_status || { connected: 0, acted: 0, idle: [] };
    const list = s.students || [];
    /* The teacher did not do this and is not being asked to. They are being
     * told, because they will want to know which of these students has been
     * away and might need a word. */
    const cu = s.caughtUp || [];
    const cuLine = $('caught-up');
    if (cuLine) {
      cuLine.hidden = !cu.length;
      cuLine.textContent = cu.length
        ? 'CAUGHT UP AUTOMATICALLY · ' + cu.map(function (x) {
            return x.name + ' (' + (x.sessions ? x.sessions + ' session' + (x.sessions === 1 ? '' : 's') : 'today') +
                   ', ' + x.facts + ' fact' + (x.facts === 1 ? '' : 's') + ' granted)';
          }).join(' · ')
        : '';
    }
    const inside = list.filter(function (x) { return !!x.anchor; }).length;
    $('room-count').textContent = rs.connected + ' connected · ' + rs.acted + ' acted' +
      (inside ? ' · ' + inside + ' indoors' : '');
    $('room-count').style.color = rs.connected === 0 ? 'var(--d-faint)'
      : (rs.acted < rs.connected ? 'var(--wheat)' : 'var(--d-teal)');

    if (!list.length) {
      $('room').innerHTML = '<div class="note">Nobody has joined yet. Students open ' +
        '<strong>/play.html</strong> and tap their name.</div>';
      return;
    }
    $('room').innerHTML = list.slice().sort(function (a, b) {
      /* the ones who have NOT gone yet float to the top, because they are the
       * ones the teacher might want to walk over to */
      return (!!a.acted === !!b.acted) ? a.name.localeCompare(b.name) : (a.acted ? 1 : -1);
    }).map(function (st) {
      return '<div class="kv" style="height:26px">' +
        '<span style="width:6px;height:6px;border-radius:50%;flex-shrink:0;background:' +
          (st.acted ? 'var(--d-teal)' : '#5B6A70') + '"></span>' +
        '<span class="k" style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' +
          st.name + '</span>' +
        '<span class="mono" style="font-size:10px;color:var(--d-faint);flex-shrink:0">' + (st.hex || '') + '</span>' +
        (st.anchor
          ? '<span class="mono" style="font-size:9px;letter-spacing:.06em;color:var(--wheat);flex-shrink:0" ' +
            'title="Their screen is showing the inside of a building, not the town">INSIDE</span>'
          : '') +
        '<span class="mono" style="font-size:9.5px;letter-spacing:.08em;color:var(--d-oxide);width:44px;text-align:right;flex-shrink:0">' +
          (st.verb || '') + '</span></div>';
    }).join('');
  }

  /* ------------------------------------------------------------- coverage
   *
   * design/09 calls this the most important thing on the teacher's screen: a
   * red cell is a student about to miss required content, visible while there
   * is still time to fix it. On autopilot the engine's fallback sweep fixes it
   * without being asked — this panel is how you SEE that happening, and how you
   * know which facts the room as a whole is thin on. */
  /* THE ASKED COLUMN.
   *
   * Constraint F: proving the JSON names all thirty ids proves the JSON, not
   * the delivery. An invitation that fires on a day a student is away leaves
   * the build green and the student unasked, so this is the RUNTIME record —
   * what was actually offered, to whom.
   *
   * Sorted by who is most overdue, so the top of this list is the answer to
   * the only question the teacher has. There is no button beside a name.
   */
  /* REHEARSAL. A period played by nobody must never be mistaken for one a
   * class actually sat through — it writes to the same save file. */
  function renderTestMode(s) {
    const b = $('b-test');
    if (b) b.textContent = s.testMode ? 'Test mode: STOP and clear the bots'
                                      : 'Test mode: play it with nobody';
    const note = $('test-note');
    if (note && s.testMode) note.textContent = 'REHEARSAL — nobody in this room is real.';
  }

  function renderAsked(s) {
    const box = $('ask-box');
    if (!box) return;
    const rec = s.asked;
    if (!rec) { box.hidden = true; return; }
    const rows = Object.keys(rec).map(function (id) {
      return { id: id, name: rec[id].name, asked: rec[id].asked,
               refunds: rec[id].refunds, at: rec[id].at };
    });
    if (!rows.length) { box.hidden = true; return; }
    box.hidden = false;
    rows.sort(function (a, b) {
      const sc = function (r) { return r.asked + r.refunds; };
      return sc(a) - sc(b) || a.at - b.at || (a.name < b.name ? -1 : 1);
    });
    const never = rows.filter(function (r) { return r.asked === 0; }).length;
    $('ask-sum').textContent = never + ' never asked · the town asks the people it has not asked lately';
    $('askedlist').innerHTML = rows.map(function (r) {
      const dim = r.asked === 0 ? 'var(--d-oxide)' : 'var(--d-faint)';
      const lapse = r.refunds ? ' <span style="color:var(--d-faint)">(' + r.refunds + ' lapsed)</span>' : '';
      return '<div class="askrow"><span class="an">' + r.name + '</span>' +
             '<span class="av" style="color:' + dim + '">' + r.asked + '</span>' + lapse + '</div>';
    }).join('');
  }

  function renderCoverage(s) {
    const cov = s.coverage;
    const box = $('cov-box');
    if (!cov || !cov.students.length) { box.hidden = true; return; }
    box.hidden = false;

    const total = cov.students.length * cov.facts.length;
    const got = cov.facts.reduce(function (a, f) { return a + f.reached; }, 0);
    $('cov-sum').textContent = got + ' / ' + total + (cov.complete ? ' · COVERED' : '');
    $('cov-sum').style.color = cov.complete ? 'var(--d-teal)' : 'var(--d-faint)';

    const head = '<div style="display:flex;padding:0 0 6px"><span style="width:150px;flex-shrink:0"></span>' +
      cov.facts.map(function (f) {
        return '<span class="mono" style="flex:1;text-align:center;font-size:8.5px;letter-spacing:.04em;color:' +
          (f.reached < cov.students.length ? 'var(--d-oxide)' : 'var(--d-faint)') + '">' +
          f.short.toUpperCase().slice(0, 9) + '</span>';
      }).join('') + '</div>';

    const rows = cov.students.map(function (st) {
      const cells = cov.facts.map(function (f) {
        const has = st.missing.indexOf(f.id) === -1;
        return '<span class="mono" style="flex:1;text-align:center;font-size:11px;color:' +
          (has ? 'var(--d-teal)' : 'var(--d-oxide)') + '">' + (has ? '✓' : '·') + '</span>';
      }).join('');
      const risk = st.missing.length >= 2;
      return '<div style="display:flex;align-items:center;height:21px;background:' +
        (risk ? '#1B1618' : 'transparent') + '">' +
        '<span style="width:150px;flex-shrink:0;font-size:12px;white-space:nowrap;overflow:hidden;' +
        'text-overflow:ellipsis;padding-left:6px">' + st.name + '</span>' + cells + '</div>';
    }).join('');

    const tally = '<div style="display:flex;height:24px;align-items:center;border-top:1px solid var(--d-rule);margin-top:4px">' +
      '<span class="c-cap" style="width:150px;flex-shrink:0;padding-left:6px">reached</span>' +
      cov.facts.map(function (f) {
        return '<span class="mono" style="flex:1;text-align:center;font-size:11px;font-weight:500;color:' +
          (f.reached < cov.students.length ? 'var(--d-oxide)' : 'var(--d-teal)') + '">' + f.reached + '</span>';
      }).join('') + '</div>';

    $('coverage').innerHTML = head + rows + tally;
  }

  /* ---------------------------------------------------------------- rendering */
  function renderClocks(s) {
    $('clocks').innerHTML = Object.keys(s.clocks).map(function (id) {
      const c = s.clocks[id];
      let segs = '';
      for (let i = 0; i < c.segments; i++) segs += '<i class="' + (i < c.filled ? 'on' : '') + '"></i>';
      return '<div style="margin-bottom:15px">' +
        '<div class="kv"><span class="k">' + c.label + '</span>' +
        '<span class="v">' + c.filled + '/' + c.segments + '</span>' +
        '<button class="step" data-clock="' + id + '" data-d="-1">&minus;</button>' +
        '<button class="step" data-clock="' + id + '" data-d="1">+</button></div>' +
        '<div class="segs">' + segs + '</div>' +
        '<div class="note">' + (c.note || '') + '</div></div>';
    }).join('');
  }

  function renderLedger(s) {
    $('ledger').innerHTML = Object.keys(s.ledger).map(function (id) {
      const l = s.ledger[id];
      return '<div class="kv"><span class="k">' + l.label + '</span>' +
        '<span class="v">' + l.value + '</span>' +
        '<button class="step" data-led="' + id + '" data-d="-1">&minus;</button>' +
        '<button class="step" data-led="' + id + '" data-d="1">+</button></div>';
    }).join('');
  }

  function renderTally(s) {
    const seg = s.segment;
    const box = $('tally-box');
    if (!seg || seg.kind !== 'tally') { box.hidden = true; return; }
    box.hidden = false;
    $('tally-rows').innerHTML = (seg.options || []).map(function (o) {
      return '<div class="kv"><span class="k">' + o.key + ' · ' + o.label + '</span>' +
        '<span class="v">' + (s.tally[o.key] || 0) + '</span>' +
        '<button class="step" data-tally="' + o.key + '" data-d="-1">&minus;</button>' +
        '<button class="step" data-tally="' + o.key + '" data-d="1">+</button></div>';
    }).join('');
  }

  /* WHICH SESSION.
   *
   * There was no way to say this from any screen. nextSession only steps
   * forward and only once a period has closed out, so reaching session 2
   * meant teaching session 1 to the end first - fine for a class working
   * through the unit, useless for looking at Thursday's period on Sunday.
   *
   * Rendered from the snapshot rather than a hardcoded list, so sessions
   * three to six appear here the day their JSON lands and not before. */
  const SS_NOTE = 'Each class works through these in order. Picking one resets today’s period; everything the class has earned stays with them.';
  function renderSessions(s) {
    const list = (s.meta && s.meta.sessions) || [];
    $('ss-now').textContent = list.length > 1 ? list.length + ' written so far' : '';
    $('ss-list').innerHTML = list.map(function (x) {
      const on = x.index === s.sessionIndex;
      const arm = ssArmed === x.index;
      return '<button class="cl-row' + (on ? ' on' : '') + (arm ? ' arm' : '') +
        '" data-session="' + x.index + '">' +
        '<span class="cl-code mono">' + x.session + '</span>' +
        '<span class="cl-mid">' +
          '<span class="cl-where">' + x.title + '</span>' +
          '<span class="cl-who c-cap">' + (arm
            ? 'press again to switch — today restarts'
            : (on ? 'loaded' : 'not loaded')) + '</span>' +
        '</span>' +
        '<span class="cl-when c-cap">' + (on ? 'showing now' : 'load') + '</span>' +
        '</button>';
    }).join('');
  }

  /* preflight() measures whichever session is actually loaded, so the answer
   * to "does it fit the bell" has to follow the picker rather than the file
   * the page happened to boot on. */
  /* Asked once per session, not once per tick. render() runs every second,
   * and the condition that calls this stays true until the fetch lands - so
   * without the latch a session whose JSON is missing (3 to 6 are unwritten)
   * would ask for it again every second for the whole period. */
  let ssFetching = null;
  function loadSessionJson(nSession) {
    if (ssFetching === nSession) return;
    ssFetching = nSession;
    fetch('content/session-' + nSession + '.json', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) { SESSION = j; preflight(); })
      .catch(function () {});
  }

  function renderOutline(s) {
    $('outline').innerHTML = s.outline.map(function (o, i) {
      return '<button class="ol ' + o.state + '" data-goto="' + i + '">' +
        '<span class="k">' + (o.turn ? 'TURN ' + o.turn : o.kind.toUpperCase()) + '</span>' +
        '<span class="l">' + o.label + '</span>' +
        '<span class="s">' + mmss(o.seconds) + '</span></button>';
    }).join('');
    $('ol-budget').textContent =
      mmss(s.budget.authored) + ' authored · ' + mmss(s.budget.allowed) + ' allowed';
  }

  /* The ambient field: readable from thirty feet while crouched at a desk. */
  function renderAmbient(s) {
    const a = $('ambient');
    a.className = 'ambient';
    if (!s.started) { a.classList.add('idle'); return; }
    if (!s.running) { a.classList.add('amber'); return; }
    if (s.budget.toBell < 120) { a.classList.add('alert'); return; }
    if (s.segment && s.segment.teacherNote) { a.classList.add('amber'); return; }
    /* calm is the base .ambient class — nothing to add. */
  }

  function render(s) {
    if (!s || !s.meta) return;
    LAST = s;
    $('m-title').textContent = s.meta.title || '';
    $('m-sess').textContent = 'Session ' + s.meta.session;
    $('m-class').textContent = Net.room || '';
    $('m-test').hidden = !s.testMode;
    const bell = $('m-bell');
    bell.textContent = mmss(s.budget.toBell);
    /* Behind = there is more session left than there is period left. This is
     * the number design/14-autopilot.md wanted the room rule to watch; with no
     * student devices in Phase 1 the teacher watches it instead. */
    const behind = s.budget.remainingAuthored - s.budget.toBell;
    bell.classList.toggle('over', s.budget.toBell < 180 || behind > 60);
    $('n-behind').textContent = behind > 30
      ? mmss(behind) + ' MORE SESSION THAN PERIOD'
      : (behind < -120 ? mmss(-behind) + ' SPARE' : 'ON PACE');
    $('n-behind').style.color = behind > 30 ? 'var(--d-oxide)'
      : (behind < -120 ? 'var(--d-faint)' : 'var(--d-teal)');

    /* ONE SCREEN. What `started` changes is which BUTTONS are live, not
     * which page a teacher is looking at. A restored period counts as idle
     * on purpose - it is started but held, and nothing may advance until a
     * human confirms the class is actually back in their seats. */
    const held = s.started && s.resumedFromDisk;
    const idle = !s.started || held;
    $('start-row').hidden = !idle;
    $('run-row').hidden = idle;
    $('b-start').textContent = held ? 'Resume the period  ▶' : 'Start the period  ▶';
    /* Only on the TRANSITION. Assigning every tick would slam the panel back
     * open a second after a teacher folded it. */
    if (idle !== wasIdle) {
      wasIdle = idle;
      $('setup').open = idle;
      /* Same fold, for the same reason: before the bell these links are the
       * most important thing in this column, and during the lesson THE ROOM
       * is. Folded they cost one line and stay one click away, which is the
       * whole difference from the version that hid them outright. */
      $('screens-box').open = idle;
      if (held) preflight();
    }
    $('setup-sum').textContent = idle
      ? 'Choose the class and the session'
      : 'Class ' + (Net.room || '') + ' · Session ' + s.meta.session + ' · change';
    renderAmbient(s);
    renderSessions(s);
    if (SESSION && SESSION.session !== s.meta.session) loadSessionJson(s.meta.session);
    renderTestMode(s);
    renderClocks(s);
    renderLedger(s);
    renderRoom(s);
    renderOutline(s);
    renderStageNote(s);

    if (idle) {
      /* The card still has to say something true. "Not started" plus the
       * name of what is about to happen beats a row of em dashes. */
      $('n-kind').textContent = held ? 'HELD' : 'NOT STARTED';
      $('n-pos').textContent = s.count + ' beats · ' + mmss(s.budget.authored);
      $('n-extra').textContent = '';
      $('n-title').textContent = held
        ? 'Picked up where you left off. Press Resume when they are back.'
        : (s.meta.subtitle || 'Press Start when they are in their seats.');
      $('n-clock').textContent = '—';
      $('n-say').hidden = true;
      $('t-note').hidden = true;
      return;
    }

    const seg = s.segment || {};
    $('n-kind').textContent = (seg.label || seg.kind || '').toUpperCase();
    $('n-pos').textContent = (s.index + 1) + ' of ' + s.count;
    $('n-extra').textContent = s.extra ? '+' + s.extra + 's added' : '';
    $('n-title').textContent = seg.instruction || seg.title || seg.eyebrow || '—';

    const cl = $('n-clock');
    cl.textContent = mmss(s.remaining);
    cl.classList.toggle('low', s.remaining <= 10);

    const voice = seg.voice || (seg.blocks && seg.blocks[0]);
    if (voice && (voice.text || voice.body)) {
      $('n-say').hidden = false;
      $('n-say-cap').textContent = s.manualRead ? 'read this aloud yourself' : 'the narrator is reading';
      $('n-say-text').textContent = voice.text || voice.body;
    } else {
      $('n-say').hidden = true;
    }

    const tn = $('t-note');
    if (seg.teacherNote) { tn.hidden = false; tn.textContent = seg.teacherNote; }
    else tn.hidden = true;

    $('b-pause').textContent = s.running ? 'Pause' : 'Resume';
    $('b-pause').classList.toggle('warn', !s.running);
    $('b-mute').classList.toggle('on', s.manualRead);

    renderTally(s);
    renderAsked(s);
    renderCoverage(s);
  }

  /* The server counts open Stage streams, so this is a fact rather than a
   * guess — including a Stage opened on another machine entirely. */
  function renderStageNote(s) {
    const others = Math.max(0, (s.viewers || 0) - 1 - (Overlay.on ? 1 : 0));
    $('side-note').textContent =
      others > 0
        ? others + ' Stage screen' + (others > 1 ? 's' : '') +
          ' listening — drag one to the projector and press F11.'
        : Overlay.on
        ? 'The Stage is on this screen. Escape hides it and shows the console.'
        : 'No Stage open — nothing is on the projector yet.';
  }

  /* ---------------------------------------------------------------- wiring */
  function bind() {
    $('b-start').addEventListener('click', function () {
      if (!(LAST && LAST.viewers > 0)) Overlay.open();   // never start on a blank projector
      Narrator.say({ speaker: 'NARRATOR', text: ' ' });  // a gesture unlocks speech
      Net.cmd(LAST && LAST.resumedFromDisk ? 'resume' : 'start');
    });
    /* REHEARSAL FROM THE GATE. Seat the bots FIRST and open the room second.
     * The other order gives you a period that starts empty and fills up over
     * the next thirty seconds, which is not the period a class plays: the
     * opening read is the one moment the whole room is guaranteed present. */
    $('b-test-gate').addEventListener('click', function () {
      const note = $('test-gate-note');
      note.textContent = 'Seating the roster…';
      Net.cmd('testMode', { on: true }).then(function (r) {
        if (!r || r.error) {
          note.textContent = r && r.error === 'real-students-present'
            ? 'Not while ' + r.students + ' real student(s) are in the room. Test mode is for an empty room.'
            : 'The server refused test mode.';
          return;
        }
        note.textContent = 'REHEARSAL — ' + r.seated + ' seated, ' + r.away +
          ' away today. Nobody in this room is real.';
        if (!(LAST && LAST.viewers > 0)) Overlay.open();   // never start on a blank projector
        Narrator.say({ speaker: 'NARRATOR', text: ' ' });  // a gesture unlocks speech
        Net.cmd(LAST && LAST.resumedFromDisk ? 'resume' : 'start');
      });
    });
    /* Two presses to switch a session that is mid-period, and the second one
     * is the same button - no dialog. A confirm() box is one more thing to
     * fail to notice on a projector, and it can be suppressed by the browser. */
    $('ss-list').addEventListener('click', function (e) {
      const b = e.target.closest && e.target.closest('[data-session]');
      if (!b) return;
      const i = +b.getAttribute('data-session');
      const force = ssArmed === i;
      Net.cmd('setSession', { index: i, force: force }).then(function (r) {
        if (r && r.error === 'period-in-progress') {
          ssArmed = i;
          $('ss-note').textContent = 'That class is part way through a period. Press it again to switch — today starts over, and everything they have earned stays with them.';
        } else {
          ssArmed = null;
          $('ss-note').textContent = SS_NOTE;
        }
        if (LAST) renderSessions(LAST);
      });
    });
    $('ch-list').addEventListener('click', function (e) {
      const b = e.target.closest && e.target.closest('[data-room]');
      if (b) goToRoom(b.getAttribute('data-room'));
    });
    if ($('ch-make')) {
      const mk = function () {
        const raw = ($('ch-code').value || '').trim().toUpperCase()
          .replace(/[^A-Z0-9-]/g, '').slice(0, 12);
        if (raw) goToRoom(raw);
      };
      $('ch-make').addEventListener('click', mk);
      $('ch-code').addEventListener('keydown', function (e) { if (e.key === 'Enter') mk(); });
    }
    $('b-stage-inline').addEventListener('click', function () { Overlay.open(); });
    $('b-focus').addEventListener('click', function () { Overlay.toggle(); });

    $('b-pause').addEventListener('click', function () { Narrator.stop(); Net.cmd('toggle'); });
    $('b-extend').addEventListener('click', function () { Net.cmd('extend', { seconds: 30 }); });
    $('b-next').addEventListener('click', function () { Narrator.stop(); Net.cmd('next'); });
    $('b-back').addEventListener('click', function () { Narrator.stop(); Net.cmd('back'); });
    $('b-replay').addEventListener('click', function () { Narrator.stop(); Net.cmd('replay'); });
    $('b-roll').addEventListener('click', function () { Net.cmd('roll'); });

    /* TEST MODE. Choose the session first, then press this: the whole
     * roster sits down as bots and the period plays on the real clock. */
    $('b-test').addEventListener('click', function () {
      const on = !(LAST && LAST.testMode);
      Net.cmd('testMode', { on: on }).then(function (r) {
        const note = $('test-note');
        if (!note) return;
        if (r && r.error === 'real-students-present') {
          note.textContent = 'Not while ' + r.students + ' real student(s) are in the room.';
        } else if (r && r.seated !== undefined) {
          note.textContent = r.seated + ' seated, ' + r.away + ' away today.';
        } else {
          note.textContent = '';
        }
      });
    });
    $('b-mute').addEventListener('click', function () {
      const on = !(LAST && LAST.manualRead);
      Narrator.setMuted(on);
      Net.cmd('manualRead', { on: on });
    });

    document.addEventListener('click', function (e) {
      const t = e.target.closest ? e.target.closest('[data-clock],[data-led],[data-tally],[data-goto]') : null;
      if (!t) return;
      const d = parseInt(t.getAttribute('data-d') || '0', 10);
      if (t.hasAttribute('data-clock')) Net.cmd('clock', { id: t.getAttribute('data-clock'), d: d });
      else if (t.hasAttribute('data-led')) Net.cmd('ledger', { id: t.getAttribute('data-led'), d: d });
      else if (t.hasAttribute('data-tally')) Net.cmd('tally', { key: t.getAttribute('data-tally'), d: d });
      else if (t.hasAttribute('data-goto')) { Narrator.stop(); Net.cmd('goto', { index: parseInt(t.getAttribute('data-goto'), 10) }); }
    });

    /* Keyboard, so the teacher never hunts for a button:
     * space = pause · → skip · ← back · e extend · r replay */
    document.addEventListener('keydown', function (e) {
      if (e.target && /input|textarea/i.test(e.target.tagName)) return;
      if (e.code === 'Space') { e.preventDefault(); if (LAST && LAST.started) { Narrator.stop(); Net.cmd('toggle'); } else $('b-start').click(); }
      else if (e.code === 'ArrowRight') { Narrator.stop(); Net.cmd('next'); }
      else if (e.code === 'ArrowLeft') { Narrator.stop(); Net.cmd('back'); }
      else if (e.key === 'e' || e.key === 'E') Net.cmd('extend', { seconds: 30 });
      else if (e.key === 'r' || e.key === 'R') { Narrator.stop(); Net.cmd('replay'); }
      else if (e.key === 'Escape') Overlay.toggle();
    });

    window.addEventListener('beforeunload', function () { Narrator.stop(); });
  }

  /* ================================================== BEFORE THE BELL
   *
   * Which class is this? Five periods a day, each its own campaign, each with
   * its own saved progress. /api/periods has always been able to answer that;
   * nothing asked it. The desk was hardwired to one class code and the only
   * way to change it was to edit the address bar, which is not a thing a
   * teacher should ever have to know.
   *
   * Choosing a class RELOADS the page against it, deliberately. A desk that
   * swapped rooms in place would have to unwind an SSE stream, a timer, a
   * narrator and a dozen rendered panels; a reload is two hundred milliseconds
   * and cannot be half-done. */
  /* The URL is not the only way the desk knows its room — with no ?room= it is
   * on whatever Net defaulted to, and marking nothing as current made the list
   * read as though no class were open. Ask Net, which is the thing that
   * actually connected. */
  /* An explicit ?room= means a human chose this class. Without one the
   * console is showing whatever the server last touched, which is not the
   * same thing and must not be treated as a decision. */
  function roomChosen() {
    return !!new URLSearchParams(location.search).get('room');
  }
  function roomInUrl() {
    const q = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
    return q || (Net.room || '').toUpperCase();
  }
  function goToRoom(code) {
    const q = new URLSearchParams(location.search);
    q.set('room', String(code).toUpperCase());
    location.search = q.toString();
  }

  /* savedAt comes off the store as epoch milliseconds, not an ISO string.
   * Date.parse of a number returns NaN, so this silently rendered nothing —
   * caught by looking at the actual payload rather than assuming its shape. */
  function whenSaved(at) {
    if (!at) return '';
    const then = typeof at === 'number' ? at : Date.parse(at);
    if (!then) return '';
    const mins = Math.round((Date.now() - then) / 60000);
    if (mins < 2) return 'just now';
    if (mins < 60) return mins + ' minutes ago';
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs === 1 ? 'an hour ago' : hrs + ' hours ago';
    const days = Math.round(hrs / 24);
    return days === 1 ? 'yesterday' : days + ' days ago';
  }

  /* THE FIRST SCREEN. What a teacher needs before anything opens is not a
   * dashboard, it is one question: whose period is this? Each row says what
   * pressing it will actually do, because "session 1, part way through" and
   * "session 1 finished" lead to very different next minutes. */
  function renderChooser(list) {
    const box = $('ch-list');
    if (!box) return;
    if (!list.length) {
      box.innerHTML = '<div class="cl-empty">No class has been played on this ' +
        'computer yet. Make one below and today becomes its first period.</div>';
      return;
    }
    box.innerHTML = list.map(function (p) {
      const act = p.finished ? 'Start the next session'
        : p.segment > 0 ? 'Carry on where it stopped'
        : 'Begin session ' + p.session;
      const state = p.finished ? 'session ' + p.session + ' finished'
        : p.segment > 0 ? 'session ' + p.session + ', part way through'
        : 'session ' + p.session + ', not started yet';
      const who = p.characters
        ? p.characters + (p.characters === 1 ? ' student has a name' : ' students have names')
        : 'nobody has joined yet';
      return '<button class="ch-row" data-room="' + p.code + '">' +
        '<span class="ch-code mono">' + p.code + '</span>' +
        '<span class="ch-mid"><span class="ch-do">' + act + '</span>' +
        '<span class="ch-state c-cap">' + state + ' &middot; ' + who +
          (p.rehearsal ? ' &middot; <b class="cl-test">rehearsal</b>' : '') + '</span></span>' +
        '<span class="ch-when c-cap">' + whenSaved(p.savedAt) + '</span>' +
        '</button>';
    }).join('');
  }

  function loadClasses() {
    const here = roomInUrl();
    $('cl-now').textContent = here ? 'now showing ' + here : '';
    fetch('api/periods', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        const list = (res && res.periods) || [];
        /* most recently played first: on a normal day that is the class you
         * just taught, and the one you are about to teach is the one you make */
        list.sort(function (a, b) {
          return (Date.parse(b.savedAt || 0) || 0) - (Date.parse(a.savedAt || 0) || 0);
        });
        renderClasses(list, here);
        renderChooser(list);
      })
      .catch(function () { renderClasses([], here); });
  }

  function renderClasses(list, here) {
    const box = $('cl-list');
    if (!list.length) {
      box.innerHTML = '<div class="cl-empty">No class has been played on this ' +
        'computer yet. Make one below — or press Open the room to use ' +
        (here || 'the default') + '.</div>';
      return;
    }
    box.innerHTML = list.map(function (p) {
      const on = p.code === here;
      const where = p.finished
        ? 'session ' + p.session + ' finished'
        : p.segment > 0 ? 'session ' + p.session + ', part way through'
        : 'session ' + p.session + ', not started';
      const who = p.characters
        ? p.characters + (p.characters === 1 ? ' character' : ' characters')
        : 'nobody has joined';
      /* The save carries wasTestMode forever and /api/periods has always
       * served it, but nothing showed it. A permanent mark nobody can see is
       * not a mark: this is the one screen where a teacher decides which
       * period to reopen, and a rehearsed one must not look like a taught one. */
      const mark = p.rehearsal
        ? '<span class="cl-test">rehearsal</span> · ' : '';
      return '<button class="cl-row' + (on ? ' on' : '') + '" data-room="' + p.code + '">' +
        '<span class="cl-code mono">' + p.code + '</span>' +
        '<span class="cl-mid">' +
          '<span class="cl-where">' + where + '</span>' +
          '<span class="cl-who c-cap">' + mark + who +
            (p.priorSessions ? ' · ' + p.priorSessions + (p.priorSessions === 1 ? ' session' : ' sessions') + ' behind them' : '') +
          '</span>' +
        '</span>' +
        '<span class="cl-when c-cap">' + (on ? 'showing now' : whenSaved(p.savedAt)) + '</span>' +
        '</button>';
    }).join('');
  }

  if ($('cl-list')) {
    $('cl-list').addEventListener('click', function (e) {
      const b = e.target.closest('[data-room]');
      if (!b) return;
      const code = b.getAttribute('data-room');
      if (code === roomInUrl()) return;         // already here
      goToRoom(code);
    });
  }
  if ($('cl-make')) {
    const make = function () {
      const raw = ($('cl-code').value || '').trim().toUpperCase()
        .replace(/[^A-Z0-9-]/g, '').slice(0, 12);
      if (!raw) { $('cl-note').textContent = 'Type a code first — 7A, or P3, or anything short.'; return; }
      if (raw === roomInUrl()) { $('cl-note').textContent = 'That is the class already showing.'; return; }
      goToRoom(raw);
    };
    $('cl-make').addEventListener('click', make);
    $('cl-code').addEventListener('keydown', function (e) { if (e.key === 'Enter') make(); });
  }

  /* WHERE THE STUDENTS GO, on the screen the teacher is actually looking at.
   *
   * /api/where has always computed this — every LAN address ranked with a
   * reason, and self-correcting once a student actually connects. Its only
   * reader was the projector page, which the teacher had to already know about
   * to reach. So the one screen that is definitely open never answered the
   * first question of every period. */
  function showWhereStudentsGo() {
    fetch('api/where', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (w) {
        if (!w || !w.ok) return;
        const best = (w.confirmed && w.confirmed[0]) || w.student[0] || '';
        if (!best) return;
        $('sc-url').textContent = best.replace(/^https?:\/\//, '');
        const others = (w.student || []).filter(function (u) { return u !== best; });
        $('sc-alt').textContent = others.length
          ? 'or ' + others.map(function (u) { return u.replace(/^https?:\/\//, ''); }).join(' · ')
          : '';
      })
      .catch(function () {});
  }

  /* ---------------------------------------------------------------- boot */
  function fail(html) {
    $('preflight').innerHTML = '<div class="warnbox">' + html + '</div>';
    $('b-start').disabled = true;
    $('b-test-gate').disabled = true;
  }

  Net.probe().then(function (hello) {
    if (hello && hello.version) {
      $('m-version').textContent = 'v' + hello.version;
    }
    /* NOTHING OPENS UNTIL A HUMAN CHOOSES. Without an explicit ?room= the
     * console is showing whatever the server last touched — yesterday, most
     * likely — with its period restored and a big Resume button under the
     * teacher's thumb. Ask first. */
    if (hello && !roomChosen()) {
      $('chooser').hidden = false;
      $('running').hidden = true;
      /* Nothing in the masthead is true yet. A bell counting down to the end
       * of a period nobody has opened, over the name of a class nobody has
       * picked, is the console asserting things it does not know. */
      document.querySelector('.c-bell').hidden = true;
      $('m-title').textContent = 'Past & Peril';
      $('mast-sub-wrap') && ($('mast-sub-wrap').hidden = true);
      document.querySelector('.mast-sub').hidden = true;
      loadClasses();
      bind();
      return;
    }
    if (!hello) {
      return fail('No classroom server answered.<br><br>Start it with ' +
        '<code>node server/serve.js</code> and open the address it prints. ' +
        'Opening these files directly from disk will not work — the room lives ' +
        'in the server, not in this page.');
    }
    return fetch('content/session-1.json')
      .then(function (r) { return r.json(); })
      .then(function (json) {
        SESSION = json;
        $('gate-sub').textContent = json.subtitle || '';
        $('m-title').textContent = json.title;
        $('gate-note').textContent =
          'Space pauses. Arrow keys skip and step back. E adds thirty seconds. ' +
          'Nothing needs pressing after you start — the period runs to the bell on its own.';

        /* A throw inside a view must never stop the period. Before this guard a
         * single bad classList call froze the clock AND stopped the Stage from
         * ever receiving state, with nothing visible to say so. */
        Net.on('state', function (st) {
          try { render(st); }
          catch (err) {
            if (!window.__renderWarned) {
              window.__renderWarned = true;
              console.error('console render failed', err);
            }
          }
        });
        Net.on('online', function (up) {
          $('side-note').textContent = up ? '' : 'Lost the server — reconnecting. The period keeps running.';
        });

        Net.connect({ role: 'view' });
        document.querySelectorAll('[data-stage-link]').forEach(function (link) {
          link.href = stageUrl();
        });
        /* Every screen link carries the room. Opening the joining screen for
         * the wrong class is a silent failure: it shows an address and a code
         * that work, for a period nobody is in. */
        const rq = '?room=' + encodeURIComponent(Net.room || '');
        if ($('b-join')) $('b-join').href = 'join.html' + rq;
        if ($('b-seat')) $('b-seat').href = 'play.html' + rq;
        /* connect initializes the selected room and teacher key. Only then
         * can opening the desk point the students' short URL at this class. */
        if (Net.isTeacher) Net.cmd('open');
        preflight();
        loadClasses();
        showWhereStudentsGo();
        if (!Net.isTeacher) {
          fail('This console is missing its teacher key, so the controls will be ' +
            'refused.<br><br>Open the <strong>?key=…</strong> address printed in the terminal.');
        }
        bind();
        setTimeout(preflight, 700);   // voices arrive asynchronously
      })
      .catch(function (err) {
        fail('Could not load the session (' + err.message + ').');
      });
  });
})();
