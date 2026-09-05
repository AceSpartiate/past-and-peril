/* play.js — the student client.
 *
 * Roll20's loop, at twelve-year-old scale and on a school Chromebook:
 *
 *     SEE THE WORLD  ·  MOVE YOUR TOKEN  ·  USE AN ABILITY
 *
 * The teacher never drives this. The autopilot beats from design/14 open and
 * close the turn window: when the lesson reaches DECLARE, thirty screens unlock;
 * when the beat ends they lock and the room looks up.
 *
 * SERVER-AUTHORITATIVE (design/09). This file draws and asks. It never decides.
 * The movement range it paints is a convenience; the server independently
 * rejects an illegal step, so editing this JS gets a student nothing. */

(function () {
  const $ = function (id) { return document.getElementById(id); };

  /* There is no fixed menu any more. design/08: authors write ACTIONS WITH
   * CONDITIONS and the engine computes what THIS student can do right now, so
   * the list below arrives from the server already filtered to who you are,
   * where you are standing, and what you have done. Each one still carries its
   * verb in the gutter, because the six verbs are the mechanic students learn. */

  let MAPS = {};            // every place in the campaign, by id
  let MAP = null, R = null; // the one THIS student is standing in
  let ME = null;            // the server's private view of me
  let WORLD = null;         // the server's public state
  let reachSet = {};        // "c,r" -> cost, derived from ME.reach
  let hover = null;
  let armed = null;
  let joined = false;
  let wired = false;
  let keyOpen = false;
  let SIM = null;           // when set, the tutorial owns the screen

  /* READ IT TO ME.
   *
   * design/15-risk-review.md R2: the bottom quartile of this class has no words
   * to spare, and the outcome text is the one piece of writing that arrives
   * ALONE, mid-turn, with nobody at the front of the room reading it out. So it
   * has to be speakable on demand.
   *
   * Default OFF, because thirty Chromebooks talking at once is a room nobody
   * can teach in. It remembers itself per device, and it reads only this
   * student's own outcome — never the shared narration, which comes off the
   * projector. */
  let readAloud = false;
  try { readAloud = localStorage.getItem('gonzales-read') === '1'; } catch (e) {}

  function applyRead() {
    const b = $('readme');
    b.classList.toggle('on', readAloud);
    b.querySelector('.rm-txt').textContent = readAloud ? 'READING' : 'READ TO ME';
    if (window.Narrator) Narrator.setMuted(!readAloud);
    try { localStorage.setItem('gonzales-read', readAloud ? '1' : '0'); } catch (e) {}
  }
  $('readme').addEventListener('click', function () {
    readAloud = !readAloud;
    applyRead();
    if (!readAloud && window.Narrator) Narrator.stop();
    /* Say something immediately, so a student learns what the button does from
     * the button and not from a sentence about the button. */
    if (readAloud && window.Narrator && ME && ME.lastOutcome && ME.lastOutcome.narrate) {
      Narrator.say({ speaker: 'NARRATOR', text: ME.lastOutcome.narrate });
    } else if (readAloud && window.Narrator) {
      Narrator.say({ speaker: 'NARRATOR', text: 'I will read out what happens to you.' });
    }
  });
  applyRead();

  /* CHANGING PLACE.
   *
   * The single most important line in this file: the map a student is looking
   * at is a function of where THEY are, and of nothing else. Two students who
   * walk into different buildings in the same second are each looking at a
   * different world a beat later, and neither one's screen flickers. */
  function usePlace(id) {
    if (!id || !MAPS[id] || (MAP && MAP.id === id)) return false;
    MAP = MAPS[id];
    R = HexMap.Renderer($('map'), MAP);
    hover = null;
    $('hexinfo').hidden = true;
    renderKey();
    return true;
  }

  /* ------------------------------------------------------------ boot */
  Net.probe().then(function (hello) {
    if (!hello) {
      document.body.innerHTML =
        '<div style="padding:44px;font-family:system-ui;max-width:34em;line-height:1.6">' +
        '<h2 style="font-family:Georgia,serif;font-weight:400">No classroom server.</h2>' +
        '<p>Ask your teacher to start it, then reload this page.</p></div>';
      return;
    }
    /* Every place at once. A student can walk through a door in the middle of
     * a turn and there is no time to fetch a map then — and on school wifi,
     * "no time" means "it does not happen". They are a few kB each. */
    return Net.maps().then(function (res) {
      (res.maps || []).forEach(function (m) { MAPS[m.id] = HexMap.make(m); });
      MAP = MAPS[Object.keys(MAPS)[0]] || null;
      paintPickMap();
      Net.connect({ role: 'student' });
      /* The documents. Loaded once at boot rather than when one is needed,
       * because the moment one IS needed is the top of a lesson on school
       * wifi, and "fetch it then" means "it does not arrive". */
      if (window.Docs) Docs.init({ onChange: renderDocsBtn });
      loadRoster();
    });
  });

  /* THE TOWN, BEHIND THE CHOOSING.
   *
   * The first thing a student saw was a register of thirty strangers, and the
   * situation that makes any of them matter arrived on the projector four
   * minutes later. So Gonzales is drawn behind the list: before reading a
   * single name they are looking at a place, at the hour the lesson is set,
   * with the cannon and the ford and the square in it.
   *
   * No tokens, nothing to press. It is scenery, and scenery is the cheapest
   * way to say "this is a game" without spending a word on saying it. */
  let pickR = null;
  function paintPickMap() {
    const cv = $('pick-map');
    const town = MAPS.gonzales_town || MAP;
    if (!cv || !town) return;
    if (!pickR) pickR = HexMap.Renderer(cv, town);
    pickR.draw({ light: { phase: 'AFTERNOON', weather: 'CLEAR' }, showLabels: false });
  }
  window.addEventListener('resize', function () { if (!joined) paintPickMap(); });

  let rosterCache = [];
  function loadRoster() {
    Net.roster().then(function (res) {
      if (!res.ok) return;
      rosterCache = res.roster || [];
      /* the figurine palette and who already has each colour — the creation
       * screen steers with this, it does not forbid with it */
      tints = res.tints || [];
      taken = res.tintsTaken || {};
      $('pick-sub').textContent = Net.room + ' · SESSION 1';

      /* WHAT THE TOWN STILL NEEDS.
       * A nudge before a rule: the trades nobody has taken are named at the
       * top, so most classes never meet the cap at all. */
      const bal = res.balance || {};
      const need = $('pick-need');
      if (need) {
        const w = bal.wanted || [];
        need.hidden = !w.length;
        need.textContent = w.length
          ? 'The town still needs: ' + w.map(function (c) { return c.toLowerCase(); }).join(', ') + '.'
          : '';
      }

      /* Wanted trades first, so the useful choice is the easy choice. */
      const order = res.roster.slice().sort(function (a, b) {
        const av = (a.taken || a.retired) ? 2 : (a.blocked ? 1 : 0);
        const bv = (b.taken || b.retired) ? 2 : (b.blocked ? 1 : 0);
        if (av !== bv) return av - bv;
        if (!!b.wanted !== !!a.wanted) return b.wanted ? 1 : -1;
        return 0;
      });

      $('pick-grid').innerHTML = order.map(function (p) {
        const off = p.taken || p.retired || p.blocked;
        const why = p.retired ? 'RETIRED' : p.taken ? 'TAKEN'
                  : p.blocked ? 'FULL FOR NOW'
                  : p.role.toUpperCase() + ' · ' + p.calling + ' · MOVE ' + p.move;
        return '<button class="pcard' + (p.blocked ? ' full' : '') + (p.wanted && !off ? ' wanted' : '') +
          '" data-id="' + p.id + '"' + (off ? ' disabled' : '') +
          (p.blockedWhy ? ' title="' + p.blockedWhy + '"' : '') +
          ' style="border-left-color:' + (off ? 'var(--rule)' : p.color) +
          (p.taken || p.retired ? ';opacity:.42' : '') + '">' +
          (p.wanted && !off ? '<span class="pw">THE TOWN NEEDS ONE</span>' : '') +
          '<span class="pn">' + p.name + '</span>' +
          '<span class="pr">' + why + '</span></button>';
      }).join('');
    });
  }

  /* ===================================================== MAKING YOUR FIGURINE
   *
   * Tapping a name used to join immediately. A teacher testing it said they
   * could not work out how to start character creation, and they were right:
   * there was no creation, only a list. Now there are two beats — who you are,
   * then what you look like — which is both discoverable and the thing that
   * makes thirty tokens on one board tell each other apart.
   *
   * The colour is chosen BEFORE joining, so a student's first appearance on
   * everyone else's screen is already theirs. */
  let making = null;                 // the person being made, from the roster
  let tints = [];                    // the palette, straight from the server
  let taken = {};                    // index -> how many have it already
  let tintPick = null;

  $('pick-grid').addEventListener('click', function (e) {
    const b = e.target.closest('[data-id]');
    if (!b || b.disabled) return;
    const id = b.getAttribute('data-id');
    const person = (rosterCache || []).filter(function (p) { return p.id === id; })[0];
    if (!person) return;
    startMaking(person);
  });

  function startMaking(person) {
    making = person;
    /* A first suggestion rather than a blank: a student who does not care
     * presses the button and still gets a colour of their own. The least-used
     * one, so a class that all presses straight through still spreads out. */
    tintPick = leastUsedTint();
    $('pick').hidden = true;
    $('make').hidden = false;
    renderMake();
  }

  function leastUsedTint() {
    let best = 0, bestN = Infinity;
    for (let i = 0; i < (tints.length || 12); i += 1) {
      const n = taken[i] || 0;
      if (n < bestN) { bestN = n; best = i; }
    }
    return best;
  }

  function renderMake() {
    if (!making) return;
    const p = making;
    $('make-name').textContent = p.name;
    $('make-role').textContent = [p.role, p.calling, 'MOVE ' + p.move]
      .filter(Boolean).join(' · ').toUpperCase();
    $('make-lede').textContent = p.abilityBlurb
      ? '“' + p.ability + '” — ' + p.abilityBlurb
      : 'A ' + String(p.calling || '').toLowerCase() + ' of Gonzales.';

    const st = p.stats || {};
    $('make-stats').innerHTML = ['arms', 'talk', 'land', 'word']
      .map(function (k) {
        return '<span class="ms"><b>' + (st[k] === undefined ? 0 : st[k]) +
               '</b>' + k.toUpperCase() + '</span>';
      }).join('');

    let sw = '';
    (tints.length ? tints : []).forEach(function (hex, i) {
      const n = taken[i] || 0;
      sw += '<button class="sw' + (i === tintPick ? ' on' : '') + '" type="button"' +
            ' data-tint="' + i + '" style="background:' + hex + '"' +
            ' title="' + (n ? n + ' already chose this' : 'nobody has this one') + '">' +
            (n ? '<i class="sw-n">' + n + '</i>' : '') + '</button>';
    });
    $('make-swatches').innerHTML = sw;
    const mine = taken[tintPick] || 0;
    $('make-note').textContent = mine
      ? String(mine) + ' classmate' + (mine === 1 ? '' : 's') + ' already picked this one — that is allowed'
      : 'Nobody else has this one.';

    HexMap.Figurine($('make-canvas'), {
      calling: p.calling,
      tint: (tints[tintPick] || p.color),
    });

    loadCard(p.id);
  }

  /* WHO THEY ACTUALLY WERE.
   *
   * These were real people, and the deck in player-materials holds what the
   * record says about each of them — and, deliberately, what it does not. That
   * second part is the more valuable half in a history classroom, and it never
   * reached a student because it lived on card stock.
   *
   * Fetched once per character and cached: a student flicking between colours
   * should not re-fetch a biography. */
  const cardCache = {};
  function loadCard(id) {
    const box = $('make-card');
    if (!box) return;
    if (cardCache[id] !== undefined) return paintCard(cardCache[id]);
    box.hidden = true;
    fetch('api/person?id=' + encodeURIComponent(id), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        cardCache[id] = (res && res.ok) ? res : null;
        /* they may have moved on while it was in flight */
        if (making && making.id === id) paintCard(cardCache[id]);
      })
      .catch(function () { cardCache[id] = null; });
  }

  function paintCard(res) {
    const box = $('make-card');
    if (!box) return;
    /* Five of the thirty have no card in the deck. Saying nothing is better
     * than inventing a biography for a real person. */
    if (!res || !res.card) { box.hidden = true; return; }
    box.hidden = false;
    /* Rendered, but collapsed. The words exist for whoever wants them and cost
     * nothing to whoever does not. */
    if (window.Docs) Docs.renderBlocks($('make-card-body'), res.card.blocks);
  }

  if ($('make-card-toggle')) {
    $('make-card-toggle').addEventListener('click', function () {
      const body = $('make-card-body');
      const open = body.hidden;
      body.hidden = !open;
      this.setAttribute('aria-expanded', open ? 'true' : 'false');
      this.querySelector('.mct-arrow').innerHTML = open ? '&#9662;' : '&#9656;';
    });
  }

  $('make-swatches').addEventListener('click', function (e) {
    const b = e.target.closest('[data-tint]');
    if (!b) return;
    tintPick = Number(b.getAttribute('data-tint'));
    renderMake();
  });

  $('make-back').addEventListener('click', function () {
    making = null;
    $('make').hidden = true;
    $('pick').hidden = false;
    loadRoster();
  });

  $('make-go').addEventListener('click', function () {
    if (!making) return;
    const btn = $('make-go');
    btn.disabled = true;
    Net.join(making.id, tintPick).then(function (res) {
      btn.disabled = false;
      if (!res.ok) {
        /* Somebody took the name while this student was choosing a colour.
         * Back to the list, which reloads with that card now greyed. */
        if (res.message) alert(res.message);
        making = null;
        $('make').hidden = true;
        $('pick').hidden = false;
        loadRoster();
        return;
      }
      $('make').hidden = true;
      enterPlay();
    }, function () { btn.disabled = false; });
  });

  function enterPlay() {
    if (joined) return;
    joined = true;
    $('pick').hidden = true;
    $('wrap').hidden = false;
    if (!wired) { wired = true; wireBoard(); }
    setInterval(function () { Net.ping(); }, 8000);
  }

  /* ------------------------------------------------------------ server truth */
  function applyYou(you) {
    if (!you) return;
    ME = you;
    /* Place FIRST: the reach below is in hexes of whatever map they are now
     * standing in, and parsing them against the old one puts a student's legal
     * moves in the wrong town. */
    usePlace(you.place);
    if (!R && MAP) { R = HexMap.Renderer($('map'), MAP); }
    reachSet = {};
    (you.reach || []).forEach(function (r) {
      const h = MAP.parse(r.hex);
      if (h) reachSet[h.c + ',' + h.r] = r.cost;
    });
    enterPlay();            // a reload rejoins: the server still knows us
    if (you.caughtUp) showCatchUp(you.caughtUp);
    maybeTutorial();
    if (you.lastOutcome) showOutcome(you.lastOutcome); else shownOutcome = null;
    renderIdentity();
    renderHud();
    renderPlace();
    renderActions();
    drawPips();
    maybeDocs(you);
    draw();
  }

  /* A DOCUMENT ARRIVES. IT DOES NOT TAKE OVER THE SCREEN.
   *
   * This used to open the document full-screen the moment the lesson reached
   * the cold open. It was measured afterwards, and it was the single worst
   * thing in the app: the Turtle Bayou Resolutions is 1,663 words — eighteen
   * and a half minutes at ninety words a minute — landing unasked on thirty
   * screens before anyone had made a decision. Total reading before the first
   * real choice of the lesson came to 2,323 words, most of it that.
   *
   * A class played it and said there was far too much text at the start, and
   * that it felt like a textbook with a game around it. They were describing
   * this.
   *
   * So the document ARRIVES — one line, at the bottom, ignorable — and a
   * student opens it when they want it or when an action asks for it. It is a
   * thing you reach for, which is what a primary source is. tools/
   * reading-first-ten.mjs keeps the number honest. */
  let docsSeen = {};
  function maybeDocs(you) {
    if (!window.Docs) return;
    const ids = (you && you.docs) || [];
    const before = Docs.count;
    Docs.setMine(ids);
    renderDocsBtn();
    if (SIM) return;
    for (let i = 0; i < ids.length; i += 1) {
      if (docsSeen[ids[i]]) continue;
      docsSeen[ids[i]] = true;
      if (Docs.count > before) announceDoc(ids[i]);
      break;
    }
  }

  /* Eleven words and a button. It sits for twelve seconds and goes away; the
   * DOCUMENTS button keeps it for the rest of the unit. */
  let docToastT = 0;
  function announceDoc(id) {
    const box = $('doc-toast');
    if (!box || !window.Docs) return;
    $('doc-toast-t').textContent = Docs.titleOf(id);
    box.setAttribute('data-doc', id);
    box.hidden = false;
    clearTimeout(docToastT);
    docToastT = setTimeout(function () { box.hidden = true; }, 12000);
  }

  function renderDocsBtn() {
    const b = $('docs-btn');
    if (!b || !window.Docs) return;
    const n = Docs.count;
    b.hidden = n === 0;
    $('docs-btn-n').textContent = n === 1 ? 'DOCUMENT' : n + ' DOCUMENTS';
  }

  function applyState(s) {
    WORLD = s;
    if (!ME) return;
    if (window.Tutorial && !Tutorial.running) showTutorialOffer();
    renderTurn();
    renderActions();
    draw();
  }

  /* the last thing the server actually said, kept so the tutorial can be
   * handed the screen and then hand it back to the truth */
  let lastServerYou = null, lastServerWorld = null;

  Net.on('you', function (you) {
    lastServerYou = you || lastServerYou;
    /* While the tutorial has the screen the server is still talking, and we
     * still listen — but we do not repaint over the lesson in progress. */
    if (SIM) { SIM.serverYou(you); return; }
    applyYou(you);
  });

  Net.on('state', function (s) {
    lastServerWorld = s || lastServerWorld;
    if (SIM) { SIM.serverState(s); return; }
    applyState(s);
  });

  /* ============================================ NOT TALKING TO THE SERVER
   *
   * A teacher closed the server in the middle of a lesson, opened it again
   * later, and reported: "the system didn't know it had been closed. The
   * student side still let me keep doing things."
   *
   * All of that was true, and detection was never the problem — net.js
   * already flips online=false from both the EventSource error and any failed
   * POST, and the 8-second heartbeat guarantees discovery. The problem was
   * that the ONLY consequence was one line of text inside #scrim, and
   * renderTurn hides #scrim whenever the turn is open. So the warning could
   * appear at every moment except the one that mattered.
   *
   * Three things now happen, and the third is the one that matters:
   *   · a banner outside the scrim, so it shows mid-turn
   *   · body.offline, so the CSS can grey what cannot be used
   *   · every intent is REFUSED rather than swallowed, so a student never
   *     spends a turn into a void and then argues with the board about it
   *
   * The tutorial is exempt throughout: it is a local simulation and works
   * perfectly well with no server at all. Locking it would punish a child for
   * their teacher's laptop. */
  function showOffline(up, why) {
    const bar = $('offline');
    if (bar) {
      bar.hidden = !!up;
      if (!up && why) $('off-txt').textContent = why;
    }
    document.body.classList.toggle('offline', !up);
    /* the lock screen's own note, for when it IS the visible surface */
    const note = $('scrim-note');
    if (note) note.textContent = up ? '' : 'RECONNECTING…';
  }

  Net.on('online', function (up) {
    if (!joined) return;
    showOffline(up, 'Lost the classroom server. Trying again…');
    renderTurn();
    renderActions();
    drawPips();
  });

  /* Wrap ONLY the network half of an intent.
   *
   * doMove/doAct/doEnter also route through SIM when the tutorial owns the
   * screen, and SIM.move/act/enter return nothing at all — wrapping those in
   * .then() would throw on the tutorial's very first tap, and take the bots in
   * tools/sim-class.js with it, since they use the same seam. */
  function sent(p) {
    if (!p || typeof p.then !== 'function') return p;
    return p.then(function (res) {
      if (res && res.ok === false && res.error === 'offline') {
        showOffline(false, 'That did not reach the server. Nothing has changed.');
      }
      return res;
    });
  }

  /* Is it safe to act at all? The tutorial always is. */
  function canAct() {
    if (SIM) return true;
    return Net.online;
  }

  /* WHAT YOU MISSED.
   *
   * The server decided this student was absent and has already handed them the
   * facts. This just shows them what happened, in the fewest sentences that
   * make the next hour make sense. Read once and gone — the server forgets it
   * when they dismiss it, so a reload does not replay it. */
  let catchUpShown = false;
  function showCatchUp(cu) {
    if (catchUpShown || !cu || !cu.cards || !cu.cards.length) return;
    catchUpShown = true;
    const head = cu.cards.filter(function (c) { return c.kind === 'head'; })[0];
    $('cu-kicker').textContent = head ? (head.note || 'WHILE YOU WERE AWAY') : 'BEFORE YOU GOT HERE';
    $('cu-title').textContent = head ? head.title : 'What your town has already done';
    $('cu-body').innerHTML = cu.cards.map(function (c) {
      if (c.kind === 'head') return c.sub ? '<p class="stamp">' + c.sub + '</p>' : '';
      return '<p class="' + c.kind + '">' + c.text + '</p>';
    }).join('');
    const fl = $('cu-facts');
    fl.hidden = !(cu.facts && cu.facts.length);
    $('cu-facts-list').innerHTML = (cu.facts || []).map(function (f) {
      return '<p>' + f.statement + '</p>';
    }).join('');
    $('catchup').hidden = false;
    /* and read it out, for the student who asked for that */
    if (window.Narrator && !Narrator.muted) {
      const said = cu.cards.filter(function (c) { return c.kind !== 'head'; })
        .map(function (c) { return c.text; }).join(' ');
      Narrator.say({ speaker: 'NARRATOR', text: said });
    }
  }

  $('cu-close').addEventListener('click', function () {
    $('catchup').hidden = true;
    if (window.Narrator) Narrator.stop();
    Net.caughtUp();
  });

  /* Offered, never forced, and never on top of a live lesson. */
  function maybeTutorial() {
    if (!window.Tutorial || Tutorial.running || !ME) return;
    /* Never over the catch-up sheet — mechanics first, then the story, and one
     * thing on screen at a time. */
    if (!$('catchup').hidden) return;
    const started = !!(WORLD && WORLD.started);
    if (started || Tutorial.done) { showTutorialOffer(); return; }
    startTutorial();
  }

  function startTutorial() {
    if (!window.Tutorial || Tutorial.running || !ME) return;
    $('tut-offer').hidden = true;
    Tutorial.start(ME, MAPS, rosterCache, function () { showTutorialOffer(); });
  }

  function showTutorialOffer() {
    const b = $('tut-offer');
    if (!b) return;
    /* only on the lock screen — never over an open turn */
    b.hidden = !!(WORLD && WORLD.turnOpen);
    b.textContent = Tutorial.done ? 'Show me how to play again' : 'Show me how to play';
  }

  $('tut-offer').addEventListener('click', startTutorial);
  $('tut-next').addEventListener('click', function () {
    if (this.hidden) return;                 // only a step that OFFERS Next has one
    if (window.Tutorial && Tutorial.running) Tutorial.advance();
  });
  $('tut-quit').addEventListener('click', function () {
    if (window.Tutorial && Tutorial.running) Tutorial.stop();
  });

  /* ------------------------------------------------------------ board */
  /* ===================================================== PHONES AND TABLETS
   *
   * Measured on a 375-pixel phone before any of this: the whole town fitted on
   * screen, as designed, which put a hex at 23 pixels tall against a 44-pixel
   * minimum tap target. A thumb cannot reliably hit that, and every mis-tap
   * inside a turn window costs a child their turn.
   *
   * Worse, the route preview added for movement legibility is driven by
   * mousemove. A touch screen has no hover, so on a phone it did not exist at
   * all — the exact affordance that stops a walk looking like a teleport was
   * invisible on the devices most likely to need it.
   *
   * Both are fixed by the same idea: on touch, TAPPING A HEX DOES NOT MOVE
   * YOU. It selects — showing the route, the cost, and what is there — and a
   * second tap on the same hex commits. So the preview happens on the device
   * that has no hover, and a mis-tap costs a tap rather than a turn. */
  /* HYBRID DEVICES ARE THE NORMAL CASE, NOT THE EDGE CASE.
   *
   * Most school Chromebooks have a touchscreen AND a trackpad, and a student
   * will use both in one lesson. An earlier version of this gated on device
   * CAPABILITY — `if (TOUCH) return` in the click handler — which meant that on
   * every touchscreen laptop the trackpad silently stopped working on the map.
   * The device supports touch, so mouse input was discarded.
   *
   * So nothing here asks what the device can do. It tracks what the student
   * just DID: a real touch sets the timestamp, and a click arriving within the
   * ghost-click window after one is the browser's synthetic echo of that touch
   * and is dropped. Both inputs work, always, on the same screen. */
  const CAN_TOUCH = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
  let lastTouchAt = 0;
  let armedHex = null;                  // touch: selected, awaiting confirmation
  const cameFromTouch = () => (Date.now() - lastTouchAt) < 700;

  function isPhone() {
    return CAN_TOUCH && Math.min(window.innerWidth, window.innerHeight) < 820;
  }

  function wireBoard() {
    const c = $('map');
    function pos(ev) {
      const r = c.getBoundingClientRect();
      const t = (ev.touches && ev.touches[0]) || (ev.changedTouches && ev.changedTouches[0]) || ev;
      return [t.clientX - r.left, t.clientY - r.top];
    }

    /* ---- pointer, for anything with a hover ---- */
    c.addEventListener('mousemove', function (ev) {
      if (cameFromTouch()) return;      // the echo of a tap, not a real hover
      const p = pos(ev);
      const h = R.hitTest(p[0], p[1]);
      const same = (h && hover && h.c === hover.c && h.r === hover.r) || (!h && !hover);
      hover = h;
      if (!same) { showHexInfo(h); draw(); }
    });
    c.addEventListener('mouseleave', function () {
      if (cameFromTouch()) return;
      hover = null; $('hexinfo').hidden = true; draw();
    });
    c.addEventListener('click', function (ev) {
      /* A tap fires touchend AND, shortly after, a synthetic click. Dropping
       * the echo is all that is needed — a genuine trackpad click on the same
       * touchscreen laptop still lands here. */
      if (cameFromTouch()) return;
      const p = pos(ev);
      const h = R.hitTest(p[0], p[1]);
      if (h) tapHex(h, false);
    });

    /* ---- touch: pan, pinch, and select-then-confirm ---- */
    let t0 = null, moved = 0, pinch = null, panFrom = null;

    c.addEventListener('touchstart', function (ev) {
      lastTouchAt = Date.now();
      if (ev.touches.length === 2) {
        const a = ev.touches[0], b = ev.touches[1];
        pinch = {
          d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
          s: R.getView().s,
        };
        panFrom = null;
        return;
      }
      t0 = pos(ev);
      moved = 0;
      const v = R.getView();
      panFrom = { x: v.x, y: v.y, px: t0[0], py: t0[1] };
    }, { passive: true });

    c.addEventListener('touchmove', function (ev) {
      if (pinch && ev.touches.length === 2) {
        const a = ev.touches[0], b = ev.touches[1];
        const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        R.setView({ s: pinch.s * (d / (pinch.d || 1)) });
        draw();
        ev.preventDefault();
        return;
      }
      if (!panFrom || ev.touches.length !== 1) return;
      const p = pos(ev);
      const dx = p[0] - panFrom.px, dy = p[1] - panFrom.py;
      moved = Math.max(moved, Math.hypot(dx, dy));
      /* Only pan once zoomed in; at the fitted scale there is nowhere to go and
       * a drag should stay a tap that wandered. */
      if (R.getView().s > 1) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        R.setView({ x: panFrom.x + dx * dpr, y: panFrom.y + dy * dpr });
        draw();
        ev.preventDefault();
      }
    }, { passive: false });

    c.addEventListener('touchend', function (ev) {
      lastTouchAt = Date.now();
      if (pinch) { pinch = null; return; }
      panFrom = null;
      if (moved > 12) return;            // that was a drag, not a tap
      const p = pos(ev);
      const h = R.hitTest(p[0], p[1]);
      if (h) tapHex(h, true);
    });

    window.addEventListener('resize', function () { fitForDevice(); draw(); });
    window.addEventListener('orientationchange', function () {
      setTimeout(function () { fitForDevice(); draw(); }, 250);
    });
    fitForDevice();
  }

  /* Zoom so a hex is worth tapping, and keep the student in the middle.
   *
   * A student should never have to work out that they need to pinch. On a
   * phone the map arrives already at a usable scale and follows them as they
   * walk; pinching out to see the whole town is then a thing they can choose
   * rather than a thing they must do. */
  function fitForDevice() {
    if (!R) return;
    if (!isPhone()) { R.setView({ s: 1 }); return; }
    const WANT = 46;                     // CSS px per hex, above the 44 minimum
    for (let i = 0; i < 8 && R.tapSize < WANT; i += 1) {
      R.setView({ s: R.getView().s * 1.25 });
    }
    if (ME && ME.hex) R.centreOn(ME.hex);
  }

  function showHexInfo(h) {
    const box = $('hexinfo');
    if (!h || !MAP.terrain(h.c, h.r)) { box.hidden = true; return; }
    const lab = MAP.label(h.c, h.r);
    const t = MAP.terrain(h.c, h.r);
    const lm = MAP.landmarkAt(lab);
    const cost = t.cost === null ? 'no crossing' : t.cost + (t.cost === 1 ? ' point' : ' points');
    box.hidden = false;
    const who = here().filter(function (s) { return s.hex === lab; })
      .map(function (s) { return s.name; });
    const npc = (ME && ME.npcs || []).filter(function (x) { return x.hex === lab; })
      .map(function (x) { return x.name.toUpperCase(); });
    const feats = (ME && ME.features || []).filter(function (f) { return f.hex === lab; })
      .map(function (f) {
        return f.to ? 'WAY IN — ' + (f.open === false ? 'SHUT' : (f.to.label || 'GO THROUGH').toUpperCase())
             : f.kind === 'door' ? (f.open ? 'DOOR — OPEN' : 'DOOR — SHUT')
             : f.kind === 'body' ? (f.searched ? 'SEARCHED' : f.label.toUpperCase())
             : f.kind === 'chest' ? (f.searched ? 'SEARCHED' : f.label.toUpperCase())
             : f.label.toUpperCase();
      });
    box.textContent = [lab, t.name.toUpperCase(), cost]
      .concat(lm ? [lm.label] : []).concat(feats).concat(npc)
      .concat(who.length ? [who.join(', ')] : []).join(' · ');
  }

  /* The three intents. The server answers them, unless the tutorial has the
   * screen — and NOTHING else in this file may talk to Net about them. */
  function doMove(hex) { return SIM ? SIM.move(hex) : sent(Net.move(hex)); }
  function doAct(id)   { return SIM ? SIM.act(id)  : sent(Net.act(id)); }
  function doEnter(id) { return SIM ? SIM.enter(id) : sent(Net.enter(id)); }

  /* WHERE WOULD I END UP, AND HOW WOULD I GET THERE.
   *
   * The same Dijkstra the server runs, over the same hydrated map and the same
   * occupancy, so the drawn route is the route that will actually be walked
   * and its cost is the cost that will actually be charged. If these two ever
   * disagree the server wins and the screen was lying — which is why this asks
   * MAP the question rather than guessing from the reach set. */
  function routeTo(h) {
    /* h is null whenever nothing is hovered or selected — which on a touch
     * screen is most of the time, since there is no hover to fall back on. */
    if (!h || !ME || !MAP || reachSet[h.c + ',' + h.r] === undefined) return null;
    return MAP.pathTo(ME.hex, MAP.label(h.c, h.r), ME.moveLeft || 0,
                      { occupied: occupiedHexes(), cheapTerrain: moveHelp() });
  }

  /* Riders and rancheros go along a road for one point. This has to match
   * Room#_moveOpts or the preview drifts from the ruling. */
  function moveHelp() {
    return (ME && (ME.calling === 'RIDER' || ME.calling === 'RANCHERO')) ? ['road'] : [];
  }

  /* THE WALK.
   *
   * The server has already moved them by the time this runs; sliding the token
   * along the route is only so the eye reads a person crossing three hexes
   * instead of one vanishing and another appearing. It is deliberately quick —
   * 110 ms a hex — because thirty children are waiting and an animation you
   * have to sit through is worse than none. */
  let walking = null;
  function walkAlong(route) {
    if (!route || route.length < 2) { walking = null; return; }
    const ms = 110 * (route.length - 1);
    const t0 = (window.performance || Date).now();
    walking = { route: route, t: 0 };
    (function step() {
      if (!walking || walking.route !== route) return;
      const dt = ((window.performance || Date).now() - t0) / ms;
      walking.t = dt;
      if (dt >= 1) { walking = null; draw(); return; }
      draw();
      window.requestAnimationFrame(step);
    })();
  }

  function tapHex(h, viaTouch) {
    /* Refuse rather than pretend. Moving a token locally while the server is
     * gone means the student is somewhere their classmates cannot see, and the
     * next state they receive yanks them back — which reads as the game
     * cheating them. */
    if (!canAct()) {
      showOffline(false, 'Waiting for the classroom server. You cannot move yet.');
      return;
    }
    if (reachSet[h.c + ',' + h.r] === undefined) {
      /* Out of range: nothing happens, no scolding. On touch, clear any
       * selection so a stray tap does not leave a route pointing nowhere. */
      if (armedHex) { armedHex = null; draw(); }
      return;
    }

    /* ON TOUCH, THE FIRST TAP SELECTS.
     *
     * It draws the route and the cost — the preview a phone otherwise never
     * gets, because there is no hover — and a second tap on the same hex
     * commits. A mis-tap then costs a tap instead of a turn, which on a 23-pixel
     * hex is the difference between playable and not. */
    if (viaTouch) {
      const same = armedHex && armedHex.c === h.c && armedHex.r === h.r;
      if (!same) {
        armedHex = { c: h.c, r: h.r };
        showHexInfo(h);
        draw();
        return;
      }
      armedHex = null;
    }

    const route = routeTo(h);
    doMove(MAP.label(h.c, h.r));                            // the server decides
    /* Started after the intent, not before: if the server refuses, the token
     * has not moved and there is nothing to animate. applyYou redraws from
     * server truth either way. */
    walkAlong(route);
  }

  function draw() {
    if (!R || !ME) return;
    R.draw({ you: ME.hex, reach: reachSet, hover: hover, tokens: otherTokens(),
             npcs: ME.npcs || [], features: ME.features,
             occupied: occupiedHexes(), light: ME.light,
             target: ME.target || null,
             /* hover on a pointer; the selected hex on a touch screen, which
              * has no hover at all */
             /* whichever the student last used: the selected hex after a tap,
              * the hovered hex after a pointer move */
             route: !walking ? routeTo(armedHex || hover) : null,
             armed: armedHex,
             walk: walking,
             /* so your own figurine is your Calling in the colour you chose,
              * rather than a black dot that looks like nobody in particular */
             calling: ME.calling, tint: ME.tint || null });
  }

  /* "GONZALES · 29 SEPTEMBER 1835" — where and when, and nothing else.
   *
   * The cold open needs a caption, not a caption plus an instruction. The
   * instruction would be the thing that made it feel like school again. */
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                  'August', 'September', 'October', 'November', 'December'];

  function placeAndDate() {
    const where = (MAP && MAP.title) || 'Gonzales';
    /* "1835-09-30" is a machine's date, and an ISO string in a game set in
     * 1835 breaks the spell in the one place the spell is all there is. */
    const raw = (ME && ME.light && ME.light.date) || '';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    const when = m ? (Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1] + ' ' + m[1]) : raw;
    return when ? where + ' · ' + when : where;
  }

  /* Movement as pips rather than a number in a sentence. Three dots that go
   * out one at a time is a budget a twelve-year-old can feel; "moveLeft: 2" is
   * a fact they have to read and convert. */
  function drawPips() {
    const box = $('tb-move');
    if (!box || !ME) return;
    const total = ME.move || 0;
    const left = Math.max(0, ME.moveLeft === undefined ? 0 : ME.moveLeft);
    if (!total) { box.hidden = true; return; }
    box.hidden = false;
    let html = '';
    for (let i = 0; i < total; i += 1) {
      html += '<i class="pip' + (i < left ? '' : ' spent') + '"></i>';
    }
    box.innerHTML = '<span class="pip-label">MOVE</span>' + html;
    box.title = left + ' of ' + total + ' movement left';
  }

  /* Only people in the SAME PLACE block a hex. Somebody standing in Zumwalt's
   * back room is not standing in the square, and must not hold ground there. */
  function here() {
    if (!WORLD || !WORLD.students || !ME) return [];
    return WORLD.students.filter(function (s) { return (s.place || null) === ME.place; });
  }

  function occupiedHexes() {
    return here().filter(function (s) {
      return s.hex && s.characterId !== ME.characterId;
    }).map(function (s) { return s.hex; });
  }

  function otherTokens() {
    if (!WORLD || !WORLD.students || !ME) return [];
    const byHex = {};
    WORLD.students.forEach(function (s) {
      if (s.characterId === ME.characterId) return;
      if ((s.place || null) === ME.place) {
        if (!s.hex) return;
        (byHex[s.hex] = byHex[s.hex] || []).push(s);
        return;
      }
      /* They went inside. You can still see WHICH door they went through —
       * that is what an anchor is — but not what they are doing in there. */
      const a = s.anchor;
      if (!a || a.place !== ME.place) return;
      const ghost = Object.assign({}, s, { hex: a.hex, elsewhere: true });
      (byHex[a.hex] = byHex[a.hex] || []).push(ghost);
    });
    const out = [];
    Object.keys(byHex).forEach(function (hx) {
      const list = byHex[hx];
      list.forEach(function (s, i) {
        let dx = 0, dy = 0;
        if (list.length > 1) {
          const a = Math.PI * 2 * (i / list.length) - Math.PI / 2;
          dx = Math.cos(a) * 9; dy = Math.sin(a) * 9;
        }
        out.push({ hex: hx, color: s.color, dx: dx, dy: dy,
                   name: list.length === 1 ? s.name.split(' ').slice(-1)[0] : null,
                   declared: !!s.acted, elsewhere: !!s.elsewhere });
      });
    });
    return out;
  }

  /* WHERE YOU ARE, WHAT TIME IT IS, AND THE WAY OUT.
   *
   * A twelve-year-old who has just walked into a dark room needs three things
   * on screen and no more: the name of the room, whether it is night, and how
   * to leave. */
  function renderPlace() {
    const nm = $('place-name');
    nm.textContent = (MAP && MAP.title) || '';
    document.body.classList.toggle('indoors', !!(MAP && MAP.indoors));

    const L = (ME && ME.light) || {};
    const table = (MAP && MAP.data.lightTable) || {};
    const wtab = (MAP && MAP.data.weatherTable) || {};
    const phase = table[L.phase] || null;
    const wx = wtab[L.weather] || null;
    const chip = $('place-time');
    chip.textContent = [phase ? phase.label : '', (wx && wx.veil) ? wx.label : '']
      .filter(Boolean).join(' · ');
    chip.className = 'mono place-time ' + String(L.phase || '').toLowerCase();

    const btn = $('portal');
    const pt = ME && ME.portal;
    btn.hidden = !pt;
    if (pt) {
      btn.textContent = (pt.out ? '\u25C2  ' : '\u25B8  ') + pt.label;
      btn.setAttribute('data-feature', pt.id);
    }
  }

  if ($('docs-btn')) {
    $('docs-btn').addEventListener('click', function () {
      if (!window.Docs) return;
      /* One document goes straight to it; several show the shelf, because
       * guessing which one they wanted is worse than asking. */
      if (Docs.count === 1) Docs.open(Docs.mine[0]);
      else Docs.openShelf();
    });
  }
  if (window.Docs) Docs.wire();

  if ($('doc-toast')) {
    $('doc-toast').addEventListener('click', function (e) {
      const id = this.getAttribute('data-doc');
      this.hidden = true;
      if (e.target.closest('[data-dismiss]')) return;
      if (id && window.Docs) Docs.open(id);
    });
  }

  /* Your own name in the HUD opens your card. It is the one place on the
   * screen a student already looks to answer "who am I", so it is where "and
   * who was he really" belongs. */
  if ($('hud-who')) {
    $('hud-who').addEventListener('click', function () {
      if (!ME) return;
      fetch('api/person?id=' + encodeURIComponent(ME.characterId), { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (!res || !res.ok || !res.card || !window.Docs) return;
          Docs.showCard(res);
        }).catch(function () {});
    });
  }

  if ($('oc-doc')) {
    $('oc-doc').addEventListener('click', function () {
      const id = this.getAttribute('data-doc');
      if (id && window.Docs) Docs.open(id);
    });
  }

  $('portal').addEventListener('click', function () {
    if (!canAct()) {
      showOffline(false, 'Waiting for the classroom server. You cannot go in yet.');
      return;
    }
    const id = this.getAttribute('data-feature');
    if (id) doEnter(id);
  });

  /* ------------------------------------------------------------- the key
   *
   * Built from the glyphs THIS place actually contains. A key listing
   * twenty-eight terrain types on a map that has nine is worse than no key at
   * all — the student stops reading it, and then it has taught them that keys
   * are not worth reading. */
  function renderKey() {
    if (!MAP) return;
    $('key-title').textContent = MAP.title || 'The map';
    const ground = $('key-ground');
    ground.innerHTML = '';
    MAP.legendUsed().forEach(function (t) {
      ground.appendChild(keyRow({ glyph: t.glyph, terrain: t }, t.name,
        (t.cost === null ? 'you cannot cross it' :
         t.cost === 1 ? 'costs 1 to step on' : 'costs ' + t.cost + ' to step on') +
        (t.hexes ? '  ·  ' + t.hexes + ' hex' + (t.hexes === 1 ? '' : 'es') + ' of it here' : ''),
        t.about || ''));
    });

    const marks = $('key-marks');
    marks.innerHTML = '';
    const kinds = MAP.featureKinds();
    const SYM = [
      ['door',  { icon: 'door', open: true },  'an open door', 'you can go through it'],
      ['door',  { icon: 'door', open: false }, 'a shut door',  'nobody gets through until somebody opens it'],
      ['door',  { icon: 'stair', open: true }, 'a way inside', 'stand on it, then press the button to go in'],
      ['chest', { icon: 'chest' },             'something to search', 'searching it costs you your turn'],
      ['chest', { icon: 'chest-done' },        'already searched', 'nothing left in it'],
      ['body',  { icon: 'body' },              'somebody fallen', 'you can go through what they carried'],
      ['cannon',{ icon: 'cannon' },            'the cannon',    'the whole thing is about this'],
      ['well',  { icon: 'well' },              'a well',        'water'],
    ];
    SYM.forEach(function (row) {
      if (kinds.indexOf(row[0]) === -1) return;
      marks.appendChild(keyRow(row[1], row[2], row[3], ''));
    });

    const who = $('key-who');
    who.innerHTML = [
      ['<i class="tok you"></i>', 'you', 'the black one is always you'],
      ['<i class="tok mate"></i>', 'somebody in your class', 'their company\u2019s colour'],
      ['<i class="tok ring"></i>', 'they have already acted', 'the ring means their turn is spent'],
      ['<i class="tok ghost"></i>', 'they went inside', 'they are in there, not out here'],
      ['<i class="tok npc"></i>', 'somebody from 1835', 'a square is never one of your classmates'],
      ['<i class="tok reach"></i>', 'you can walk here', 'the number is what the step costs'],
    ].map(function (r) {
      return '<div class="krow"><span class="kswatch">' + r[0] + '</span>' +
        '<span class="ktext"><b>' + r[1] + '</b><em>' + r[2] + '</em></span></div>';
    }).join('');
  }

  function keyRow(spec, name, cost, about) {
    const el = document.createElement('div');
    el.className = 'krow';
    const cv = document.createElement('canvas');
    cv.className = 'kswatch';
    cv.width = 120; cv.height = 104;
    el.appendChild(cv);
    const tx = document.createElement('span');
    tx.className = 'ktext';
    tx.innerHTML = '<b>' + name + '</b><em>' + (about || cost) + '</em>' +
      (about && cost ? '<u>' + cost + '</u>' : '');
    el.appendChild(tx);
    try { HexMap.Swatch(cv, spec, ME && ME.light); } catch (e) {}
    return el;
  }

  $('key-btn').addEventListener('click', function () {
    keyOpen = !keyOpen;
    $('keypanel').hidden = !keyOpen;
    this.classList.toggle('on', keyOpen);
    if (keyOpen) renderKey();
    if (window.Tutorial) Tutorial.noteKey();
  });
  $('key-close').addEventListener('click', function () {
    keyOpen = false; $('keypanel').hidden = true; $('key-btn').classList.remove('on');
  });

  /* ------------------------------------------------------------ chrome */
  function renderIdentity() {
    $('hud-swatch').style.background = ME.color;
    $('hud-name').textContent = ME.name;
    $('hud-role').textContent = ME.role + ' · ' + ME.calling + ' · ' + ME.companyName;
  }

  function renderHud() {
    let w = '';
    for (let i = 0; i < ME.words; i++) {
      w += '<i class="word ' + (i < ME.words - ME.wordsSpent ? 'on' : 'spent') + '"></i>';
    }
    $('hud-words').innerHTML = w;
    let r = '';
    for (let i = 0; i < ME.resolve; i++) r += '<i class="' + (i < ME.resolveUsed ? 'spent' : '') + '"></i>';
    $('hud-resolve').innerHTML = r;
    const mv = $('hud-move');
    mv.textContent = ME.moveLeft + '/' + ME.move;
    mv.classList.toggle('none', ME.moveLeft === 0);
    const st = ME.stats || {};
    $('hud-stats').innerHTML = ['arms', 'talk', 'land', 'word'].map(function (k) {
      return '<span class="stat"><b>' + k.toUpperCase().slice(0, 1) + '</b>' + (st[k] || 0) + '</span>';
    }).join('');
    const items = ME.items || [];
    $('hud-kit').innerHTML = items.length
      ? items.map(function (i) { return '<span class="kit" title="' + i.blurb + '">' + i.name + '</span>'; }).join('')
      : '';
    $('hud-kit').hidden = !items.length;
  }

  function renderActions() {
    if (!ME) return;
    const acts = (WORLD && WORLD.turnOpen && !ME.declared) ? (ME.actions || []) : [];
    if (!acts.length) {
      $('acts').innerHTML = '';
      return;
    }
    $('acts').innerHTML = acts.map(function (a) {
      return '<button class="act ' + (a.promoted ? 'promoted' : '') + '" data-act="' + a.id + '">' +
        '<span class="a-top"><span class="a-verb">' + a.verb + '</span>' +
        (a.gate ? '<span class="a-gate">' + a.gate + '</span>' : '') + '</span>' +
        '<span class="a-label">' + a.label + '</span>' +
        '<span class="a-detail">' + (a.detail || '') + '</span></button>';
    }).join('');
  }

  function renderTurn() {
    const seg = WORLD.segment;

    if (WORLD.turnOpen) {
      $('scrim').hidden = true;
      $('turnbar').hidden = false;
      $('tb-label').textContent = seg.label;
      const c = $('tb-count');
      c.textContent = mmss(WORLD.remaining);
      c.classList.toggle('low', WORLD.remaining <= 10);
      /* Declaring locks the verbs but NOT movement — deciding early must never
       * park a student. See the idle floor in design/08-rule-schema.md. */
      /* acted, not declared: with an uncapped window a student may take
       * another action, and telling them they are finished when they are not
       * is worse than saying nothing. */
      $('tb-hint').textContent = ME.declared
        ? (ME.moveLeft > 0
            ? 'You chose ' + ME.verb + '. You can still move — ' + ME.moveLeft + ' left.'
            : 'You chose ' + ME.verb + '. Watch the board.')
        : ME.acted
          ? (ME.moveLeft > 0
              ? 'You have gone once. You can move and go again — ' + ME.moveLeft + ' movement left.'
              : 'You have gone once. Keep going while the clock runs.')
          : (ME.moveLeft > 0 ? 'Tap a hex to move. Then choose what you do.' : 'Choose what you do.');
      return;
    }

    $('turnbar').hidden = true;
    $('scrim').hidden = false;

    /* THE COLD OPEN IS NOT A WAITING ROOM.
     *
     * For four minutes at the top of the lesson this screen said "Watch the
     * board" over an opaque sheet, while the projector played the best thing
     * in the whole session — the map of the colony, Ugartechea's demand for
     * the cannon, and the line "he is entitled to it".
     *
     * A class said the game felt like a textbook. Four minutes of a blanked
     * device at the very start is the least game-like thing it does.
     *
     * So during the cold open the sheet goes clear: the student stands in
     * Gonzales, lit for the hour, and watches their classmates arrive in it
     * while the story plays at the front. Nothing is tappable — the turn is
     * closed, so reachSet is empty and every tap already does nothing — which
     * keeps "eyes up front" intact. Presence, not permission. */
    const cinematic = WORLD.started && WORLD.running &&
                      seg && seg.kind === 'sequence';
    $('scrim').classList.toggle('clear', !!cinematic);
    if (cinematic) {
      $('scrim-kicker').textContent = seg.eyebrow || 'COLD OPEN';
      $('scrim-title').textContent = placeAndDate();
      $('scrim-note').textContent = '';
      return;
    }

    if (!WORLD.started) {
      $('scrim-kicker').textContent = 'NOT YET';
      $('scrim-title').textContent = 'Wait for your teacher.';
    } else if (!WORLD.running) {
      $('scrim-kicker').textContent = 'HOLD';
      $('scrim-title').textContent = 'Eyes up front.';
    } else {
      $('scrim-kicker').textContent = (seg && (seg.label || seg.eyebrow)) || 'STAND BY';
      $('scrim-title').textContent =
        !seg ? 'Watch the board.'
        : seg.kind === 'read' ? 'Listen.'
        : seg.kind === 'tally' ? 'Hands up when your letter is called.'
        : 'Watch the board.';
    }
  }

  /* ------------------------------------------------------------ commit */
  document.addEventListener('click', function (e) {
    const b = e.target.closest ? e.target.closest('[data-act]') : null;
    if (b) arm(b.getAttribute('data-act'));
  });
  $('c-cancel').addEventListener('click', function () { armed = null; $('commit').hidden = true; });
  $('c-do').addEventListener('click', function () {
    if (!armed) return;
    /* Never let a student spend their one action into a dead socket. The dice
     * are rolled server-side, so an unsent action is not a delayed action — it
     * simply never happened, and they have to be told before they believe
     * otherwise and start arguing with the board. */
    if (!canAct()) {
      showOffline(false, 'Waiting for the classroom server. Your turn is safe — try again in a moment.');
      return;
    }
    const id = armed;
    armed = null;
    $('commit').hidden = true;
    doAct(id);                                   // the server rolls and decides
  });
  $('oc-close').addEventListener('click', function () {
    $('outcome').hidden = true;
    if (window.Narrator) Narrator.stop();
  });

  function arm(id) {
    const a = (ME.actions || []).filter(function (x) { return x.id === id; })[0];
    if (!a) return;
    armed = id;
    $('c-kicker').textContent = a.verb + (a.gate ? ' · ' + a.gate : '');
    $('c-text').textContent = a.label;
    $('commit').hidden = false;
  }

  /* ------------------------------------------------------------ outcome
   *
   * The payoff screen. design/02: on a 6- you GAVE GROUND *and you still learn
   * something true* — so the fact plate is drawn on every tier, and the caption
   * says plainly that a bad roll would have taught it too. */
  const PIPS = {
    1: [[.5, .5]], 2: [[.28, .28], [.72, .72]], 3: [[.26, .26], [.5, .5], [.74, .74]],
    4: [[.28, .28], [.72, .28], [.28, .72], [.72, .72]],
    5: [[.27, .27], [.73, .27], [.5, .5], [.27, .73], [.73, .73]],
    6: [[.28, .24], [.72, .24], [.28, .5], [.72, .5], [.28, .76], [.72, .76]],
  };
  function drawDie(svg, n) {
    svg.innerHTML = '<rect x="1.4" y="1.4" width="45.2" height="45.2" rx="6.5" fill="#F2F3EE" ' +
      'stroke="#4A5B63" stroke-width="1.7"/>' +
      (PIPS[n] || []).map(function (p) {
        return '<circle cx="' + (p[0] * 48).toFixed(1) + '" cy="' + (p[1] * 48).toFixed(1) +
          '" r="4.1" fill="#1B2A33"/>';
      }).join('');
  }

  const TIER = {
    strong:  'HELD',
    partial: 'HELD AT A COST',
    weak:    'GAVE GROUND',
  };

  let shownOutcome = null;
  function showOutcome(o) {
    if (!o || shownOutcome === o.label + o.narrate) return;
    shownOutcome = o.label + o.narrate;

    const roll = $('oc-roll');
    if (o.d1) {
      roll.hidden = false;
      drawDie($('oc-d1'), o.d1);
      drawDie($('oc-d2'), o.d2);
      $('oc-math').textContent = o.d1 + ' + ' + o.d2 + '  +  ' + o.bonus + ' ' + (o.stat || '').toUpperCase();
      $('oc-total').textContent = o.total;
    } else {
      roll.hidden = true;
    }

    $('oc-tier').textContent = o.tier ? TIER[o.tier] : (o.verb || '');
    $('oc-text').textContent = o.narrate || '';

    /* What just happened to YOU, out loud, if you asked for that. The fact
     * plate follows it, because design/02 says a 6- still teaches you something
     * true and that sentence is the one that must not be missed. */
    if (readAloud && window.Narrator) {
      Narrator.say({ speaker: o.speaker || 'NARRATOR', text: o.narrate || '' });
      if (o.taught && o.taught.length) {
        const said = o.taught.map(function (f) { return f.statement; }).join(' ');
        setTimeout(function () {
          if (readAloud) Narrator.say({ speaker: 'HISTORIAN', text: said });
        }, Math.min(14000, 380 * String(o.narrate || '').split(' ').length));
      }
    }

    const learn = $('oc-learn');
    if (o.taught && o.taught.length) {
      learn.hidden = false;
      $('oc-learn-body').textContent = o.taught.map(function (f) { return f.statement; }).join(' ');

      /* THE RECEIPT.
       *
       * The line under this panel says "this is true, and it is in the record",
       * which until now was a claim with nothing behind it. Some facts rest on
       * a document the student is holding — so offer it, by name, right at the
       * moment they have a reason to care.
       *
       * Only when they actually have it. Naming a document a student cannot
       * open is worse than saying nothing, and the shelf is filled by the
       * lesson rather than by this. */
      const doc = $('oc-doc');
      if (doc) {
        const id = (o.taught.filter(function (f) { return f.handout; })[0] || {}).handout;
        const have = id && window.Docs && Docs.mine.indexOf(id) !== -1;
        doc.hidden = !have;
        if (have) {
          doc.setAttribute('data-doc', id);
          $('oc-doc-t').textContent = 'READ ' + Docs.titleOf(id).toUpperCase();
        }
      }
    } else {
      learn.hidden = true;
      if ($('oc-doc')) $('oc-doc').hidden = true;
    }

    const earn = $('oc-earn');
    const bits = (o.flags || []).map(function (f) { return '<span>✦ ' + f.replace(/_/g, ' ') + '</span>'; });
    if (o.legacy) bits.push('<span>+' + o.legacy + ' LEGACY</span>');
    earn.hidden = !bits.length;
    earn.innerHTML = bits.join('');

    $('outcome').hidden = false;
  }

  function mmss(sec) {
    sec = Math.max(0, Math.ceil(sec));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }

  /* ------------------------------------------------------------ the agent seam
   *
   * NOT debug scaffolding. design/16-build-order.md makes the software its own
   * test harness because no class is available until the whole thing is built,
   * so a machine has to be able to play this. Everything here goes through the
   * same server calls a tapping finger does — a bot cannot cheat either. */
  /* What the tutorial is handed. Deliberately small: the maps it may draw, the
   * two render entry points, and a way to give the screen back. */
  window.PlayStage = {
    maps: function () { return MAPS; },
    you: function () { return ME; },
    world: function () { return WORLD; },
    applyYou: applyYou,
    applyState: applyState,
    usePlace: usePlace,
    take: function (sim) { SIM = sim; },
    release: function () {
      SIM = null;
      /* BOTH halves, or the lock screen stays hidden behind a turn window
       * that the tutorial invented and the server has never heard of. */
      if (lastServerWorld) applyState(lastServerWorld);
      if (lastServerYou) applyYou(lastServerYou);
      Net.ping().then(function (r) { if (r && r.you) applyYou(r.you); });
    },
    get simulated() { return !!SIM; },
  };

  window.PlayAgent = {
    get ready() { return !!ME; },
    get me() { return ME && { id: ME.characterId, name: ME.name, calling: ME.calling, move: ME.move }; },
    get place() { return ME && { id: ME.place, title: ME.placeTitle, indoors: ME.indoors,
                                 portal: ME.portal, light: ME.light }; },
    key: function () { return MAP ? MAP.legendUsed() : []; },
    npcs: function () { return (ME && ME.npcs) ? ME.npcs.slice() : []; },
    enter: function (featureId) { return doEnter(featureId); },
    readAloud: function (on) {
      if (on !== undefined && on !== readAloud) $('readme').click();
      return readAloud;
    },
    narration: function () {
      return window.Narrator ? {
        ready: Narrator.ready(), describes: Narrator.describe(),
        rendered: !!(ME && ME.lastOutcome &&
          Narrator.rendered({ speaker: 'NARRATOR', text: ME.lastOutcome.narrate })),
      } : null;
    },
    get state() {
      return ME && { hex: ME.hex, moveLeft: ME.moveLeft, declared: ME.declared, verb: ME.verb,
                     wordsSpent: ME.wordsSpent, legacy: ME.legacy,
                     open: !!(WORLD && WORLD.turnOpen) };
    },
    options: function () { return ME ? ME.reach.slice() : []; },
    actions: function () { return ME && ME.actions ? ME.actions.slice() : []; },
    outcome: function () { return ME ? ME.lastOutcome : null; },
    owed: function () { return ME ? ME.owed : null; },
    choose: function (id) { return Net.join(id); },
    moveTo: function (hex) { return doMove(hex); },
    use: function (actionId) { return doAct(actionId); },
  };
})();
