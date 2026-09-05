/* tutorial.js — five minutes, alone, before the lesson starts.
 *
 *     SCRIPTED   the same nine steps in the same order, every time
 *     SELF-PACED nothing advances on a timer; it advances when you do the thing
 *     SOLO       entirely in this browser. It never touches the server, so
 *                thirty students running it at once costs the classroom nothing
 *                and none of it can reach the real period.
 *
 * WHY IT DRIVES THE REAL SCREEN
 *
 * It borrows the actual canvas, the actual action cards, the actual commit
 * sheet and the actual outcome sheet through window.PlayStage. A mock tutorial
 * is a promise to keep two interfaces in step forever and nobody keeps that
 * promise: the day somebody redesigns the outcome card, a mock starts teaching
 * a screen that does not exist. There is one screen. Either the server drives
 * it or this does.
 *
 * WHEN IT RUNS
 *
 * Automatically the first time a student picks their name, IF the period has
 * not started — which is exactly the dead time it is designed for, while the
 * teacher is still getting thirty Chromebooks open. If the class is already
 * running, it does not steal the screen; it waits behind a button. And if the
 * teacher presses start in the middle of it, it gets out of the way at once.
 * The lesson beats the tutorial, always.
 *
 * WHAT IT TEACHES, in order, and nothing else:
 *   1  which token is you
 *   2  tap a hex to walk, and every step costs
 *   3  you cannot walk through people
 *   4  a door with a button is a way in
 *   5  inside is yours alone
 *   6  searching costs your turn, and things you find change your numbers
 *   7  two dice plus one of your numbers
 *   8  A BAD ROLL STILL TEACHES YOU SOMETHING TRUE   <-- the one that matters
 *   9  the map key, and what the lock screen means
 */

const Tutorial = (function () {
  const $ = function (id) { return document.getElementById(id); };

  const DONE_KEY = 'gonzales-tutorial-done';
  let step = 0;
  let state = null;          // our own private ME-shaped object
  let world = null;          // our own private WORLD-shaped object
  let running = false;
  let onEnd = null;
  let maps = null;
  let extras = [];           // the fake classmates we stand in the way
  let spoken = -1;           // the last step read out, so it is not repeated

  /* --------------------------------------------------------------- content
   *
   * The two facts below are the two most important ideas in Session 1, and a
   * student meets them here before the lesson starts. They are TRUE, and they
   * are the same statements the real session teaches — hearing them twice is
   * reinforcement, not confusion. The chrome says PRACTICE the whole way
   * through so nobody thinks this counts for anything. */
  /* The two facts a student meets here. Both TRUE, both the same statements
   * the real session teaches, so hearing them twice is reinforcement. The
   * chrome says PRACTICE the whole way through, so nothing here reads as
   * something that counted. */
  const OWNS = { statement: 'The cannon really does belong to the Mexican government. Gonzales was lent it in 1831 to fight Comanche raids, on the written condition that it went back when the government asked for it.' };
  const FAR = { statement: 'Béxar is seventy miles west. Four days by oxcart, two by fast horse. Everything that happens here happens at that distance.' };
  const LEGAL = { statement: 'Ugartechea is not doing anything illegal. The cannon is government property and he has asked for it back in writing. That is the whole problem.' };

  /* WHERE EACH TRADE PRACTISES, AND WHAT THEY ROLL.
   * door/place/entry/counter/chest come straight from the real map files —
   * nothing here is a second copy of the world. */
  const BY_CALLING = {
    SMITH: {
      door: 'DOOR_FORGE', at: 'J9', place: 'forge', land: 'C4', counter: 'E3',
      chest: 'CHEST_FORGE_BENCH', where: 'the forge',
      stat: 'arms',
      label: 'Look over the cannon carriage. It has been rotting for four years.',
      detail: 'Nobody else in this town can tell them what it needs.',
      narrate: 'The trucks are gone soft and the iron is pitted. You could make it roll again. You would need two days and somebody to work the bellows.',
      fact: OWNS,
    },
    RIFLEMAN: {
      door: 'DOOR_STORE', at: 'N5', place: 'zumwalt_store', land: 'C5', counter: 'C2',
      chest: 'CHEST_BEHIND_COUNTER', where: "Zumwalt's store",
      stat: 'arms',
      label: 'Count how many men in this square could actually shoot.',
      detail: 'Owning a rifle and being able to use it are different things.',
      narrate: 'Fewer than the square looks like. Plenty of rifles, and a lot of them have not been fired since the spring.',
      fact: OWNS,
    },
    TRADER: {
      door: 'DOOR_STORE', at: 'N5', place: 'zumwalt_store', land: 'C5', counter: 'C3',
      chest: 'CHEST_LEDGER', where: "Zumwalt's store",
      stat: 'talk',
      label: 'Ask around the square what the letter from Béxar says.',
      detail: 'People are talking about it. Nobody will say it plainly.',
      narrate: 'Nobody will put it in plain words. But everybody here already knows what the colonel wants, and it is thirty feet away under a tarpaulin.',
      fact: OWNS,
    },
    HEALER: {
      door: 'DOOR_STORE', at: 'N5', place: 'zumwalt_store', land: 'C5', counter: 'C2',
      chest: 'CHEST_BEHIND_COUNTER', where: "Zumwalt's store",
      stat: 'talk',
      label: 'Find out who in this town is already sick or hurt.',
      detail: 'If it comes to anything, you will be the one they carry them to.',
      narrate: 'Two children with fever on Water Street and a man with a bad hand at the forge. You will remember both.',
      fact: OWNS,
    },
    HOUSEHOLDER: {
      door: 'DOOR_STORE', at: 'N5', place: 'zumwalt_store', land: 'C5', counter: 'C3',
      chest: 'CHEST_LEDGER', where: "Zumwalt's store",
      stat: 'talk',
      label: 'Ask who is going to be left holding this town.',
      detail: 'If the men ride out, somebody stays. Somebody always stays.',
      narrate: 'Nobody wants to answer that in the open. You get enough looks to know the answer is mostly women.',
      fact: OWNS,
    },
    CLERK: {
      door: 'DOOR_PONTON', at: 'I5', place: 'ponton_house', land: 'D5', counter: 'B3',
      chest: 'CHEST_PONTON_TABLE', where: "the alcalde's house",
      stat: 'word',
      label: 'Read the colony grant and see what it actually says.',
      detail: 'Somebody in this town should know before it decides anything.',
      narrate: 'It is all there, in a hand you can read. Every family swore an oath, and the terms of it are not vague.',
      fact: FAR,
    },
    RANCHERO: {
      door: 'DOOR_HOTEL', at: 'O8', place: 'hotel', land: 'D5', counter: 'C4',
      chest: 'CHEST_SADDLEBAGS', where: 'the hotel',
      stat: 'land',
      label: 'Ride out the west road and see how far you can see.',
      detail: 'You know this country better than anybody in the square.',
      narrate: 'Nothing on the road today. But you can see a long way west from the rise, and you know exactly how long a rider takes to cross it.',
      fact: FAR,
    },
    RIDER: {
      door: 'DOOR_HOTEL', at: 'O8', place: 'hotel', land: 'D5', counter: 'C4',
      chest: 'CHEST_SADDLEBAGS', where: 'the hotel',
      stat: 'land',
      label: 'Work out the road to Béxar in your head.',
      detail: 'You are the one they will send. You should know the number.',
      narrate: 'Two days if you push, and you would arrive on a spent horse. Four with a cart, and everybody knows it.',
      fact: FAR,
    },
  };

  function mine() {
    return BY_CALLING[(state && state.calling) || ''] || BY_CALLING.TRADER;
  }

  /* Dice that land in the tier this step is demonstrating, given the
   * student's REAL bonus. The arithmetic printed on the card is therefore
   * true — 3 + 2 + 3 ARMS really is 8, and 8 really is HELD AT A COST. */
  function diceFor(tier, bonus) {
    const aim = tier === 'partial' ? 8 : 4;
    const sum = Math.max(2, Math.min(12, aim - bonus));
    const d1 = Math.max(1, Math.min(6, Math.ceil(sum / 2)));
    return [d1, Math.max(1, Math.min(6, sum - d1))];
  }

  function practice(kind) {
    const m = mine();
    const bonus = (state.stats && state.stats[kind === 'own' ? m.stat : 'word']) || 0;
    if (kind === 'own') {
      const roll = diceFor('partial', bonus);
      return { id: 'T_OWN', verb: 'SEEK', gate: 'PRACTICE',
               label: m.label, detail: m.detail,
               roll: roll, bonus: bonus, stat: m.stat, tier: 'partial',
               narrate: m.narrate, taught: [m.fact] };
    }
    const roll = diceFor('weak', bonus);
    return { id: 'T_LAW', verb: 'SEEK', gate: 'PRACTICE',
             label: 'Work out whether the colonel is allowed to do this.',
             detail: 'Somebody should check before the town decides anything.',
             roll: roll, bonus: bonus, stat: 'word', tier: 'weak',
             narrate: 'You get nowhere. Half the people you ask have never read the grant, and the half who have will not be drawn on it.',
             taught: [LEGAL] };
  }

  const PRACTICE_ACTIONS = {
    get T_OWN() { return practice('own'); },
    get T_LAW() { return practice('law'); },
  };

  /* FOUR STEPS.
   *
   * There were ten, and a class played it and could not work out how to play.
   * Of course they could not: it taught identity, walking, obstacles, doors,
   * private maps, searching, dice, failure, the map key and the lock — ten
   * concepts in three minutes, before a child had any reason to care about a
   * single one of them. That is a manual with a Next button.
   *
   * These are the three things you cannot play without, each learned by doing
   * it once, plus the sentence that is the whole point of the game. Everything
   * dropped is now taught by the interface at the moment it matters, which is
   * both shorter and better:
   *
   *   who you are        the HUD has your name and role in it
   *   you cannot walk    the map dims everywhere out of reach; people are
   *   through people     drawn standing in the way
   *   doors              a green button appears saying "Go inside", but only
   *                      when you are standing in a doorway
   *   your own map       discovered by walking through a door
   *   the dice           the outcome sheet rolls them in front of you
   *   the map key        is a button that says MAP KEY
   *
   * Keep this under fifty words. tools/reading-first-ten.mjs counts it. */
  const STEPS = [
    {
      id: 'walk',
      say: 'Tap the ring.',
      point: { at: 'tb-move', title: 'YOUR STEPS',
               text: 'One dot per step. The bright part of the map is how far they go.' },
      want: { move: 'K6' },
    },
    {
      id: 'act',
      say: 'Now do something. Pick a card.',
      point: { at: 'acts', title: 'YOUR TURN',
               text: 'These change with where you stand.' },
      want: { act: 'T_OWN' },
      pool: ['T_OWN'],
    },
    {
      id: 'bad',
      say: 'One more. This one goes wrong.',
      want: { act: 'T_LAW' },
      pool: ['T_LAW'],
    },
    {
      id: 'end',
      say: 'It went wrong and you learned something anyway. That always happens.',
      next: 'Play',
      last: true,
    },
  ];

  /* ---------------------------------------------------------------- state */

  /* Their REAL character, on the real map, on a day when nothing has happened
   * yet. 29 September 1835: the letter from Béxar has not arrived. Nothing in
   * this tutorial is a historical event, because inventing one to practise on
   * would be the one thing this project does not do. */
  function build(me) {
    const roster = window.__tutorRoster || [];
    const others = roster.filter(function (p) { return p.id !== me.characterId; });
    extras = [
      { name: (others[0] || { name: 'A neighbour' }).name, color: (others[0] || {}).color || '#39646B', hex: 'L6' },
      { name: (others[1] || { name: 'A neighbour' }).name, color: (others[1] || {}).color || '#8A6534', hex: 'M6' },
    ];

    state = {
      characterId: me.characterId,
      name: me.name, role: me.role, calling: me.calling,
      companyName: me.companyName, color: me.color,
      ability: me.ability, abilityBlurb: me.abilityBlurb,
      place: 'gonzales_town', placeTitle: 'Gonzales, DeWitt Colony', indoors: false,
      hex: 'L5',
      move: Math.max(3, me.move || 3), moveLeft: Math.max(3, me.move || 3),
      words: me.words || 2, wordsSpent: 0,
      resolve: me.resolve || 4, resolveUsed: 0,
      legacy: 0, declared: false, verb: null, actionsLeft: 0,
      stats: Object.assign({ arms: 0, talk: 0, land: 0, word: 0 }, me.stats || {}),
      items: [],
      features: null,         // filled from the map each render
      npcs: [{ id: 'NPC_PONTON', name: 'Alcalde Andrew Ponton', hex: 'K6' }],
      reach: [], actions: [], lastOutcome: null,
      taught: [], flags: [], owed: 0,
      portal: null,
      light: { phase: 'AFTERNOON', weather: 'CLEAR', date: '1835-09-29',
               clock: 'the afternoon before any of it started' },
      searched: {},
      opened: { DOOR_PONTON: true },
    };

    world = {
      started: true, running: true, turnOpen: true, remaining: 300,
      segment: { kind: 'beat', label: 'PRACTICE', window: true },
      students: [],
      light: state.light,
    };
    recompute();
  }

  function currentMap() { return maps[state.place]; }

  /* Ask the map something with the PRACTICE world's doors in place, then put
   * the map back exactly as it was. Every reachability question goes through
   * here — there is no second way to ask. */
  function withDoors(mp, fn) {
    const restore = [];
    (mp.features || []).forEach(function (f) {
      if (state.opened[f.id] === undefined || f.open === state.opened[f.id]) return;
      restore.push([f, f.open]);
      f.open = state.opened[f.id];    // the one place that WRITES it, briefly
    });
    try { return fn(); }
    finally { restore.forEach(function (p) { p[0].open = p[1]; }); }
  }

  /* Is this door open, in the practice world? The ONLY answer to that
   * question. state.opened overrides the real map, because Ponton's door is
   * shut while he writes and on the afternoon before the letter came he is not
   * writing anything. */
  function isOpen(f) {
    if (!f) return false;
    return state.opened[f.id] !== undefined ? state.opened[f.id] : f.open;
  }

  function occupiedNow() {
    return world.students.map(function (s) { return s.hex; });
  }

  function reachNow(mp, points) {
    return withDoors(mp, function () {
      return mp.reachable(state.hex, points, { occupied: occupiedNow() });
    });
  }

  /* Everything derived: what we can reach, what we can do, where the fake
   * classmates are, and whether we are standing on a way through. */
  function recompute() {
    const mp = currentMap();
    if (!mp) return;
    state.placeTitle = mp.title;
    state.indoors = !!mp.indoors;

    state.features = (mp.features || []).map(function (f) {
      /* Ponton's door is shut while he writes. He is not writing yet — this is
       * the afternoon before the letter came — so in practice it is open. */
      return { id: f.id, kind: f.kind, hex: f.hex, label: f.label, to: f.to || null,
               open: isOpen(f), searched: !!state.searched[f.id] };
    });

    /* the two neighbours only exist out in the square */
    const here = extras.filter(function () { return state.place === 'gonzales_town'; });
    world.students = here.map(function (x, i) {
      return { characterId: 'tut' + i, name: x.name, color: x.color,
               hex: x.hex, place: 'gonzales_town', declared: false, anchor: null };
    });

    const want = wantOf(STEPS[step]) || {};
    const stillWalking = !!want.move && state.hex !== want.move;
    const inReach = function (r, hex) {
      const h = mp.parse(hex);
      return !!h && r[h.c + ',' + h.r] !== undefined;
    };
    let reach = state.moveLeft > 0 ? reachNow(mp, state.moveLeft) : {};
    if (stillWalking && !inReach(reach, want.move) && state.moveLeft < state.move) {
      state.moveLeft = state.move;
      reach = reachNow(mp, state.moveLeft);
    }
    state.reach = Object.keys(reach).map(function (k) {
      const p = k.split(',').map(Number);
      return { hex: mp.label(p[0], p[1]), cost: reach[k] };
    });

    /* the hex this step is asking for, drawn as a ring on the map */
    state.target = (want.move && state.hex !== want.move) ? want.move : null;

    const portal = mp.portalAt(state.hex);
    state.portal = (portal && isOpen(portal) !== false && state.moveLeft > 0) ? {
      id: portal.id, label: portal.to.label || 'Go through',
      into: (maps[portal.to.place] || {}).title || portal.to.place,
      out: !!(maps[portal.to.place] && !maps[portal.to.place].indoors),
    } : null;

    /* the offer list: whatever this step wants, plus anything searchable next
     * to us, so the pool a student sees is built the same way the real one is */
    const list = [];
    const st = STEPS[step] || {};
    (st.pool || []).forEach(function (id) { list.push(PRACTICE_ACTIONS[id]); });
    const at = mp.parse(state.hex);
    const near = [state.hex].concat(
      (at ? mp.neighbours(at.c, at.r) : []).map(function (n) { return mp.label(n.c, n.r); }));
    near.forEach(function (hx) {
      mp.featuresAt(hx).forEach(function (f) {
        if (f.kind !== 'chest' || state.searched[f.id]) return;
        list.push({ id: 'LOOT:' + f.id, verb: 'SEEK', gate: 'PRACTICE',
                    label: f.searchLabel || ('Search ' + f.label.toLowerCase() + '.'),
                    detail: f.note || '' });
      });
    });
    state.actions = list;
  }

  function paint() {
    recompute();
    window.PlayStage.usePlace(state.place);
    window.PlayStage.applyState(world);
    window.PlayStage.applyYou(state);
    renderBar();
  }

  /* ---------------------------------------------------------------- intents
   * The same three the server answers. Every rule the real server enforces is
   * enforced here too — you cannot step on somebody, you cannot walk through a
   * shut door, you cannot search a thing twice — because a tutorial that lets
   * you do something the game forbids has taught you the wrong game. */
  const sim = {
    move: function (hex) {
      const mp = currentMap();
      const target = mp.parse(hex);
      if (!target) return;
      const reach = reachNow(mp, state.moveLeft);
      const cost = reach[target.c + ',' + target.r];
      if (cost === undefined) return;
      state.moveLeft -= cost;
      state.hex = hex;
      /* the refill lives in recompute(), which can see whether there is
       * anywhere left to walk */
      paint();
      check();
    },

    enter: function (featureId) {
      const mp = currentMap();
      const f = mp.feature(featureId);
      if (!f || !f.to || !maps[f.to.place]) return;
      if (state.hex !== f.hex) return;
      if (isOpen(f) === false) return;
      state.place = f.to.place;
      state.hex = f.to.hex;
      state.moveLeft = state.move;
      paint();
      check();
    },

    act: function (actionId) {
      const a = (state.actions || []).filter(function (x) { return x.id === actionId; })[0];
      if (!a) return;
      doneActions[actionId] = true;

      if (actionId.indexOf('LOOT:') === 0) {
        const mp = currentMap();
        const f = mp.feature(actionId.slice(5));
        if (!f || state.searched[f.id]) return;
        state.searched[f.id] = true;
        const names = [];
        (f.contents || []).forEach(function (id) {
          const it = mp.item(id) || itemAnywhere(id);
          if (!it) return;
          names.push(it.name);
          state.items.push(it);
          if (it.effect && it.effect.stat) {
            Object.keys(it.effect.stat).forEach(function (k) {
              state.stats[k] = (state.stats[k] || 0) + it.effect.stat[k];
            });
          }
          if (it.effect && it.effect.move) { state.move += it.effect.move; state.moveLeft += it.effect.move; }
        });
        state.lastOutcome = {
          label: a.label, verb: 'SEEK',
          narrate: names.length ? 'You go through it. ' + names.join(', and ') + '.'
                                : 'Somebody has already been through this.',
          legacy: 1, flags: [],
        };
        state.moveLeft = 0;      // searching costs the turn, and it must LOOK like it
        paint();
        check();
        return;
      }

      /* a scripted roll. Real pips, real arithmetic, a decided result. */
      state.lastOutcome = {
        label: a.label, verb: a.verb,
        d1: a.roll[0], d2: a.roll[1], bonus: a.bonus, stat: a.stat,
        total: a.roll[0] + a.roll[1] + a.bonus,
        tier: a.tier, narrate: a.narrate, taught: a.taught, flags: [], legacy: 0,
      };
      paint();
      check();
    },

    /* The server is still talking while we have the screen. We ignore its
     * view of this student, but not its view of the CLOCK: the moment the
     * teacher starts the period, the tutorial gets out of the way. */
    serverYou: function () {},
    serverState: function (s) {
      if (s && s.turnOpen) finish(true);
    },
  };

  function itemAnywhere(id) {
    let found = null;
    Object.keys(maps).forEach(function (k) { found = found || maps[k].item(id); });
    return found;
  }

  /* ------------------------------------------------------------ the script
   * One predicate per kind of thing a step can wait for. A step that wants a
   * walk AND then an action (step 6 — get to the counter, then open the
   * ledger) is the only compound case, and it reads as one. */
  const doneActions = {};
  function wasDone(id) { return !!doneActions[id]; }

  /* want and hint may be functions of the character, so ask once */
  function wantOf(st) {
    if (!st) return null;
    return typeof st.want === 'function' ? st.want() : st.want;
  }
  function hintOf(st) {
    if (!st || !st.hint) return '';
    return typeof st.hint === 'function' ? st.hint(state) : st.hint;
  }

  function satisfied(w) {
    if (!w) return false;
    if (w.key) { const k = $('keypanel'); return !!k && !k.hidden; }
    if (w.act) return wasDone(w.act);
    if (w.enter) return state.place !== 'gonzales_town';
    if (w.move) {
      if (state.hex !== w.move) return false;
      if (w.then && w.then.act) return wasDone(w.then.act);
      return true;
    }
    return false;
  }

  function check() {
    if (satisfied(wantOf(STEPS[step]))) advance(true);
    else renderBar();
  }

  function advance(force) {
    /* A step with something to DO is not skippable by pressing a button —
     * only the read-and-continue steps offer one, and SKIP is the way out. */
    const w = wantOf(STEPS[step]);
    if (!force && w && !satisfied(w)) return;
    step += 1;
    if (step >= STEPS.length) { finish(false); return; }
    paint();
  }

  /* ------------------------------------------------------------- the chrome
   * One bar. What to do, how far through you are, and a way out. The progress
   * counter is not decoration: a twelve-year-old who cannot see that this is
   * short and finite will assume it is neither. */
  function renderBar() {
    const bar = $('tut');
    if (!bar) return;
    const st = STEPS[step];
    bar.hidden = !running;
    if (!running || !st) return;
    $('tut-count').textContent = (step + 1) + ' of ' + STEPS.length;
    const words = typeof st.say === 'function' ? st.say(state) : st.say;
    $('tut-say').textContent = words;
    /* If a student has asked for things to be read to them, that has to
     * include the instructions — otherwise the one student who most needs the
     * tutorial is the one who cannot use it. */
    if (spoken !== step && window.Narrator && !Narrator.muted) {
      spoken = step;
      const p = st && (typeof st.point === 'function' ? st.point(state) : st.point);
      Narrator.say({ speaker: 'NARRATOR',
                     text: words + ' ' + hintOf(st) + (p && p.text ? ' ' + p.text : '') });
    }
    const hint = hintOf(st);
    $('tut-hint').textContent = hint;
    $('tut-hint').hidden = !hint;

    /* THE POINTER.
     *
     * "Press the green button" is a poor instruction when nothing points at
     * the green button. Where a step names a control, a bubble is anchored to
     * it saying what it is for — and the words come OUT of the hint line
     * rather than being added to it, so the tutorial does not grow. It was
     * measured at 150 words / just over three minutes for a 90-wpm reader and
     * has to stay there.
     *
     * pointAt is re-evaluated every render because a control that is hidden on
     * arrival (the way-in button appears only in a doorway) becomes visible
     * mid-step, and Coach.point refuses a zero-sized box. */
    pointAt(st);
    const nx = $('tut-next');
    nx.hidden = !st.next;
    nx.textContent = st.next || '';
    let dots = '';
    for (let i = 0; i < STEPS.length; i++) dots += '<i class="' + (i <= step ? 'on' : '') + '"></i>';
    $('tut-dots').innerHTML = dots;
  }

  /* Anchor this step's bubble, or clear it. Silent when Coach is absent, so
   * the tutorial still runs if that script fails to load. */
  function pointAt(st) {
    if (!window.Coach) return;
    const p = st && (typeof st.point === 'function' ? st.point(state) : st.point);
    if (!p || !p.at) { Coach.clear(); return; }
    Coach.point(p.at, { title: p.title, text: p.text });
  }

  function finish(interrupted) {
    running = false;
    if (window.Coach) Coach.clear();
    window.PlayStage.take(null);
    try { localStorage.setItem(DONE_KEY, '1'); } catch (e) {}
    const bar = $('tut');
    if (bar) bar.hidden = true;
    $('outcome').hidden = true;
    $('commit').hidden = true;
    $('keypanel').hidden = true;
    $('key-btn').classList.remove('on');
    document.body.classList.remove('practising');
    window.PlayStage.release();
    if (onEnd) onEnd(interrupted);
  }

  return {
    get running() { return running; },
    get done() { try { return localStorage.getItem(DONE_KEY) === '1'; } catch (e) { return false; } },

    /* me   = the server's private view of this student, for their real name,
     *        Calling and numbers
     * mapsById = the hydrated HexMap objects play.js already loaded
     * roster = the public roster, so the neighbours in the way are real
     *          documented people and not invented ones */
    start: function (me, mapsById, roster, done) {
      if (running) return;
      if (!me || !mapsById || !mapsById.gonzales_town) return;
      maps = mapsById;
      window.__tutorRoster = roster || [];
      onEnd = done || null;
      step = 0;
      Object.keys(doneActions).forEach(function (k) { delete doneActions[k]; });
      running = true;
      spoken = -1;
      document.body.classList.add('practising');
      build(me);
      window.PlayStage.take(sim);
      paint();
    },

    stop: function () { if (running) finish(true); },

    /* play.js tells us the key was opened, which is all step 9 waits for */
    noteKey: function () { if (running) check(); },

    advance: function () { advance(false); },
  };
})();

window.Tutorial = Tutorial;
