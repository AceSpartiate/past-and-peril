/* room.js — one class period, server-authoritative.
 *
 * design/09-screens-and-cloud.md: "Server-authoritative everything. A student
 * cannot move further than their points, take an option they don't qualify for,
 * or act while you've hit PAUSE. Never trust the client."
 *
 * So the Timeline lives HERE, not in the console. Consequences that matter:
 *   · a teacher reloading the console does not lose the period
 *   · thirty clients cannot disagree about what beat it is
 *   · a student editing their JS cannot give themselves movement points
 *   · a dead Chromebook rejoins into the true state, not a guess
 *
 * One Room per class code, which is the Durable-Object-per-period shape from
 * design/09 with the cloud taken out. Moving it back is a transport swap. */

const HexMap = require('../app/js/hexmap.js');
const { Bots } = require('./bots.js');
const { Engine } = require('./engine.js');
const Adventure = require('./adventure.js');

const TICK_MS = 250;

class Room {
  /* MOVEMENT, IN THREE NUMBERS.
   *
   * Here rather than buried in a method because these are the balance dials
   * for the whole solo layer, and the next person to want a slower or faster
   * town should find them without reading room.js.
   *
   * The floor a roaming read lifts a stranded student to - once between turn
   * windows, and never above their own budget. */
  static ROAM_FLOOR = 2;
  /* The clamp on an effective budget. Measured against the town map: below 3
   * a third of hexes have nothing in walking range, above 5 nearly half the
   * board is, and a destination stops costing you the alternatives. */
  static MOVE_MIN = 3;
  static MOVE_MAX = 5;

  constructor(code, session, mapData, rosterData, sceneData, factsData, opts) {
    opts = opts || {};
    /* `session` may be one session or the whole campaign. A class that has
     * finished Session 1 opens on Session 2 with its own ledger carried
     * forward — which is the difference between 4th period and 7th period. */
    this.sessions = Array.isArray(session) ? session : [session];
    this.sessionIndex = 0;
    session = this.sessions[0];
    /* Time is injectable so tools/sim-class.js can run a whole 45-minute period
     * in milliseconds, and repeat it for variance. Nothing else uses this. */
    this.now = opts.clock || (() => Date.now());
    this.manual = !!opts.manual;
    this.code = code;
    this.data = session;
    this.segs = session.timeline.slice();
    /* A PLACE IS A MAP. The town is one, Béxar is one, and so is the inside of
     * Ponton's house. Every student stands in exactly one place at a time, and
     * two students in different places see genuinely different worlds on their
     * own screens in the same second. Nothing else in this file needs to know
     * that — it asks mapFor(student) and gets the right world back. */
    /* EACH PERIOD OWNS ITS OWN WORLD.
     *
     * Doors open, chests empty, and bodies get searched — that is state, and it
     * lives on the feature objects. serve.js loads the map documents ONCE and
     * hands the same objects to every Room, so without this clone first period
     * would empty every chest in the building and second period would walk in
     * to find the ledger already read and Ponton's door already open. Nothing
     * would error. It would just quietly be a worse lesson every period of the
     * day. Maps are a few kB; five periods of copies is nothing. */
    this.maps = {};
    const mapDocs = Array.isArray(mapData) ? mapData : [mapData];
    mapDocs.forEach((m) => { this.maps[m.id] = HexMap.make(JSON.parse(JSON.stringify(m))); });
    this.outdoor = mapDocs.filter((m) => !m.indoors)[0] || mapDocs[0];
    this.map = this.maps[this.outdoor.id];        // the default place
    this.rosterData = rosterData;

    /* Features and items live on whichever map declares them, but they are
     * referred to by id from anywhere — a chest inside a house, an action that
     * names it. One index, so a lookup never has to know the place. */
    this._featIx = {};
    this._itemIx = {};
    Object.values(this.maps).forEach((mp) => {
      (mp.features || []).forEach((f) => { this._featIx[f.id] = { f, place: mp.id }; });
      (mp.items || []).forEach((i) => { this._itemIx[i.id] = i; });
    });

    /* The rules engine (design/08), one per authored scene. The timeline's
     * `scene` field selects which is live; entering a segment that names a
     * different scene swaps the pool, resets what each student has used, and
     * moves the NPCs. */
    const scenes = Array.isArray(sceneData) ? sceneData : [sceneData];
    this.engines = {};
    this.scenes = {};
    scenes.forEach((sc) => {
      this.scenes[sc.id] = sc;
      this.engines[sc.id] = new Engine(sc, factsData, this.maps[sc.map] || this.map, opts.common);
    });
    /* Every must_teach fact in the SESSION, not just the live scene. The
     * backstop runs once at the end and has to cover all five scenes; scoping
     * it to whichever scene happened to be current left scenes 1-4 with no
     * safety net at all, which the simulator caught as a widening gap between
     * fast and struggling readers. */
    this.sessionMustTeach = [];
    scenes.forEach((sc) => {
      if (sc.session !== session.session) return;
      (sc.must_teach || []).forEach((f) => {
        if (this.sessionMustTeach.indexOf(f) === -1) this.sessionMustTeach.push(f);
      });
    });

    this.sceneId = scenes[0].id;
    this.engine = this.engines[this.sceneId];
    this.scene = this.scenes[this.sceneId];
    this.world = {};                     // world flags
    this.challengeResults = {};
    this.challengeResult = null;
    this.npcHex = {};
    (this.scene.npcs || []).forEach((n) => { this.npcHex[n.id] = n.hex; });
    this.feed = [];                      // what the console shows, newest first
    this.broadcasts = [];                // what reaches the Stage
    this.spotlighted = {};               // characterId -> true, for the rotation

    this.idx = 0;
    this.elapsed = 0;
    this.extra = 0;
    this.running = false;
    this.started = false;
    this.startedAt = 0;
    this.segStamp = 0;
    this.segmentRevision = 0;
    this.manualRead = false;
    this.lastRoll = null;
    this.outcomeSeq = 0;

    this.clocks = {};
    (session.clocks || []).forEach((c) => { this.clocks[c.id] = Object.assign({}, c); });
    this.ledger = {};
    (session.ledger || []).forEach((l) => { this.ledger[l.id] = Object.assign({}, l); });
    this.tally = {};

    /* How many actions a student may take in one turn window. The paper design
     * assumed one, because writing on a Slate is slow; a tap is not. The right
     * value is a measurement, not a guess — see tools/sim-class.js. */
    /* 0 = no cap, which is what a SELF-PACED path means (design/06). A budget
     * of six was tried and made things worse: students spent it in fifty
     * seconds of a four-minute window and then sat. What limits a student is
     * the pool and the clock, not a counter. */
    this.actionsPerWindow = session.actionsPerWindow !== undefined
      ? session.actionsPerWindow
      : (opts.actionsPerWindow !== undefined ? opts.actionsPerWindow : 0);

    /* THE TOWN IS NOT EMPTY JUST BECAUSE THE CLASS IS SHORT.
     *
     * Twenty-two students in a thirty-name town leaves eight documented people
     * with nobody in the chair. They stand in the square anyway — because a
     * thin board teaches a thin town, and because three actions now turn on
     * finding somebody of a particular trade, and "the only two blacksmiths
     * were absent today" is not a lesson about 1835.
     *
     * WHAT THEY DO: they stand, they drift toward where their trade belongs,
     * they gather where the scene is, and they STOP when a student walks up to
     * them. That is all.
     *
     * WHAT THEY NEVER DO: roll dice, fill a clock, spend a Word, earn Legacy,
     * or learn a fact. The arithmetic of the lesson belongs to the students in
     * the room. A bot that could move the ledger would be the software playing
     * the lesson, and nobody asked it to. */
    /* characterId -> true, per session index. Written on join, never removed.
     * A shut lid is not an absence. */
    this.attended = {};
    /* THE DEBT QUEUE. characterId -> how many invitations they have been
     * offered, how many they let lapse, and when they were last asked. This
     * is the entire selection mechanism: there is no roll anywhere in it. */
    this.asked = {};
    this.refunds = {};
    this.askedAt = {};
    this._lastPostings = null;
    /* id -> the posting as authored, so a student's screen can say what they
     * were asked to do and where. Without this the invitation is a flag and
     * nothing else: a student finishes step one and sees NOTHING telling them
     * to walk south, because step two only appears once they are standing in
     * the orchard. */
    this._postingDefs = {};
    this.standIns = {};        // characterId -> { hex, place }
    this.standInsOn = opts.standIns !== false;
    this.callingCapsOn = opts.callingCaps !== false;
    this.standInStamp = 0;

    this.students = {};        // sid -> student
    this.parked = {};          // characterId -> state left by a previous connection
    this.history = [];         // one entry per completed session
    this.claimed = {};         // characterId -> sid   (one person, one player)
    this.retired = {};         // characterId -> true  (a dead name is never reissued)

    this.subs = new Set();
    this.viewers = 0;          // open Stage/console streams, so the console can
                               // say honestly whether anything is on a projector
    if (!this.manual) this.timer = setInterval(() => this._tick(), TICK_MS);
  }

  /* Move the whole class to the place this scene is set in. Called on every
   * scene change; a no-op when the scene stays in the same town, so students
   * keep whatever room they had walked into. */
  _relocate() {
    const want = this.sceneMapId();
    const dest = this.maps[want];
    if (!dest) return;
    /* Somewhere to put thirty people. Flood out from the entry hex and take
     * the first standable ground, so a class arrives spread along the road
     * instead of stacked on one square. Deterministic: same order every time,
     * which matters when a period is restored from disk. */
    /* A SCENE MAY STAGE ITS OWN OPENING POSITION.
     *
     * The map's entry hex is where a class first walks onto that map, and
     * for Béxar that is the Old Mill north of town, which is where the
     * assault really did form up. But a student who has been on this map
     * before goes back to their anchor, so a class returning for the storm
     * of the plaza reassembles wherever they happened to stop last time —
     * scattered along the north edge, eight hexes from the fight, with an
     * effective move of three.
     *
     * A scene that declares its own `entry` overrides both: everybody is
     * staged from that hex, anchors included. It is the difference between
     * a boss the room is standing in and a boss the room is walking to. */
    const spread = [];
    const staged = this.scene && this.scene.entry;
    const seed = dest.parse(staged || dest.data.entry || '');
    if (seed) {
      const seen = { [seed.c + ',' + seed.r]: true };
      const q = [seed];
      while (q.length && spread.length < 64) {
        const cur = q.shift();
        const t = dest.terrain(cur.c, cur.r);
        if (t && t.cost !== null) spread.push(dest.label(cur.c, cur.r));
        dest.neighbours(cur.c, cur.r).forEach((nb) => {
          const k = nb.c + ',' + nb.r;
          if (seen[k]) return;
          seen[k] = true;
          q.push(nb);
        });
      }
    }
    let i = 0;
    const taken = {};
    this._allStudents().forEach((st) => {
      if (this.placeId(st) === want) { taken[st.hex] = true; return; }
      const back = (!staged && st.anchor && st.anchor.place === want) ? st.anchor.hex : null;
      st.place = want;
      st.anchor = null;
      if (back && !taken[back]) { st.hex = back; taken[back] = true; return; }
      /* no doorstep to step back onto: take the next free ground by the entry */
      while (i < spread.length && taken[spread[i]]) i++;
      st.hex = spread[i] || dest.data.entry || st.hex;
      taken[st.hex] = true;
      i++;
    });
  }

  /* --------------------------------------------------------------- absence
   *
   * A STUDENT WHO WAS NOT HERE MUST NOT BE PERMANENTLY BEHIND.
   *
   * design/08 already promises THE FACTS ARE FREE — no student can fail their
   * way out of the content. Being off sick is just another way of not rolling
   * well, so the same promise applies: whatever the class was required to learn
   * while they were away, they are GIVEN, marked as caught up rather than
   * found, so the coverage report stays honest about how it arrived.
   *
   * Legacy is NOT given. That is earned at the table and a student who was not
   * at the table did not earn it. The catch-up says so.
   *
   * Detected here, automatically, the moment they tap their name. The teacher
   * does nothing and is told afterwards. */
  missedSessions(characterId) {
    return (this.history || []).filter((h) => {
      /* `present` is the real record. `students` is the older, liveness-based
       * one, kept as a fallback so a period saved before this fix still reads
       * sensibly rather than declaring the whole class absent. */
      if (h.present) return h.present.indexOf(characterId) === -1;
      return !(h.students || []).some((s) => s.characterId === characterId);
    });
  }

  /* Which required facts belong to a session, whether or not it is the live
   * one. sessionMustTeach only knows about the session in progress. */
  mustTeachFor(sessionNumber) {
    const out = [];
    Object.values(this.scenes).forEach((sc) => {
      if (sc.session !== sessionNumber) return;
      (sc.must_teach || []).forEach((f) => { if (out.indexOf(f) === -1) out.push(f); });
    });
    return out;
  }

  /* The cards a returning student is shown, and the facts to hand them.
   * Authored history first, then what THIS town did with it. */
  catchUp(characterId, firstToday) {
    const missed = this.missedSessions(characterId);
    const cards = [];
    const facts = [];

    missed.forEach((h) => {
      const data = this.sessions.filter((s) => s.session === h.session)[0];
      const title = data ? data.title : 'Session ' + h.session;
      cards.push({ kind: 'head', title: title,
                   sub: data && data.datestamp ? data.datestamp : null,
                   note: 'You were not here for this.' });
      ((data && data.recap) || []).forEach((line) => cards.push({ kind: 'was', text: line }));

      /* what this town, specifically, did */
      const votes = Object.keys(h.decision || {})
        .filter((k) => k && k !== 'undefined' && h.decision[k] > 0);
      if (votes.length) {
        const total = votes.reduce((a, k) => a + h.decision[k], 0);
        const top = votes.sort((a, b) => h.decision[b] - h.decision[a])[0];
        cards.push({ kind: 'yours',
          text: 'Your class voted, and you were not in the room for it. ' +
                h.decision[top] + ' of ' + total + ' chose ' + top + '.' });
      }
      const spent = Object.values(h.ledger || {}).filter((l) => l.value !== undefined);
      if (spent.length) {
        cards.push({ kind: 'yours',
          text: 'What your town had left: ' +
            spent.map((l) => (l.label || l.id) + ' ' + l.value).join(', ') + '.' });
      }
      if (h.legacy) {
        cards.push({ kind: 'yours',
          text: 'Your class earned ' + h.legacy + ' Legacy between them that day. You did not, because you were not there — that part you cannot catch up, and it is not meant to be caught up.' });
      }
      this.mustTeachFor(h.session).forEach((f) => { if (facts.indexOf(f) === -1) facts.push(f); });
    });

    /* AND LATENESS. Turning up in the tenth minute is a smaller version of the
     * same problem, so it gets a smaller version of the same answer. */
    const doneScenes = [];
    if (this.started && firstToday) {
      for (let i = 0; i < this.idx; i++) {
        const s = this.segs[i];
        if (s && s.scene && doneScenes.indexOf(s.scene) === -1) doneScenes.push(s.scene);
      }
      const live = this._seg();
      const liveScene = live && live.scene;
      doneScenes.filter((id) => id !== liveScene).forEach((id) => {
        const sc = this.scenes[id];
        if (!sc) return;
        cards.push({ kind: 'today', text: 'Today, before you got here: ' + sc.title + '.' });
        (sc.must_teach || []).forEach((f) => { if (facts.indexOf(f) === -1) facts.push(f); });
      });
    }

    if (!cards.length) return null;
    const statements = facts.map((id) => {
      const f = this.engine.facts[id];
      return f ? { id: id, statement: f.statement } : null;
    }).filter(Boolean);
    return { sessions: missed.length, cards: cards, facts: statements };
  }

  /* --------------------------------------------------------------- balance
   *
   * KEEPING THE TRADES SPREAD, WITHOUT EVER TELLING A STUDENT NO FOR GOOD.
   *
   * A student does not pick a Calling — they pick a NAME, and the Calling
   * comes with the person. Nothing stopped the first six students from taking
   * the six traders, and then the class has no smith, no healer, and three
   * authored actions with nobody who can do them.
   *
   * The rule, and it is one line:
   *
   *     cap = ceil(this trade's share of the roster x names taken) + 2
   *
   * Which behaves like this:
   *
   *   · nobody has joined yet    every trade is capped at 2, so the first
   *                              stampede into one trade stops at three
   *   · half the class is in     the caps have grown past what anybody is
   *                              likely to want
   *   · the class is nearly full  every cap has reached the roster's own count,
   *                              so the last student always has their pick
   *
   * So it bites early, when it matters, and lets go later, when it would only
   * be in the way. It can never lock the last student out of the game: at any
   * point the sum of the caps is at least the number of names left.
   *
   * It also does not need to know how big the class is, which is the thing a
   * teacher can never tell it reliably at 8:15 in the morning.
   *
   * What it does NOT do is force anybody to take an unpopular trade. Nothing
   * should. That hole is covered from the other side, by the townsfolk who
   * stand in for whoever nobody picked. Caps stop a pile-up; stand-ins fill a
   * gap. Together they are what "relative balance" means here. */
  callingBalance() {
    const list = this.rosterData.roster || [];
    const total = list.length || 1;
    const claimed = Object.keys(this.claimed).length;
    const byCalling = {};
    list.forEach((p) => {
      const c = (byCalling[p.calling] = byCalling[p.calling] ||
        { calling: p.calling, roster: 0, taken: 0, cap: 0, open: 0 });
      c.roster += 1;
      if (this.claimed[p.id]) c.taken += 1;
    });
    Object.values(byCalling).forEach((c) => {
      c.cap = this.callingCapsOn
        ? Math.min(c.roster, Math.max(2, Math.ceil(c.roster / total * claimed) + 2))
        : c.roster;
      c.open = Math.max(0, c.cap - c.taken);
      c.full = c.open === 0 && c.taken < c.roster;
    });
    return byCalling;
  }

  /* Trades no student has taken yet — what the pick screen tells the class the
   * town still needs. Nothing enforces it; it is a nudge, and a nudge is the
   * right amount of force for this. */
  callingsWanted() {
    return Object.values(this.callingBalance())
      .filter((c) => c.taken === 0 && c.roster > 0)
      .sort((a, b) => a.roster - b.roster || a.calling.localeCompare(b.calling))
      .slice(0, 3)
      .map((c) => c.calling);
  }

  /* ------------------------------------------------------------ stand-ins */

  /* Every documented person nobody is playing, and not retired. Derived every
   * time, so the moment a late student taps their own name the townsman is
   * gone and the student is standing exactly where they were left. */
  townsfolk() {
    if (!this.standInsOn) return [];
    const out = [];
    (this.rosterData.roster || []).forEach((p) => {
      if (this.claimed[p.id] || this.retired[p.id]) return;
      const s = this.standIns[p.id];
      out.push({
        characterId: p.id, name: p.name, calling: p.calling, role: p.role,
        company: p.company, companyName: p.companyName, color: p.color,
        place: (s && s.place) || this.sceneMapId(),
        hex: (s && s.hex) || p.startHex,
        standIn: true,
      });
    });
    return out;
  }

  /* Where this trade belongs on this map. */
  _station(calling, mp) {
    const table = (mp.data && mp.data.stations) || {};
    return table[calling] || null;
  }

  /* Where the town gathers this scene: whatever the scene says, else the first
   * NPC, else the first landmark the lesson has marked as key. */
  _focus(mp) {
    if (this.scene && this.scene.focus) return this.scene.focus;
    const npc = (this.scene.npcs || [])[0];
    if (npc && (npc.place || this.sceneMapId()) === mp.id) return this.npcHex[npc.id] || npc.hex;
    const key = (mp.landmarks || []).filter((l) => l.key)[0];
    return key ? key.hex : null;
  }

  /* One step, once every few seconds, and only while a turn window is open —
   * outside a window the town is listening to the teacher and should be still.
   *
   * Five rules, in order, and a teacher can predict all of them:
   *   1  a student is next to you        -> STAND STILL, they are talking to you
   *   2  you are on a doorway or the gun -> step off it, you are in the way
   *   3  you are away from your trade    -> one step back toward it
   *   4  the town is gathering           -> sometimes drift that way
   *   5  otherwise                       -> mill about, or don't */
  _driftTownsfolk() {
    if (!this.standInsOn || !this.turnOpen) return;
    const now = this.now();
    if (now - this.standInStamp < 8000) return;
    this.standInStamp = now;

    const live = this.liveStudents();
    const folk = this.townsfolk();
    const taken = {};
    live.forEach((s) => { if (s.hex) taken[this.placeId(s) + '|' + s.hex] = true; });
    folk.forEach((t) => { taken[t.place + '|' + t.hex] = true; });

    folk.forEach((t) => {
      const mp = this.maps[t.place];
      if (!mp) return;
      const at = mp.parse(t.hex);
      if (!at) return;

      /* 1 — somebody came over to you */
      const spokenTo = live.some((s) => this.placeId(s) === t.place && s.hex &&
        this.engine.adjacentTo(t.hex, s.hex, mp));
      const onTheWay = mp.featuresAt(t.hex).some((f) => f.to || f.kind === 'cannon');
      if (spokenTo && !onTheWay) return;

      const options = mp.neighbours(at.c, at.r).filter((n) => {
        const tt = mp.terrain(n.c, n.r);
        if (!tt || tt.cost === null) return false;
        const lab = mp.label(n.c, n.r);
        if (taken[t.place + '|' + lab]) return false;
        if (!mp.passable(lab)) return false;
        /* never park in a doorway or on the cannon */
        if (mp.featuresAt(lab).some((f) => f.to || f.kind === 'cannon')) return false;
        return true;
      }).map((n) => mp.label(n.c, n.r));
      if (!options.length) return;

      const step = (goal) => {
        if (!goal) return null;
        let best = null, bd = Infinity;
        options.forEach((lab) => {
          const d = this._hexDist(mp, lab, goal);
          if (d < bd) { bd = d; best = lab; }
        });
        return (best && bd < this._hexDist(mp, t.hex, goal)) ? best : null;
      };

      let go = null;
      /* 2 — get out of the doorway */
      if (onTheWay) go = options[0];
      /* 3 — head home to your trade */
      if (!go) {
        const station = this._station(t.calling, mp);
        if (station && this._hexDist(mp, t.hex, station) > 1) go = step(station);
      }
      /* 4 — the town is gathering somewhere */
      if (!go && this._rand() < 0.4) go = step(this._focus(mp));
      /* 5 — mill about */
      if (!go && this._rand() < 0.35) go = options[Math.floor(this._rand() * options.length)];

      if (!go) return;
      delete taken[t.place + '|' + t.hex];
      taken[t.place + '|' + go] = true;
      this.standIns[t.characterId] = { place: t.place, hex: go };
    });
    this._emit();
  }

  _hexDist(mp, a, b) {
    const pa = mp.parse(a), pb = mp.parse(b);
    if (!pa || !pb) return Infinity;
    const cube = (p) => { const x = p.c - (p.r - (p.r & 1)) / 2; return [x, -x - p.r, p.r]; };
    const A = cube(pa), B = cube(pb);
    return Math.max(Math.abs(A[0] - B[0]), Math.abs(A[1] - B[1]), Math.abs(A[2] - B[2]));
  }

  /* Not seeded from the clock, so the simulator stays reproducible. */
  _rand() {
    this._rs = (this._rs || 0x2545f491) ^ ((this._rs || 1) << 13);
    this._rs = (this._rs >>> 0) ^ ((this._rs >>> 0) >>> 17);
    this._rs = (this._rs ^ (this._rs << 5)) >>> 0;
    return this._rs / 4294967296;
  }

  /* Which world is this student standing in? */
  mapFor(st) { return (st && this.maps[st.place]) || this.map; }
  placeId(st) { return (st && st.place) || this.map.id; }
  feature(id) { const e = this._featIx[id]; return e ? e.f : null; }
  featurePlace(id) { const e = this._featIx[id]; return e ? e.place : null; }
  item(id) { return this._itemIx[id] || null; }

  /* The map the SCENE is set on. Changing it is a journey, not a step. */
  sceneMapId() { return (this.scene && this.scene.map && this.maps[this.scene.map]) ? this.scene.map : this.map.id; }

  /* WHAT TIME IT IS, and what the weather is doing.
   *
   * design/12 makes the still image carry the hour; the map has to agree with
   * it or the room is looking at two different afternoons. Authored per scene,
   * because the dates are real: the Battle of Gonzales was fought before dawn
   * on 2 October 1835 in fog off the Guadalupe, and a student should be able to
   * see that on their own screen without being told. */
  light() {
    return {
      phase: (this.scene && this.scene.time) || 'MIDDAY',
      weather: (this.scene && this.scene.weather) || 'CLEAR',
      date: (this.scene && this.scene.date) || null,
      clock: (this.scene && this.scene.clock) || null,
    };
  }

  /* ------------------------------------------------------------- lifecycle */
  destroy() {
    this.destroyed = true;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this.timer = null;
    this._saveTimer = null;
    this.saver = null;
    this.subs.clear();
    this.viewers = 0;
  }

  /* the simulator drives this by hand */
  tick() { this._tick(); }

  /* Move to the next authored session, carrying the campaign with it. The
   * ledger, Legacy, flags and retirements persist; the clocks and the timeline
   * come from the new session's own file. */
  loadSession(i) {
    if (i < 0 || i >= this.sessions.length) return false;
    const next = this.sessions[i];
    this.sessionIndex = i;
    this.data = next;
    this.segs = next.timeline.slice();
    this.actionsPerWindow = next.actionsPerWindow !== undefined ? next.actionsPerWindow : 0;

    /* Clocks come from the new session — a session that opens with THE DEMAND
     * already full is saying something. The LEDGER does not: what this town
     * has left is what the last session left it. */
    this.clocks = {};
    (next.clocks || []).forEach((c) => { this.clocks[c.id] = Object.assign({}, c); });
    (next.ledger || []).forEach((l) => {
      if (!this.ledger[l.id]) this.ledger[l.id] = Object.assign({}, l);
    });

    this.idx = 0; this.elapsed = 0; this.extra = 0;
    this.started = false; this.running = false; this.startedAt = 0;
    this.closedOut = false; this.tally = {}; this.spotlighted = {};
    this.resumedFromDisk = false;

    const first = this.segs.filter((x) => x.scene)[0];
    const sid = first ? first.scene : Object.keys(this.scenes)[0];
    if (this.engines[sid]) {
      this.sceneId = sid;
      this.engine = this.engines[sid];
      this.scene = this.scenes[sid];
      this.npcHex = {};
      (this.scene.npcs || []).forEach((n) => { this.npcHex[n.id] = n.hex; });
      this._relocate();
    }
    /* CHORES COME BACK EACH PERIOD.
     *
     * takenBy persists in the CAMPAIGN block, not the period block — which is
     * right for a chest and wrong for a chore. Fifteen chores across six
     * sessions is two and a half per student per period, which is not a
     * manifold, it is a countdown. The town needs doing again on Tuesday. */
    Object.values(this._featIx || {}).forEach((e) => {
      if (e.f && e.f.kind === 'job') e.f.takenBy = {};
    });

    /* Unspent invitations lapse when the period does. */
    this._refundLapsed();
    this._lastPostings = null;

    this.sessionMustTeach = [];
    Object.values(this.scenes).forEach((sc) => {
      if (sc.session !== next.session) return;
      (sc.must_teach || []).forEach((f) => {
        if (this.sessionMustTeach.indexOf(f) === -1) this.sessionMustTeach.push(f);
      });
    });
    this._allStudents().forEach((st) => {
      st.used = {}; st.paidLegacy = {}; st.declared = false; st.verb = null;
      st.lastOutcome = null; st.wordsSpent = 0;
      st.tierUp = 0;
      delete st.flags.ACTED_THIS_SCENE;
      /* Every Calling Card says ONCE PER SESSION. st.used resets on a scene
       * change and flags deliberately do not reset at all, so the ability
       * gate is a flag that this line — and only this line — clears. */
      delete st.flags.ABILITY_SPENT;
    });
    this._emit();
    return true;
  }

  subscribe(fn, opts) {
    this.subs.add(fn);
    const counted = !!(opts && opts.viewer);
    if (counted) { this.viewers += 1; this._emit(); }
    fn(this.snapshot());
    return () => {
      this.subs.delete(fn);
      if (counted) { this.viewers = Math.max(0, this.viewers - 1); this._emit(); }
    };
  }
  _emit() {
    if (this.destroyed) return;
    this._dirty();
    const s = this.snapshot();
    this.subs.forEach((fn) => { try { fn(s); } catch (e) { /* one bad client never stops the clock */ } });
  }

  _seg() { return this.segs[this.idx] || null; }
  _len() { const s = this._seg(); return s ? s.seconds + this.extra : 0; }

  _tick() {
    if (!this.running) return;
    this._driftTownsfolk();
    this.elapsed = (this.now() - this.segStamp) / 1000;
    this._toll();
    if (this.bots) this.bots.tick();
    if (this.elapsed >= this._len()) {
      if (this.idx >= this.segs.length - 1) {
        this.running = false;
        this.elapsed = this._len();
        this.closeOut();
      } else {
        return this._enter(this.idx + 1);
      }
    }
    this._emit();
  }

  _enter(i) {
    this.segmentRevision += 1;
    this.idx = Math.max(0, Math.min(this.segs.length - 1, i));
    this.elapsed = 0;
    this.extra = 0;
    this.segStamp = this.now();
    const s = this._seg();

    if (s && s.challengeResult) Adventure.resolveChallenge(this, s.challengeResult);

    if (s && s.clocks) {
      Object.keys(s.clocks).forEach((k) => {
        const c = this.clocks[k];
        if (c) c.filled = Math.min(c.segments, c.filled + s.clocks[k]);
      });
    }
    /* THE DROP.
     *
     * A segment can hand every student an item. drop_by_calling gives a
     * TRADER a different one from a RIFLEMAN, with `drop` as the fallback
     * for anybody the table does not name.
     *
     * WHY IT IS A SET AND NOT A UNIFORM HANDOUT. One object for everyone
     * means thirty identical kits by session six, which is content
     * unlocking rather than character progression. Split by Calling and by
     * March a TRADER's kit and a RIFLEMAN's kit are different VERBS.
     *
     * The guarantee is unchanged and is the point: nobody rolls for this,
     * nobody is unlucky, nothing is scarce, and being absent yesterday costs
     * you nothing — you get yours when you are next in the room.
     *
     * Slot rules are enforced here as well as at pickup, so a drop cannot
     * put a second thing in a hand that is already full. */
    /* A ROAMING SEGMENT LIFTS YOU OFF THE FLOOR. IT DOES NOT HAND OUT A
     * SECOND BUDGET, AND THAT IS THE WHOLE OF THE FIX.
     *
     * This used to read `st.moveLeft = st.move` — a full refresh — and every
     * turn cycle in the shipped timeline is [roam read][roam read][YOUR
     * MOVE]. Three segments, three full refreshes, so a student crossed
     * three times their budget between one decision and the next. Measured
     * on a real Room: a Rider covered 21 hexes per cycle and the longest
     * walk anywhere on the town map is 18. They could be anywhere, always,
     * and so where they went cost them nothing.
     *
     * A teacher reported this as "students move infinitely" and the probe
     * written to check it (tools/probe-movement.js) cleared the server,
     * because it measured inside ONE window and never crossed a segment
     * boundary. The enforcement was never the hole. The refresh was.
     *
     * What roam is FOR still holds: a student who spent their last hex in
     * the window before must not arrive at the narration with moveLeft 0 and
     * a live map that is live for somebody else. So they are lifted to a
     * floor - once per cycle, never past their own budget, and never as a
     * top-up for somebody who still has points in hand. Roaming cannot
     * DECLARE anything (perform() is gated on turnOpen), so all this buys is
     * standing somewhere better when the window opens. */
    if (s && s.roam && !this._isTurn(s)) {
      this._allStudents().forEach((st) => {
        st.move = this.effective(st).move;
        if (st.roamed) return;               // once between windows, not per read
        st.roamed = true;
        st.moveLeft = Math.min(st.move, Math.max(st.moveLeft, Room.ROAM_FLOOR));
      });
    }

    if (s && s.postings) this._seatPostings(s);

    if (s && (s.drop || s.drop_by_calling)) {
      this.liveStudents().forEach((st) => {
        const want = (s.drop_by_calling || {})[st.calling] || s.drop;
        if (!want) return;
        [].concat(want).forEach((id) => this.giveItem(st, id));
      });
    }

    /* THE BAR IS SIZED AGAINST THE ROOM THAT IS ACTUALLY IN IT.
     *
     * decision 11: class sizes vary a lot between this teacher's own
     * periods, so any segment count baked in at authoring time is wrong
     * for somebody every single day. A boss bar sized for thirty is an
     * unwinnable wall for a class of six and a formality for a class of
     * thirty-two.
     *
     * A segment declares what a bar costs PER STUDENT and a floor, and the
     * bar is cut to the live roster at the moment that segment opens — so
     * it counts the students who actually turned up, after the absences.
     * The floor is what makes a class of one a hard fight rather than an
     * impossible one. */
    if (s && s.size_clocks) {
      const heads = Math.max(1, this.liveStudents().length);
      Object.keys(s.size_clocks).forEach((k) => {
        const c = this.clocks[k];
        const spec = s.size_clocks[k];
        if (!c || !spec) return;
        /* A ceiling as well as a floor. The boss's ring holds five people
         * whatever the class size, so demand measurably plateaus above
         * about eighteen students — scaling straight past that makes a big
         * class an unwinnable wall for a reason that is arithmetic rather
         * than design. */
        const want = Math.round((spec.per_student || 0) * heads);
        c.segments = Math.min(spec.max || Infinity, Math.max(spec.min || 1, want));
        c.filled = Math.min(c.filled, c.segments);
      });
    }

    /* Each beat gets its own toll schedule. A boss's three phases are three
     * segments on ONE scene, so st.used persists across them and this does
     * not — the fight remembers what you spent, the boss forgets what it
     * already threw at you. */
    this._tollHit = {};
    this._tollWarned = {};

    if (s && s.roll) this.lastRoll = { a: this._d6(), b: this._d6() };

    if (s && s.scene && s.scene !== this.sceneId && this.engines[s.scene]) {
      this.sceneId = s.scene;
      this.engine = this.engines[s.scene];
      this.scene = this.scenes[s.scene];
      this.npcHex = {};
      (this.scene.npcs || []).forEach((n) => { this.npcHex[n.id] = n.hex; });
      this._relocate();
      /* Once per SCENE, not once per session: a new scene is a new pool.
       * Per-scene flags reset with it. */
      this._allStudents().forEach((st) => {
        st.used = {};
        st.paidLegacy = {};
        delete st.flags.ACTED_THIS_SCENE;
      });
    }

    /* SET THE RECORD STRAIGHT is the backstop, and always was.
     *
     * design/08 promised only that a student would be OFFERED an action
     * delivering each fact. tools/sim-class.js showed that is too weak: given
     * nineteen options, most students did not take the promoted one, and 24 of
     * 26 ended a scene short. Offering is not receiving.
     *
     * The paper unit already had the answer — a mandatory, GM-narrated "here is
     * what was real today" at the end of every session. It is not a patch; it
     * is the beat whose entire job is this. Anything still owed is delivered
     * here, and recorded as having come from the teacher's mouth rather than
     * from play, so the coverage grid can tell those apart. */
    if (s && s.kind === 'record') {
      const need = this.sessionMustTeach;
      this._allStudents().forEach((st) => {
        need.forEach((f) => {
          if (!st.taught[f]) { st.taught[f] = true; st.taughtVia[f] = 'record'; this._giveDocFor(st, f); }
        });
      });
    }

    /* THE DOCUMENTS ARRIVE BY THEMSELVES.
     *
     * There is no paper, so "hand the Turtle Bayou Resolutions to the
     * Schoolmaster" cannot be a note the teacher reads and acts on. A segment
     * that declares a `handout` gives it to every student in the room the
     * moment the lesson reaches it — and it stays on their shelf for the rest
     * of the unit, because a source you read once in a cold open is a source
     * you will want again in the tally.
     *
     * Recorded per student rather than per room so that somebody who joins
     * late, or was absent, gets the documents on arrival — see how catchUp
     * already treats facts. */
    if (s && s.handout) {
      this._allStudents().forEach((st) => {
        st.docs = st.docs || [];
        if (st.docs.indexOf(s.handout) === -1) st.docs.push(s.handout);
      });
      this.handedOut = this.handedOut || [];
      if (this.handedOut.indexOf(s.handout) === -1) this.handedOut.push(s.handout);
    }

    /* A new turn window refreshes everyone's movement and clears last turn's
     * declaration. The server decides this so thirty clients cannot disagree. */
    if (this._isTurn(s)) {
      if (this.bots) this.bots.reset();
      this._allStudents().forEach((st) => {
        st.move = this.effective(st).move;
        st.moveLeft = st.move;
        st.roamed = false;                   // the floor is available again
        st.actionsLeft = this.challengeOpen ? this.actionLimit : this.actionsPerWindow;
        st.declared = false;
        st.acted = false;
        st.verb = null;
        st.lastOutcome = null;
        st.paidLegacy = {};
      });
    }
    this._emit();
  }

  _d6() { return 1 + Math.floor(Math.random() * 6); }

  /* A turn window is DECLARED BY THE CONTENT, not inferred from a label.
   *
   * It used to match on label === 'DECLARE' || 'SPEAK'. Renaming the beat to
   * 'YOUR MOVE' during a restructure silently closed four of the five windows —
   * and the period still ran end to end, looking entirely healthy. Nothing
   * failed; students simply never got to act. tools/sim-class.js caught it
   * because it counts windows, which a human watching would not. */
  _isTurn(seg) {
    if (!seg || seg.kind !== 'beat') return false;
    if (seg.window !== undefined) return !!seg.window;
    return seg.label === 'DECLARE' || seg.label === 'SPEAK';   // legacy content
  }
  /* THE SCRIM COMES OFF.
   *
   * turnOpen used to mean "is this a scored window", and 17 of session 1's
   * 25 segments are not one. Measured from a student seat that is 22:00 of a
   * 42:55 period in which the device answers nothing, with a 7:15 stretch at
   * the end - and the read segment that poses the turn's question ("What do
   * you do right now?") is itself one of them. The game asked and then told
   * you to be quiet, forty-five seconds at a time.
   *
   * So it now means "may a student act", which is everything except the two
   * moments that genuinely need the room looking up. _isTurn is untouched and
   * still governs SCORING - the movement and action refresh, the declaration
   * reset - so a budget is still issued once per turn cycle and is now spent
   * across the narration as well as the window. Same economy, no cage.
   *
   * REVERSIBLE: put EYES_UP back to every non-window kind and this is the old
   * behaviour exactly. It is an experiment, and the question it answers is
   * whether the frozen half was holding the lesson together or holding it
   * back. */
  static EYES_UP = ['sequence', 'tally'];
  get challengeOpen() {
    const s = this._seg();
    return !!(s && (s.boss || s.challenge));
  }
  get actionLimit() { return this.challengeOpen ? 3 : 0; }
  get movementFree() { return this.roamOpen && !this.challengeOpen; }
  get playMode() {
    if (!this.started) return 'waiting';
    if (!this.running || !this.turnOpen) return 'paused';
    return this.challengeOpen ? 'challenge' : 'explore';
  }
  get turnOpen() {
    if (!this.started || !this.running) return false;
    const s = this._seg();
    return !!s && Room.EYES_UP.indexOf(s.kind) === -1;
  }

  /* ROAM — the map stays live when the turn does not.
   *
   * move() and enter() both refuse unless turnOpen, and turnOpen is true only
   * for a beat with window:true. So a read segment is a screen that does not
   * respond to taps: a student who reaches for the map during the sixty
   * seconds between windows finds a dead rectangle. In a game a real class
   * already called "a textbook with a gamey exterior", that is the complaint
   * making itself.
   *
   * A segment that says roam:true lets a student WALK but not ACT. Nothing is
   * declared, nothing is spent, no action resolves — perform() still checks
   * turnOpen and still refuses. You can cross the square while the narrator
   * talks, which is what a twelve-year-old expects a map to let them do. */
  get roamOpen() {
    if (!this.started || !this.running) return false;
    if (this.turnOpen) return true;
    const s = this._seg();
    return !!(s && s.roam);
  }

  /* ------------------------------------------------------------- teacher */
  command(type, payload) {
    payload = payload || {};
    switch (type) {
      case 'start':
        if (this.started) break;
        this.started = true; this.running = true;
        this.startedAt = this.now();
        this._enter(0);
        break;
      /* Nothing to do. It exists so that opening the desk on a class is enough
       * to point the students' short URL at it — see activeRoom in serve.js.
       * Without it a teacher could pick period 3, not press anything yet, and
       * have the class walk into period 1. */
      case 'open':   this._emit(); break;
      case 'pause':  this.running = false; this._emit(); break;
      case 'resume':
        this.resumedFromDisk = false;
        if (!this.started) return this.command('start');
        this.running = true;
        this.segStamp = this.now() - this.elapsed * 1000;
        this._emit();
        break;
      case 'toggle': return this.command(this.running ? 'pause' : 'resume');
      case 'next':   if (this.idx < this.segs.length - 1) this._enter(this.idx + 1); break;
      case 'back':   this._enter(Math.max(0, this.idx - 1)); break;
      case 'goto':   this._enter(payload.index | 0); break;
      case 'replay': this._enter(this.idx); break;
      case 'extend': this.extra += (payload.seconds || 30); this._emit(); break;
      case 'manualRead': this.manualRead = !!payload.on; this._emit(); break;
      /* TEST MODE. A full class of nobody, on the real clock, so a
       * teacher can watch a period before twenty-six of them arrive.
       * Refuses in a room that already has real students. */
      case 'testMode': {
        if (!this.bots) this.bots = new Bots(this);
        const want = payload && payload.on !== undefined ? !!payload.on : !this.bots.on;
        const r = want ? this.bots.start() : this.bots.stop();
        this._emit();
        return r;
      }

      case 'standIns':
        this.standInsOn = payload.on === undefined ? !this.standInsOn : !!payload.on;
        this._emit();
        break;
      case 'callingCaps':
        this.callingCapsOn = payload.on === undefined ? !this.callingCapsOn : !!payload.on;
        this._emit();
        break;
      case 'roll':   this.lastRoll = { a: this._d6(), b: this._d6() }; this._emit(); break;
      case 'clock': {
        const c = this.clocks[payload.id];
        if (c) c.filled = Math.max(0, Math.min(c.segments, c.filled + (payload.d | 0)));
        this._emit();
        break;
      }
      case 'ledger': {
        const l = this.ledger[payload.id];
        if (l) l.value = Math.max(0, l.value + (payload.d | 0));
        this._emit();
        break;
      }
      case 'tally':
        this.tally[payload.key] = Math.max(0, (this.tally[payload.key] || 0) + (payload.d | 0));
        this._emit();
        break;

      case 'grantWord': {
        const st = this._byCharacter(payload.characterId);
        if (st) st.words += 1;
        this._emit();
        break;
      }
      /* PICK A SESSION OUTRIGHT. nextSession only steps forward and only
       * once a period has closed out, which is right for a class working
       * through a unit and useless for everything else: a teacher who wants
       * to look at session 2, rehearse it, or reteach Friday's period had no
       * way to say so except by finishing session 1 first.
       *
       * loadSession is safe to call for any index - it resets THE PERIOD and
       * takes the new session's clocks, while the ledger, standing, legacy
       * and every student flag stay where they are. The refusal below is
       * therefore not about corruption; it is about not throwing away a
       * period a class is standing in the middle of. */
      case 'setSession': {
        const want = payload.index | 0;
        if (want === this.sessionIndex && !payload.force) return { ok: true, session: this.data.session };
        if (this.started && !this.closedOut && !payload.force) {
          return { ok: false, error: 'period-in-progress', session: this.data.session };
        }
        if (!this.loadSession(want)) return { ok: false, error: 'no-such-session' };
        this._emit();
        return { ok: true, session: this.data.session };
      }
      case 'nextSession': {
        if (!this.closedOut) return { ok: false, error: 'session-not-finished' };
        if (!this.loadSession(this.sessionIndex + 1)) {
          return { ok: false, error: 'no-more-sessions' };
        }
        break;
      }
      case 'retire': {
        /* design/04: a dead name is retired and never reissued. */
        this.retired[payload.characterId] = true;
        const sid = this.claimed[payload.characterId];
        if (sid && this.students[sid]) delete this.students[sid];
        delete this.claimed[payload.characterId];
        this._emit();
        break;
      }
      default: return { ok: false, error: 'unknown command: ' + type };
    }
    return { ok: true };
  }

  _byCharacter(id) {
    const sid = this.claimed[id];
    return sid ? this.students[sid] : null;
  }

  /* ------------------------------------------------------------- students */

  /* One person, one player (design/04). A second device claiming a taken name
   * is refused — unless it IS that student coming back on a new Chromebook,
   * which we detect by the old session having gone quiet. */
  /* THE FIGURINE PALETTE.
   *
   * A company colour is shared by all five of its members, so with a full
   * class there are four other students on the board wearing each of six
   * colours — genuinely indistinguishable. A teacher playing it reported that
   * students could not see where other players were, and this is why: the
   * tokens were perfectly visible and there was no way to tell whose was
   * whose.
   *
   * So each student picks their own. Twelve, chosen to stay apart at the ~14
   * pixels a token occupies on a Chromebook and to sit on paper without
   * vibrating. Colour is the SECOND identity channel and never the only one:
   * the figurine's silhouette differs by Calling and the name is drawn above
   * it where there is room, so a colour-blind student loses nothing load
   * bearing.
   *
   * Indexed rather than free-form. A colour from a client is a string to be
   * validated; an index is a number to bounds-check, and the palette can be
   * restyled later without rewriting thirty saved periods. */
  static get TINTS() {
    return [
      '#B23A2E', '#C2762A', '#8A6534', '#5E7A2E',
      '#2F7A5E', '#2F6E86', '#3B5B96', '#6B4E9E',
      '#9E3E7E', '#7A4230', '#4A5560', '#1F3C42',
    ];
  }
  /* Which colours the class has already spoken for, so the creation screen can
   * mark them without forbidding them. NOT a cap: two students in a thirty-
   * child class wanting the same green is fine — the figurine shape and the
   * name still separate them, and telling a twelve-year-old they may not have
   * the colour they want is a bad trade for a marginal gain in legibility. */
  tintsTaken() {
    const out = {};
    Object.values(this.students).forEach((st) => {
      if (st.tintIndex === null || st.tintIndex === undefined) return;
      out[st.tintIndex] = (out[st.tintIndex] || 0) + 1;
    });
    return out;
  }

  static tintOf(i) {
    const list = Room.TINTS;
    const n = Number(i);
    return Number.isInteger(n) && n >= 0 && n < list.length ? list[n] : null;
  }

  join(sid, characterId, tintIndex) {
    if (this.retired[characterId]) {
      return { ok: false, error: 'retired', message: 'That name has been retired.' };
    }
    const person = (this.rosterData.roster || []).filter((p) => p.id === characterId)[0];
    if (!person) return { ok: false, error: 'unknown-character' };

    /* The cap is enforced HERE and not only on the pick screen. A greyed-out
     * card is a courtesy; this is the rule. */
    if (!this.claimed[characterId]) {
      const c = this.callingBalance()[person.calling];
      if (c && c.open <= 0) {
        return { ok: false, error: 'calling-full',
                 message: 'The town has enough ' + person.calling.toLowerCase() +
                          's for now. Pick a trade nobody has taken yet — more open up as the class fills.' };
      }
    }

    const holder = this.claimed[characterId];
    let transferred = null;
    if (holder && holder !== sid) {
      const prev = this.students[holder];
      const quiet = !prev || (this.now() - prev.seen) > 15000;
      if (!quiet) {
        return { ok: false, error: 'taken', message: 'Somebody is already playing that person.' };
      }
      transferred = prev;
      delete this.students[holder];      // they went quiet: this is a reconnect
    }

    const device = this.students[sid];
    const existing = (device && device.characterId === characterId ? device : null) ||
      transferred || this.parked[characterId];
    /* A replacement Chromebook may have played someone else before. Progress
     * follows the requested character; keep the previous character available
     * for their own next device instead of copying their progress across. */
    if (device && device.characterId !== characterId) {
      this.parked[device.characterId] = device;
      if (this.claimed[device.characterId] === sid) delete this.claimed[device.characterId];
    }
    const st = {
      sid,
      characterId,
      name: person.name,
      company: person.company,
      companyName: person.companyName,
      color: person.color,
      /* Their own if they chose one on the way in, otherwise whatever they had
       * before, otherwise the company colour — so a student who skips the step
       * is never a token with no colour at all. */
      tint: Room.tintOf(tintIndex) || (existing && existing.tint) || person.color,
      /* Somebody arriving late — or on the second day — is given every
       * document the room has already been handed, not just the ones issued
       * while they happened to be looking. */
      docs: (existing && existing.docs && existing.docs.length)
            ? existing.docs.slice()
            : (this.handedOut || []).slice(),
      trail: (existing && existing.trail) ? existing.trail.slice() : [],
      tintIndex: Room.tintOf(tintIndex) !== null ? Number(tintIndex)
                 : (existing && existing.tintIndex !== undefined ? existing.tintIndex : null),
      calling: person.calling,
      role: person.role,
      ability: person.ability,
      abilityBlurb: person.abilityBlurb,
      moveBase: person.move,
      move: person.move + (person.stats.land || 0),
      items: existing ? (existing.items || []) : [],
      /* If a townsman has been standing in for this person, the student
       * arrives exactly where they were left — so walking in late means you
       * are already in the square, not teleported to a start hex. */
      place: (existing && existing.place && this.maps[existing.place]) ? existing.place
             : ((this.standIns[characterId] || {}).place || this.sceneMapId()),
      anchor: (existing && existing.anchor) || null,
      hex: (existing && existing.hex) ||
           (this.standIns[characterId] || {}).hex || person.startHex,
      moveLeft: existing ? existing.moveLeft : person.move + (person.stats.land || 0),
      words: existing ? existing.words : person.words,
      wordsSpent: existing ? existing.wordsSpent : 0,
      resolve: person.resolve,
      resolveUsed: existing ? existing.resolveUsed : 0,
      legacy: existing ? existing.legacy : 0,
      declared: existing ? existing.declared : false,
      acted: existing ? !!existing.acted : false,
      actionsLeft: existing && existing.actionsLeft !== undefined
        ? existing.actionsLeft : this.actionLimit,
      used: existing ? existing.used : {},
      paidLegacy: existing ? (existing.paidLegacy || {}) : {},
      verb: existing ? existing.verb : null,
      origin: person.origin,
      mark: person.mark,
      stats: person.stats,
      strength: person.strength,
      flags: existing ? existing.flags : {},
      taught: existing ? existing.taught : {},
      taughtVia: existing ? existing.taughtVia : {},
      lastActionId: existing ? existing.lastActionId : null,
      aidBonus: existing ? (existing.aidBonus || 0) : 0,
      tierUp: existing ? (existing.tierUp || 0) : 0,
      lastOutcome: existing ? existing.lastOutcome : null,
      caughtUp: existing ? existing.caughtUp : null,
      seen: this.now(),
    };
    delete this.parked[characterId];
    delete this.standIns[characterId];      // the stand-in is relieved
    this.students[sid] = st;
    const seat = (this.attended[this.sessionIndex] = this.attended[this.sessionIndex] || {});
    const firstToday = !seat[characterId];
    seat[characterId] = true;

    /* A LATECOMER IS SEATED AGAINST THE POSTING THAT IS STILL LIVE.
     *
     * Against _lastPostings, not against the current segment — the current
     * one is usually a beat and has no postings field, so re-sweeping it
     * would seat nobody and the student who walked in late would be the one
     * student the town never asked. */
    if (firstToday && this._lastPostings) this._seatPostings(this._lastPostings);

    /* CAUGHT UP, AUTOMATICALLY. Nobody pressed anything to make this happen. */
    const cu = this.catchUp(characterId, firstToday);
    if (cu) {
      cu.facts.forEach((f) => {
        if (st.taught[f.id]) return;
        st.taught[f.id] = true;
        st.taughtVia[f.id] = 'caught-up';
        this._giveDocFor(st, f.id);
      });
      st.caughtUp = cu;
      this.note(st.name + ' was caught up on ' +
        (cu.sessions ? cu.sessions + ' session(s)' : 'today so far') +
        ' — ' + cu.facts.length + ' fact(s) granted', st);
    }
    this.claimed[characterId] = sid;
    this._emit();
    return { ok: true, you: st, roster: this.publicRoster() };
  }

  publicRoster() {
    const bal = this.callingBalance();
    const wanted = this.callingsWanted();
    return (this.rosterData.roster || []).map((p) => {
      const c = bal[p.calling] || { open: 99 };
      const blocked = !this.claimed[p.id] && !this.retired[p.id] && c.open <= 0;
      return {
        id: p.id, name: p.name, role: p.role, calling: p.calling, move: p.move,
        stats: p.stats, ability: p.ability, abilityBlurb: p.abilityBlurb, origin: p.origin,
        company: p.company, companyName: p.companyName, color: p.color,
        taken: !!this.claimed[p.id], retired: !!this.retired[p.id],
        blocked: blocked,
        /* said in the words to say to a twelve-year-old: it is not "no", it is
         * "not yet", and it says what to do instead */
        blockedWhy: blocked
          ? 'The town has enough ' + p.calling.toLowerCase() + 's for now. More open up as your class fills — or pick a trade nobody has yet.'
          : null,
        wanted: wanted.indexOf(p.calling) !== -1,
      };
    });
  }

  /* what the console and the pick screen both show */
  balanceSummary() {
    const bal = this.callingBalance();
    return {
      on: this.callingCapsOn,
      claimed: Object.keys(this.claimed).length,
      wanted: this.callingsWanted(),
      callings: Object.values(bal).sort((a, b) => a.calling.localeCompare(b.calling)),
    };
  }

  ping(sid) { const st = this.students[sid]; if (st) st.seen = this.now(); }

  /* They have read it. It does not come back on a reload. */
  seenCatchUp(sid) {
    const st = this.students[sid];
    if (!st) return { ok: false, error: 'not-joined' };
    delete st.caughtUp;
    this._emit();
    return { ok: true };
  }

  leave(sid) {
    const st = this.students[sid];
    if (!st) return;
    /* The student remains here while their device is asleep. Keep one current
     * state so later turn resets and handouts survive a device transfer too. */
    /* Keep the claim: a closed lid is not a resignation. It ages out after 15s
     * so the same student can rejoin on another device. */
    st.seen = this.now() - 14000;
    this._emit();
  }

  /* Movement, validated here and nowhere else. The client draws the range as a
   * convenience; the server decides whether the step was legal. */
  move(sid, hexLabel) {
    const st = this.students[sid];
    if (!st) return { ok: false, error: 'not-joined' };
    /* roamOpen, not turnOpen: walking is allowed on a roaming read segment.
     * perform() is still gated on turnOpen, so nothing can be DONE here. */
    if (!this.roamOpen) return { ok: false, error: 'closed' };

    const mp = this.mapFor(st);
    const target = mp.parse(hexLabel);
    if (!target || !mp.terrain(target.c, target.r)) return { ok: false, error: 'no-such-hex' };

    const reach = mp.reachable(st.hex, this.movementFree ? 10000 : st.moveLeft, this._moveOpts(st));
    const cost = reach[target.c + ',' + target.r];
    if (cost === undefined) return { ok: false, error: 'out-of-range' };

    if (!this.movementFree) st.moveLeft -= cost;
    st.hex = hexLabel;
    st.seen = this.now();
    this._emit();
    return { ok: true, hex: st.hex, moveLeft: st.moveLeft };
  }

  _moveOpts(st) {
    const o = {};
    if (st.calling === 'RIDER' || st.calling === 'RANCHERO') o.cheapTerrain = ['road'];
    /* Everyone else on the board is an obstacle: you cannot end on them and you
     * cannot walk through them. A doorway two people are standing in is held. */
    const here = this.placeId(st);
    o.occupied = this.liveStudents()
      .filter((x) => x.characterId !== st.characterId && x.hex && this.placeId(x) === here)
      .map((x) => x.hex)
      /* a townsman is a body in the road exactly like a classmate */
      .concat(this.townfolkAt(here, st.characterId));
    return o;
  }

  /* GOING INSIDE.
   *
   * A door with a `to` is a portal. Walking through one is MOVEMENT, not an
   * action — charging a twelve-year-old their whole turn to open a door would
   * teach them never to open doors. It costs one point, you must be standing on
   * the threshold, and the door must be open.
   *
   * The moment this returns, that student's screen is showing a different map
   * from everybody else's, and the classmates left outside see a hollow token
   * on the doorstep instead of them. */
  enter(sid, featureId) {
    const st = this.students[sid];
    if (!st) return { ok: false, error: 'not-joined' };
    if (!this.roamOpen) return { ok: false, error: 'closed' };
    const f = this.feature(featureId);
    if (!f || !f.to || !this.maps[f.to.place]) return { ok: false, error: 'no-such-way' };
    if (this.featurePlace(featureId) !== this.placeId(st)) return { ok: false, error: 'not-here' };
    if (st.hex !== f.hex) return { ok: false, error: 'not-on-it' };
    if (f.open === false) return { ok: false, error: 'shut' };
    if (!this.movementFree && st.moveLeft < 1) return { ok: false, error: 'no-move-left' };

    const dest = this.maps[f.to.place];
    const landing = f.to.hex && dest.parse(f.to.hex) ? f.to.hex : (dest.data.entry || f.to.hex);
    if (!landing) return { ok: false, error: 'no-landing' };

    /* Somebody standing in the doorway on the far side genuinely blocks it. */
    const taken = this.liveStudents().some((x) => x.characterId !== st.characterId &&
      this.placeId(x) === f.to.place && x.hex === landing);
    if (taken) return { ok: false, error: 'blocked', message: 'Somebody is in the way.' };

    st.anchor = dest.indoors ? { place: this.placeId(st), hex: f.hex } : null;
    st.place = f.to.place;
    st.hex = landing;
    if (!this.movementFree) st.moveLeft -= 1;
    st.seen = this.now();
    this._emit();
    return { ok: true, place: st.place, hex: st.hex, moveLeft: st.moveLeft };
  }

  townfolkAt(place, exceptId) {
    return this.townsfolk()
      .filter((t) => t.place === place && t.characterId !== exceptId)
      .map((t) => t.hex);
  }

  /* Where a student appears to everyone NOT in the same room as them. */
  anchorOf(st) {
    if (!st.anchor) return null;
    return st.anchor;
  }

  /* MOVE is a stat, derived and visible, not a fixed number per Calling.
   * Calling sets the floor, LAND is the body doing the walking, and a horse is
   * a horse. */
  /* FIVE SLOTS, UNEQUAL, AND NO SWAPPING.
   *
   * hand (the event drop, a verb in every scene of its kind) · belt
   * (situational) · pocket (one-shot) · under (effect.move only) · carried
   * (uncapped, set fodder).
   *
   * A full slot DECLINES the second item, in one line, and there is no swap
   * screen. A swap screen is a sixty-second decision by twenty-six
   * twelve-year-olds in the middle of a window, and it manufactures exactly
   * the which-is-bigger comparison this whole design exists to avoid. The
   * real choice lives in ROUTING instead: two hand items on opposite sides
   * of one map, and yours is whichever you reached first.
   *
   * Returns the item's name if it went in, or null if it was declined. */
  giveItem(st, id) {
    st.items = st.items || [];
    if (st.items.indexOf(id) !== -1) return null;      // already yours
    const it = this.item(id);
    if (!it) return null;
    const slot = it.slot || 'carried';
    const CAP = { hand: 1, belt: 1, pocket: 1, under: 1 };
    if (CAP[slot]) {
      const held = st.items.filter((x) => ((this.item(x) || {}).slot || 'carried') === slot);
      if (held.length >= CAP[slot]) return null;
    }
    const moveWas = st.move;
    st.items.push(id);
    st.move = this.effective(st).move;
    st.moveLeft += (st.move - moveWas);
    return it.name;
  }

  /* HORIZONTAL PROGRESSION ONLY.
   *
   * Items used to add to a stat here, and engine.js is the one line where a
   * number joins 2d6 — so an item was a permanent bonus to every roll a
   * student would ever make. Against three fixed tiers, no level scaling and
   * six periods, that made almost everything a strong result by session five
   * and nothing cost anything any more. ITEM_KEG_POWDER was arms +2 against a
   * roster where seventeen of thirty characters have arms 0.
   *
   * effect.move survives, and only move. Move is not a bonus, it is a budget:
   * it changes where you can stand, which changes which requires.adjacent_*
   * and cost.move checks pass. It never reaches the dice.
   *
   * An item's power is requires.item on an authored action — see meets().
   * check-content fails the build if any item declares effect.stat again. */
  effective(st) {
    const stats = Object.assign({}, st.stats);
    let move = st.moveBase + (stats.land || 0);
    (st.items || []).forEach((id) => {
      const it = this.item(id);
      if (it && it.effect && it.effect.move) move += it.effect.move;
    });
    /* THE RANGE IS CLAMPED, AND THE NUMBERS ARE MEASURED RATHER THAN FELT.
     *
     * Of the 21 things on the town map worth walking to, one budget puts
     * this many in reach, and leaves this share of hexes with nothing at all
     * in range:
     *
     *     move 2 -> 1 of 21, 33% of hexes barren
     *     move 3 -> 2 of 21, 16%
     *     move 4 -> 4 of 21, 10%
     *     move 5 -> 5 of 21,  5%
     *     move 7 -> 9 of 21,  1%
     *
     * A choice only costs something when a few things are in reach and the
     * rest are not. At 2 a third of the map offers a slow student nothing to
     * walk to, which reads as being stuck rather than as choosing. At 7 -
     * nearly half the board - a Rider never has to choose at all, so the
     * fast Callings were buying an advantage nobody could feel.
     *
     * Three to five keeps the Rider a Rider (five things against two, and
     * cheap roads on top) while making every one of them commit. The spread
     * survives; it is the ends that were doing nothing. Nothing on a printed
     * card carries a move value, so this changes no handout. */
    return { stats, move: Math.max(Room.MOVE_MIN, Math.min(Room.MOVE_MAX, move)) };
  }

  /* ------------------------------------------------------------- the engine */
  ctxFor(st) {
    /* The engine rolls against EFFECTIVE stats, so a powder horn or the colony
     * papers are worth something at the table and not just in an inventory. */
    const eff = this.effective(st);
    const view = Object.assign(Object.create(Object.getPrototypeOf(st)), st, { stats: eff.stats });
    return {
      student: view,
      movementFree: this.movementFree,
      clockLabels: Object.fromEntries(Object.entries(this.clocks).map(([k, c]) => [k, c.label])),
      riskClocks: ((((this._seg() || {}).boss || {}).bars) || []).slice(1),
      resourceLabels: Object.fromEntries(Object.entries(this.ledger).map(([k, c]) => [k, c.label])),
      itemNames: Object.fromEntries(Object.entries(this._itemIx).map(([k, item]) => [k, item.name])),
      lootNames: Object.fromEntries(Object.entries(this._featIx).map(([k, e]) =>
        [k, (e.f.contents || []).map((id) => (this.item(id) || {}).name).filter(Boolean)])),
      real: st,
      map: this.mapFor(st),
      others: this.liveStudents(),
      /* Townsfolk satisfy "find somebody of this trade" and NOT "aid a
       * classmate" — see Engine#meets. A student who spends their action
       * aiding a body that will never roll has been cheated. */
      townsfolk: this.townsfolk().filter((t) => t.place === this.placeId(st)),
      world: this.world,
      npcHex: this.npcHex,
      clocks: Object.keys(this.clocks).reduce((a, k) => {
        a[k] = this.clocks[k].filled; return a;
      }, {}),
      resources: Object.keys(this.ledger).reduce((a, k) => {
        a[k] = this.ledger[k].value; return a;
      }, {}),
      standing: this.standing || {},
      /* design/14 fallback_sweep_at: -1:30. Inside the last 90 seconds of the
       * window, coverage stops being optional. */
      sweep: this.turnOpen && (this._len() - this.elapsed) <= 90,
    };
  }

  offerFor(sid) {
    const st = this.students[sid];
    if (!st) return [];
    if (!this.turnOpen || (this.challengeOpen && st.declared)) return [];
    return this.engine.offer(this.ctxFor(st));
  }

  /* One action per turn window. Declaring does NOT end movement — deciding
   * early must never park a student (the idle floor, design/08). */
  perform(sid, actionId) {
    const st = this.students[sid];
    if (!st) return { ok: false, error: 'not-joined' };
    if (!this.turnOpen) return { ok: false, error: 'closed' };
    if (this.challengeOpen && st.declared) return { ok: false, error: 'already-declared' };

    const ctx = this.ctxFor(st);
    const before = Adventure.capture(this, st);
    const r = this.engine.resolve(actionId, ctx, { aidBonus: st.aidBonus, tierUp: st.tierUp });
    if (!r.ok) return r;
    /* World actions: searching a container, working a door. */
    if (r.action.loot) {
      const f = this.feature(r.action.loot);
      if (!this.engine.openTo(f, st)) return { ok: false, error: 'already-searched' };
      /* PER CHARACTER, NOT PER ROOM. The old single boolean was campaign
       * persisted, so period two opened with most of the town already
       * emptied by period one. f.searched is still written for anything
       * that reads it as "has anyone been here". */
      f.takenBy = f.takenBy || {};
      f.takenBy[st.characterId] = true;
      f.searched = true;
      /* Through giveItem, so the slot rule cannot be walked around by a
       * chest — it is the one door items come through. */
      const names = [];
      const declined = [];
      (f.contents || []).forEach((id) => {
        const got = this.giveItem(st, id);
        if (got) names.push(got);
        else { const it = this.item(id); if (it) declined.push(it.name); }
      });
      r.outcome = Object.assign({}, r.outcome, {
        narrate: names.length
          ? 'You go through it. ' + names.join(', and ') + '.'
          : (declined.length
            ? 'You leave ' + declined.join(' and ') + '. Your hands are full.'
            : 'Somebody has already been through this.'),
        legacy: 1,
      });
      r.gained = names;
      r.declined = declined;
    }
    /* A chore is taken per student, like a container. */
    if (r.action.job) {
      const f = this.feature(r.action.job);
      if (!this.engine.openTo(f, st)) return { ok: false, error: 'already-done' };
      f.takenBy = f.takenBy || {};
      f.takenBy[st.characterId] = true;
    }

    if (r.action.door) {
      const f = this.feature(r.action.door);
      if (f) {
        f.open = !f.open;
        r.outcome = Object.assign({}, r.outcome, {
          narrate: f.open
            ? 'It comes open. Anybody can get through now, including anybody you did not mean.'
            : 'Shut, and it stays shut until somebody opens it again.',
        });
      }
    }
    ctx.viaFallback = !!r.action.fallback_for;
    ctx.actionId = actionId;
    ctx.repeatable = !!r.action.repeatable;

    // pay
    if (r.cost.move && !this.movementFree) st.moveLeft -= r.cost.move;
    if (r.cost.word) st.wordsSpent += r.cost.word;

    this.applyOutcome(st, r.outcome, ctx);

    /* WHAT YOU DID TODAY.
     *
     * The closing checklist asks for "four sentences, from your Turn Log", and
     * the Turn Log was a sheet of paper. There is no paper, so it asked for
     * four sentences from nothing.
     *
     * The server has always seen every one of these — what was tried, how the
     * dice fell, what it taught — and thrown them away after painting one
     * outcome sheet. Keeping them costs a few hundred bytes a student and turns
     * the graded moment from "remember your day" into "read your day".
     *
     * Capped, because a saved period is written to disk every sixty seconds
     * and an unbounded list would grow all term. Forty is more turns than a
     * session has. */
    st.trail = (st.trail || []).concat([{
      /* loadSession deliberately leaves student state alone, so the trail
       * carries from one session to the next. Tag it, or "what you did today"
       * shows last week too. */
      session: this.sessionIndex,
      scene: this.sceneId,
      label: this.engine.fillIn(r.action.label, ctx),
      verb: r.action.verb || 'ACT',
      tier: r.tier,
      taught: (r.outcome.teach || [])
        .map((f) => (this.engine.facts[f] || {}).short).filter(Boolean),
    }]).slice(-40);

    st.used[actionId] = true;
    st.acted = true;                 // has had their turn — see the note above
    if (this.actionLimit > 0) {
      st.actionsLeft = Math.max(0, st.actionsLeft - 1);
      st.declared = st.actionsLeft <= 0;
    } else st.declared = false;
    st.verb = r.action.verb || 'ACT';
    st.lastActionId = actionId;
    /* An aid a NEIGHBOUR gave you is consumed by the roll you just made.
     * An aid THIS action gave you — the trader calling in a debt — has not
     * been used yet and must survive the reset that follows it. */
    st.aidBonus = (r.outcome && r.outcome.aid_self) || 0;
    if (r.steadied) st.tierUp = 0;   // spent only when it changed the tier
    st.lastOutcome = {
      id: ++this.outcomeSeq,
      label: this.engine.fillIn(r.action.label, ctx),
      verb: st.verb,
      tier: r.tier,
      d1: r.d1, d2: r.d2, bonus: r.bonus, total: r.total, stat: r.stat,
      narrate: r.outcome.narrate || '',
      taught: (r.outcome.teach || []).map((f) => this.engine.facts[f]).filter(Boolean)
        /* `handout` is the student-facing document id; `source` is
         * deliberately NOT sent. Most facts cite research/ or design/ files,
         * and showing a twelve-year-old "design/11-map-data.md" as the
         * provenance of what they just learned is worse than showing nothing. */
        .map((f) => ({ id: f.id, short: f.short, statement: f.statement,
                       handout: f.handout || null })),
      flags: r.outcome.set_flags || [],
      legacy: r.outcome.legacy || 0,
      effects: Adventure.effects(this, st, before),
    };
    st.seen = this.now();

    this.note(st.name + ' → ' + this.engine.fillIn(r.action.label, ctx), r.tier);
    this.spotlight(st, r, ctx);
    this._emit();
    return { ok: true, outcome: st.lastOutcome };
  }

  /* LEARNING A FACT HANDS YOU THE DOCUMENT IT RESTS ON.
   *
   * The outcome sheet tells a student "this is true, and it is in the record".
   * That was a claim with nothing behind it. Four facts genuinely rest on a
   * primary source that is now in the app, so the moment a student learns one,
   * the document goes on their shelf and the outcome sheet offers to open it.
   *
   * This also fixes a gap that segment-declared handouts alone could not: the
   * Law of April 6, 1830 is taught in session 1 and its document existed in the
   * app, but nothing ever gave it to anybody. A citation nobody can follow is
   * not a citation. */
  _giveDocFor(st, factId) {
    /* engine.facts is the id->fact map every scene's Engine is built with
     * from the same factsData, and it is what closeOut and catchUp already
     * read. Using it rather than a second index means one place to be wrong. */
    const f = this.engine && this.engine.facts && this.engine.facts[factId];
    const id = f && f.handout;
    if (!id) return;
    st.docs = st.docs || [];
    if (st.docs.indexOf(id) === -1) st.docs.push(id);
  }

  /* THE BREADCRUMB — E10.
   *
   * hexmap.js has drawn a dashed ring and printed GO HERE over state.target
   * since the beginning, and play.js has sent ME.target the whole time. The
   * server has never once filled it in.
   *
   * WHY IT IS NOT SIMPLY "THE SCENE'S FOCUS". An earlier draft fell through to
   * the scene's first NPC. NPC_PONTON sits on K6 in four of five Session-1
   * scenes, K6 is also the well, and _moveOpts makes every student and
   * townsman a hard obstacle you can neither stand on nor path through — so
   * the breadcrumb would have sent thirty students to one hex with six
   * neighbours and manufactured exactly the jam it exists to prevent.
   *
   * So: the nearest chore or container THIS student has not taken, that has at
   * least two free neighbours to stand in. Never an NPC, never a door. Returns
   * null rather than a crowded answer — no ring at all is better than thirty
   * rings on one square. Different students get different rings, which is the
   * whole point of a solo layer. */
  targetFor(st) {
    const mp = this.mapFor(st);
    if (!mp || !st.hex) return null;
    const from = mp.parse(st.hex);
    if (!from) return null;

    const occupied = {};
    this._allStudents().forEach((o) => {
      if (o.characterId !== st.characterId && this.placeId(o) === mp.id) occupied[o.hex] = true;
    });
    (this.townsfolk() || []).forEach((t) => { if (t.place === mp.id) occupied[t.hex] = true; });

    const standable = (lab) => {
      const q = mp.parse(lab);
      if (!q) return false;
      const terr = mp.terrain(q.c, q.r);
      return !!(terr && terr.cost !== null && !occupied[lab]);
    };

    const reach = mp.reachable(st.hex, 99, this._moveOpts(st));
    let best = null;
    (mp.features || []).forEach((f) => {
      if (f.kind !== 'job' && f.kind !== 'chest' && f.kind !== 'body') return;
      if (!this.engine.openTo(f, st)) return;                 // already yours
      const at = mp.parse(f.hex);
      if (!at) return;
      const free = mp.neighbours(at.c, at.r)
        .map((n) => mp.label(n.c, n.r))
        .filter(standable).length;
      if (free < 2) return;                                   // do not send them into a jam
      const cost = reach[at.c + ',' + at.r];
      if (cost === undefined) return;                         // cannot get there at all
      if (!best || cost < best.cost) best = { hex: f.hex, cost: cost };
    });
    return best ? best.hex : null;
  }

  /* WHO GETS ASKED.
   *
   * The rule is ten words on the projector: THE TOWN ASKS THE PEOPLE IT HAS
   * NOT ASKED LATELY. Hide the outcome, never the process — in a room of
   * twelve-year-olds an unexplained selection is not read as luck, it is read
   * as favouritism, and it is read that way about the teacher.
   *
   * So: no cold roll anywhere. Seats go to the least-asked, then to whoever
   * was asked longest ago, then to a deterministic per-session jitter. The
   * same room in the same state seats the same people every time.
   *
   * THE REFUND CORRECTION, which is not a detail. Six of twenty-six students
   * sit in the simulator's disengaged profile and will never take step one.
   * If an unused invitation is simply handed back, their asked count stays at
   * zero forever, they are seated first for every posting of the whole unit,
   * and they consume about half the seats while using none. Refunds are
   * counted separately and rank alongside asks — a lapse still costs less
   * than a taken invitation, so a slow reader is still favoured, but a
   * student who has ignored three stops outranking a student who has had one.
   *
   * SEATED AGAINST WHO SAT DOWN TODAY, not against liveStudents(). The client
   * pings every eight seconds but Chrome throttles a backgrounded tab to
   * about once a minute, and during a read segment the turn is closed so
   * nothing wakes it. Seating on a fifteen-second liveness window would quietly
   * skip the student whose tab is behind the browser. */
  _seatPostings(seg) {
    const postings = (seg && seg.postings) || [];
    if (!postings.length) return {};
    this._lastPostings = seg;

    /* everyone who sat down today, whatever their tab is doing now */
    const here = this.attended[this.sessionIndex] || {};
    const pool = Object.values(this.students).filter((st) => here[st.characterId]);

    const out = {};
    postings.forEach((post) => {
      this._postingDefs[post.id] = post;
      const rule = { requires: post.eligible || {} };
      const eligible = pool.filter((st) => this.engine.meets(rule, this.ctxFor(st)));

      /* decision 11: seats are cut to the room. A posting of four in a class
       * of five is not an invitation, it is an assembly. */
      let seats = post.seats || 0;
      if (post.per_student) seats = Math.round(post.per_student * eligible.length);
      seats = Math.max(post.min || 1, seats);
      if (post.max) seats = Math.min(post.max, seats);
      seats = Math.min(seats, eligible.length);

      const ranked = eligible.slice().sort((a, b) => {
        const sc = (st) => 99 - (this.asked[st.characterId] || 0) - (this.refunds[st.characterId] || 0);
        if (sc(a) !== sc(b)) return sc(b) - sc(a);
        const at = (st) => this.askedAt[st.characterId] || 0;
        if (at(a) !== at(b)) return at(a) - at(b);          // longest ago first
        return this._jitter(post.id, a.characterId) - this._jitter(post.id, b.characterId);
      });

      const seated = ranked.slice(0, seats);
      seated.forEach((st) => {
        st.flags['INV_' + post.id] = true;
        this.asked[st.characterId] = (this.asked[st.characterId] || 0) + 1;
        this.askedAt[st.characterId] = this.now();
      });
      out[post.id] = seated.map((st) => st.characterId);
    });
    this._emit();
    return out;
  }

  /* Deterministic, and only a tie-breaker. Two students with an identical
   * history need SOME order, and it must be the same order on a restore from
   * disk — so it is a hash of the posting and the character, never a roll.
   *
   * IT HAS TO ACTUALLY MIX. The first version here was `h * 31 + charCode`,
   * which is monotonic in the trailing characters: every posting produced the
   * order p01, p02, p03 ... so on the first posting of the unit, when nobody
   * has been asked anything and every student ties, the seats went down the
   * roster in order and p30 was last every single time. A tie-break that is
   * secretly alphabetical is the favouritism this whole rule exists to stop.
   * FNV-1a with a murmur3 finaliser, checked to permute across posting ids. */
  _jitter(postId, characterId) {
    const key = this.sessionIndex + ':' + postId + ':' + characterId;
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= h >>> 15; h = Math.imul(h, 2246822507);
    h ^= h >>> 13; h = Math.imul(h, 3266489909);
    return (h ^ (h >>> 16)) >>> 0;
  }

  /* An invitation is for the period it was given in. One still unspent when
   * the next session loads is a lapse: the flag comes off and the lapse is
   * counted, which is what stops a student who never acts from monopolising
   * the queue. */
  _refundLapsed() {
    this._allStudents().forEach((st) => {
      Object.keys(st.flags || {}).forEach((f) => {
        if (f.indexOf('INV_') !== 0) return;
        const id = f.slice(4);
        if (!st.flags['DONE_' + id]) {
          this.refunds[st.characterId] = (this.refunds[st.characterId] || 0) + 1;
        }
        delete st.flags[f];
      });
    });
  }

  /* THE BOSS TAKES ITS TURN — segment.toll.
   *
   * The only genuinely new capability in the boss design. It borrows the
   * outcome vocabulary exactly — clocks, resource, world (applied once, to
   * the room) and resolve, clear_resolve, set_flags (applied to each
   * student who did not get out of the way).
   *
   * WHY IT FIRES FROM _tick AND NOT FROM _enter. A toll that goes off only
   * at a segment boundary is a slide transition. The tell has to arrive
   * BEFORE the damage, several times inside one beat, or there is nothing
   * to react to. toll.at is an array of second-offsets into the segment and
   * toll.warn broadcasts toll.lead seconds ahead of each one. Three phases
   * times two tolls is six moments where the room can see it coming.
   *
   * TWO EXEMPTIONS, AND THEY ARE THE TACTICAL LAYER.
   *   except_flag    — GUARDED. Thirteen shipped GUARD actions write that
   *                    flag at applyOutcome and nothing in this repository
   *                    has ever read it. This is the first read.
   *   except_hex_in  — a named cover set, so the answer to the tell is
   *                    positional and not only social. In the ring you push
   *                    the bar; in cover you take no toll.
   *
   * Nothing here requires a second student to exist. With a class of one,
   * the flag exemption is simply unavailable and the cover hexes are not —
   * which is the point of having both. */
  _toll() {
    const s = this._seg();
    if (!s || !s.toll) return;
    const t = s.toll;
    if (!this._tollHit) { this._tollHit = {}; this._tollWarned = {}; }
    const lead = t.lead === undefined ? 10 : t.lead;

    (t.at || []).forEach((sec, i) => {
      if (t.warn && !this._tollWarned[i] &&
          this.elapsed >= sec - lead && this.elapsed < sec) {
        this._tollWarned[i] = true;
        this.note(t.warn, 'warn');
        this.broadcasts.unshift({ t: this.now(), text: t.warn });
        this.broadcasts = this.broadcasts.slice(0, 6);
        this._emit();
      }
      if (!this._tollHit[i] && this.elapsed >= sec) {
        this._tollHit[i] = true;
        this._applyToll(t);
        this._emit();
      }
    });
  }

  _applyToll(t) {
    /* Once, to the room. */
    if (t.world) Object.assign(this.world, t.world);
    if (t.clocks) {
      Object.keys(t.clocks).forEach((k) => {
        const c = this.clocks[k];
        if (c) c.filled = Math.max(0, Math.min(c.segments, c.filled + t.clocks[k]));
      });
    }
    if (t.resource) {
      Object.keys(t.resource).forEach((k) => {
        const l = this.ledger[k];
        if (l) l.value = Math.max(0, l.value + t.resource[k]);
      });
    }

    /* Once each, to everybody it actually reaches. */
    const cover = t.except_hex_in || [];
    const flags = t.except_flag || [];
    let hit = 0, spared = 0;
    const savedByFlag = [];
    this.liveStudents().forEach((st) => {
      const safeByFlag = flags.some((f) => st.flags[f]);
      const safeByHex = cover.indexOf(st.hex) !== -1;
      if (safeByFlag || safeByHex) {
        spared++;
        if (safeByFlag) savedByFlag.push(st);
        return;
      }
      hit++;
      if (t.resolve) st.resolveUsed = Math.min(st.resolve, st.resolveUsed + t.resolve);
      if (t.clear_resolve) st.resolveUsed = Math.max(0, st.resolveUsed - t.clear_resolve);
      (t.set_flags || []).forEach((f) => { st.flags[f] = true; });
    });

    /* GUARDED is spent when it saves you, and only then. A student who stood
     * in front of somebody bought them ONE toll, not the whole phase — but a
     * student who was in cover anyway keeps the shield for the next one. */
    savedByFlag.forEach((st) => { delete st.flags.GUARDED; });

    if (t.broadcast) {
      const text = String(t.broadcast)
        .split('{hit}').join(String(hit))
        .split('{spared}').join(String(spared));
      this.note(text, 'weak');
      this.broadcasts.unshift({ t: this.now(), text });
      this.broadcasts = this.broadcasts.slice(0, 6);
    }
  }

  applyOutcome(st, o, ctx) {
    if (!o) return;
    (o.teach || []).forEach((f) => {
      if (!st.taught[f]) st.taughtVia[f] = ctx && ctx.viaFallback ? 'fallback' : 'play';
      st.taught[f] = true;
      this._giveDocFor(st, f);
    });
    (o.set_flags || []).forEach((f) => { st.flags[f] = true; });
    (o.clear_flags || []).forEach((f) => { delete st.flags[f]; });
    st.flags.ACTED_THIS_SCENE = true;

    if (o.world) Object.assign(this.world, o.world);
    if (o.clocks) {
      Object.keys(o.clocks).forEach((k) => {
        const c = this.clocks[k];
        if (c) c.filled = Math.max(0, Math.min(c.segments, c.filled + o.clocks[k]));
      });
    }
    if (o.resource) {
      Object.keys(o.resource).forEach((k) => {
        const l = this.ledger[k];
        if (l) l.value = Math.max(0, l.value + o.resource[k]);
      });
    }
    if (o.standing) {
      this.standing = this.standing || {};
      Object.keys(o.standing).forEach((k) => {
        this.standing[k] = (this.standing[k] || 0) + o.standing[k];
      });
    }
    /* Diminishing returns on the repeatables. HOLD is a legitimate choice and
     * a bad strategy: it pays Legacy the first time in a scene and nothing
     * after. risk-review R11 predicted the farming; the simulator showed it. */
    if (o.legacy) {
      const once = st.paidLegacy || (st.paidLegacy = {});
      const key = ctx && ctx.actionId ? ctx.actionId : '_';
      const repeatable = ctx && ctx.repeatable;
      if (!repeatable || !once[key]) {
        st.legacy += o.legacy;
        once[key] = true;
      }
    }
    if (o.resolve) st.resolveUsed = Math.min(st.resolve, st.resolveUsed + o.resolve);
    if (o.clear_resolve) st.resolveUsed = Math.max(0, st.resolveUsed - o.clear_resolve);

    /* THE ABILITY KEYS. Each exists because a Calling Card in a student's
     * hand already promises exactly this and the app has to agree with the
     * paper — that is the whole lesson of the Calling repair.
     *
     * HANDS says "clear one Resolve box from your company", which is not a
     * neighbour and not yourself. It reaches your company wherever they are
     * standing, and with a class of one that is a company of one. */
    if (o.clear_resolve_company) {
      this.liveStudents()
        .filter((x) => x.company === st.company)
        .forEach((x) => { x.resolveUsed = Math.max(0, x.resolveUsed - o.clear_resolve_company); });
    }
    /* THE LEDGER says "they must help you, now" — the aid runs toward the
     * student who spent the ability, which is the opposite direction from
     * aid_target and the reason it needs its own key. */
    if (o.aid_self) st.aidBonus = (st.aidBonus || 0) + o.aid_self;
    /* STEADY is banked and spent later, in resolve(). */
    if (o.tier_up) st.tierUp = (st.tierUp || 0) + o.tier_up;

    /* An action can pay in objects. Through giveItem like everything else,
     * so the slot rule holds and a full hand declines rather than swaps —
     * a quest reward is not allowed to be the one thing that ignores it. */
    if (o.grant_item) [].concat(o.grant_item).forEach((id) => this.giveItem(st, id));
    if (o.grant_move) st.moveLeft += o.grant_move;

    /* AID, GUARD and MEND reach across to a neighbour — the co-op that makes
     * the reserve ladder's first rung worth being on.
     *
     * clear_resolve_target used to sit INSIDE this gate, so an action that
     * carried only clear_resolve_target fired, narrated, cost the student
     * their turn and changed nothing. Both shipped uses ride along with an
     * aid, which is why it worked. The boss's MEND does not. */
    if (o.aid_target || o.guard_target || o.clear_resolve_target) {
      const near = this.engine.neighbours(st, ctx);
      if (near.length) {
        const t = this.students[near[0].sid] ||
                  Object.values(this.students).filter((x) => x.characterId === near[0].characterId)[0];
        if (t) {
          if (o.aid_target) t.aidBonus = (t.aidBonus || 0) + 1;
          if (o.clear_resolve_target) t.resolveUsed = Math.max(0, t.resolveUsed - o.clear_resolve_target);
          if (o.guard_target) t.flags.GUARDED = true;
        }
      }
    }
  }

  note(text, tier) {
    this.feed.unshift({ t: this.now(), text, tier: tier || null });
    this.feed = this.feed.slice(0, 40);
  }

  /* design/14: every student's name reaches the Stage at least once a session.
   * A busy human cannot distribute this fairly; a scheduler can. Good moments
   * are preferred, but nobody is left out because their rolls were dull. */
  spotlight(st, r, ctx) {
    const broadcast = r.outcome.broadcast;
    const strong = r.tier === 'strong';
    if (!broadcast && !strong && this.spotlighted[st.characterId]) return;
    const label = ctx ? this.engine.fillIn(r.action.label, ctx) : r.action.label;
    const text = broadcast
      ? String(broadcast).split('{name}').join(st.name)
      : st.name + ' — ' + label;
    this.spotlighted[st.characterId] = true;
    this.broadcasts.unshift({ t: this.now(), text });
    this.broadcasts = this.broadcasts.slice(0, 6);
  }

  sessionCoverage() {
    const live = this.liveStudents();
    return {
      need: this.sessionMustTeach.length,
      short: live.filter((st) =>
        this.sessionMustTeach.some((f) => !st.taught[f])).length,
      total: live.length,
    };
  }

  coverage() {
    const c = this.engine.coverage(this.liveStudents());
    const live = this.liveStudents();
    c.students.forEach((row) => {
      const st = live.filter((x) => x.characterId === row.characterId)[0];
      row.via = st ? Object.assign({}, st.taughtVia) : {};
    });
    /* Facts a student only ever heard at the bell are a different thing from
     * facts they went and found. The grid shows both. */
    c.recordOnly = live.reduce((a, st) =>
      a + Object.keys(st.taughtVia).filter((k) => st.taughtVia[k] === 'record').length, 0);
    return c;
  }

  /* ------------------------------------------------------------ persistence
   *
   * Two different things are being remembered, and conflating them would be a
   * mistake:
   *
   *   THE PERIOD    where today's lesson had got to. Survives a crash, a closed
   *                 lid, a restarted laptop. Restores PAUSED — see below.
   *   THE CAMPAIGN  what carries between sessions: the Gonzales Ledger, each
   *                 student's Legacy and flags, the standing of the ranchos,
   *                 who has been retired. This is what makes 4th period's
   *                 campaign different from 7th period's.
   */
  _allStudents() {
    /* Restored characters need not reconnect before the next autosave. A live
     * device always supplies the current state if an older parked copy exists. */
    const byCharacter = new Map();
    Object.values(this.parked).forEach((st) => byCharacter.set(st.characterId, st));
    Object.values(this.students).forEach((st) => byCharacter.set(st.characterId, st));
    return Array.from(byCharacter.values());
  }

  toJSON() {
    return {
      v: 1,
      code: this.code,
      savedAt: Date.now(),
      session: this.data.session,
      sessionIndex: this.sessionIndex,
      period: {
        started: this.started,
        idx: this.idx,
        elapsed: this.elapsed,
        extra: this.extra,
        sceneId: this.sceneId,
        startedAt: this.startedAt,
        manualRead: this.manualRead,
        segmentRevision: this.segmentRevision,
        outcomeSeq: this.outcomeSeq,
        challengeResult: this.challengeResult,

        finished: !!this.closedOut,
      },
      campaign: {
        clocks: this.clocks,
        ledger: this.ledger,
        standing: this.standing || {},
        world: this.world,
        challengeResults: this.challengeResults,
        tally: this.tally,
        retired: this.retired,
        standIns: this.standIns,
        attended: this.attended,
        /* A period that was ever rehearsed is marked forever. It shares a
         * save file with real classes and must never be confused for one. */
        wasTestMode: !!(this.testMode || this.wasTestMode),
        asked: this.asked,
        postingDefs: this._postingDefs,
        refunds: this.refunds,
        askedAt: this.askedAt,
        features: Object.values(this._featIx).map((e) => ({ id: e.f.id, open: e.f.open, searched: e.f.searched, takenBy: e.f.takenBy || {} })),
        spotlighted: this.spotlighted,
      },
      students: this._allStudents().map((st) => {
        return {
          characterId: st.characterId, hex: st.hex, moveLeft: st.moveLeft,
          words: st.words, wordsSpent: st.wordsSpent,
          resolve: st.resolve, resolveUsed: st.resolveUsed, legacy: st.legacy,
          declared: st.declared, acted: st.acted, verb: st.verb,
          actionsLeft: st.actionsLeft,
          aidBonus: st.aidBonus || 0, tierUp: st.tierUp || 0,
          lastOutcome: st.lastOutcome || null, caughtUp: st.caughtUp || null,
          tint: st.tint, tintIndex: st.tintIndex,
          docs: st.docs || [],
          trail: st.trail || [],
          flags: st.flags, taught: st.taught, taughtVia: st.taughtVia,
          used: st.used, paidLegacy: st.paidLegacy, items: st.items,
          place: st.place, anchor: st.anchor,
          lastActionId: st.lastActionId,
        };
      }),
      history: this.history || [],
    };
  }

  restore(d) {
    if (!d || d.v !== 1) return false;

    if (typeof d.sessionIndex === 'number' && d.sessionIndex !== this.sessionIndex) {
      this.loadSession(d.sessionIndex);
    }

    const c = d.campaign || {};
    if (c.clocks) this.clocks = c.clocks;
    if (c.ledger) this.ledger = c.ledger;
    this.standing = c.standing || {};
    this.world = c.world || {};
    this.challengeResults = c.challengeResults || {};
    this.tally = c.tally || {};
    this.retired = c.retired || {};
    this.standIns = c.standIns || {};
    this.attended = c.attended || {};
    this.wasTestMode = !!c.wasTestMode;
    this.asked = c.asked || {};
    this._postingDefs = c.postingDefs || {};
    this.refunds = c.refunds || {};
    this.askedAt = c.askedAt || {};
    (c.features || []).forEach((sf) => {
      const f = this.feature(sf.id);
      if (!f) return;
      if (sf.open !== undefined) f.open = sf.open;
      if (sf.searched !== undefined) f.searched = sf.searched;
      if (sf.takenBy) f.takenBy = sf.takenBy;
    });
    this.spotlighted = c.spotlighted || {};
    this.history = d.history || [];

    const p = d.period || {};
    if (p.sceneId && this.engines[p.sceneId]) {
      this.sceneId = p.sceneId;
      this.engine = this.engines[p.sceneId];
      this.scene = this.scenes[p.sceneId];
      this.npcHex = {};
      (this.scene.npcs || []).forEach((n) => { this.npcHex[n.id] = n.hex; });
    }
    this.started = !!p.started;
    this.idx = Math.max(0, Math.min(this.segs.length - 1, p.idx | 0));
    this.elapsed = p.elapsed || 0;
    this.extra = p.extra || 0;
    this.startedAt = p.startedAt || 0;
    this.manualRead = !!p.manualRead;
    this.segmentRevision = p.segmentRevision || 0;
    this.outcomeSeq = p.outcomeSeq || 0;
    this.challengeResult = p.challengeResult || null;

    /* Older saves marked any pause on the final segment as finished. Require
     * its completed history entry, which also makes closeOut idempotent after
     * restarting an actually completed period. */
    this.closedOut = !!p.finished && this.history.some((h) => h.session === this.data.session);

    /* RESTORE PAUSED, ALWAYS.
     *
     * A server that comes back mid-period must not silently resume a lesson
     * whose room has moved on. Something interrupted it — a crash, a closed
     * lid, a power cut — and the teacher is the only one who knows whether the
     * class is still in their seats. So the period is held and the console says
     * where it stopped; pressing Resume is a decision, not a default. */
    this.running = false;
    this.resumedFromDisk = this.started;

    (d.students || []).forEach((sd) => {
      const person = (this.rosterData.roster || [])
        .filter((x) => x.id === sd.characterId)[0];
      if (!person) return;
      /* Held under the character id, not a device. Whichever Chromebook that
       * student picks up on Monday, the character it claims is the one that
       * has their Legacy and their flags. */
      this.parked[sd.characterId] = Object.assign({}, person, sd, {
        moveBase: person.move,
        stats: person.stats,
      });
    });
    return true;
  }

  /* Called when the last segment finishes: fold today into the campaign so the
   * next session opens on the numbers this one left behind. */
  closeOut() {
    if (this.closedOut) return;
    this.closedOut = true;
    const live = this.liveStudents();
    this.history = (this.history || []).concat([{
      session: this.data.session,
      endedAt: Date.now(),
      /* everybody who sat down for this one, whether or not their Chromebook
       * was still awake when the bell went */
      present: Object.keys(this.attended[this.sessionIndex] || {}),
      clocks: JSON.parse(JSON.stringify(this.clocks)),
      ledger: JSON.parse(JSON.stringify(this.ledger)),
      standing: Object.assign({}, this.standing || {}),
      legacy: live.reduce((a, st) => a + st.legacy, 0),
      students: live.map((st) => ({
        characterId: st.characterId,
        legacy: st.legacy,
        flags: Object.keys(st.flags),
        taughtVia: st.taughtVia,
      })),
    }]);
    this.note('session closed — carry-forward saved', null);
    /* The tally IS the consequence for the Matamoros question: no roll, just a
     * record of what this town decided, waiting for the session that asks. */
    if (Object.keys(this.tally).length) {
      this.history[this.history.length - 1].decision = Object.assign({}, this.tally);
    }
  }

  onChange(fn) { if (!this.destroyed) this.saver = fn; }
  _dirty() {
    if (this.destroyed || !this.saver) return;
    if (this._saveTimer) return;
    /* Debounced: the timeline emits four times a second and a school laptop
     * should not be writing to disk that often. */
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try { this.saver(this); } catch (e) {}
    }, 3000);
  }

  /* ------------------------------------------------------------- snapshot */
  liveStudents() {
    const now = this.now();
    return Object.values(this.students).filter((s) => now - s.seen < 15000);
  }

  snapshot() {
    const seg = this._seg();
    const len = this._len();
    const live = this.liveStudents();

    return {
      room: this.code,
      meta: {
        session: this.data.session, title: this.data.title, subtitle: this.data.subtitle,
        datestamp: this.data.datestamp, teks: this.data.teks,
        periodMinutes: this.data.periodMinutes, bellSlackMin: this.data.bellSlackMin,
        /* what there is to choose from. Six at most, and static. */
        sessions: this.sessions.map((s, i) => ({
          index: i, session: s.session, title: s.title,
        })),
      },
      started: this.started,
      running: this.running,
      playMode: this.playMode,
      challengeResult: this.challengeResult,
      roamOpen: this.roamOpen,
      /* A period that was REHEARSED must never be mistaken for one that
       * happened. Every screen gets this. */
      testMode: !!this.testMode,
      manualRead: this.manualRead,
      resumedFromDisk: !!this.resumedFromDisk,
      priorSessions: (this.history || []).length,
      sessionIndex: this.sessionIndex,
      sessionCount: this.sessions.length,
      canAdvance: !!this.closedOut && this.sessionIndex < this.sessions.length - 1,
      index: this.idx,
      segmentRevision: this.segmentRevision,
      count: this.segs.length,
      segment: seg,
      elapsed: this.elapsed,
      length: len,
      remaining: Math.max(0, len - this.elapsed),
      extra: this.extra,
      turnOpen: this.turnOpen,
      clocks: JSON.parse(JSON.stringify(this.clocks)),
      ledger: JSON.parse(JSON.stringify(this.ledger)),
      tally: Object.assign({}, this.tally),
      lastRoll: this.lastRoll,

      /* THE ROOM, computed server-side so the console never has to guess */
      viewers: this.viewers,
      world: Object.assign({}, this.world),
      light: this.light(),
      place: this.sceneMapId(),
      townsfolk: this.townsfolk(),
      standInsOn: this.standInsOn,
      balance: this.balanceSummary(),
      npcs: (this.scene.npcs || []).map((x) => ({
        id: x.id, name: x.name, hex: this.npcHex[x.id] || x.hex,
        place: x.place || this.sceneMapId(), color: x.color || null })),
      feed: this.feed.slice(0, 12),
      broadcasts: this.broadcasts.slice(0, 3),
      coverage: this.coverage(),
      caughtUp: live.filter((s) => s.caughtUp).map((s) => ({
        name: s.name, sessions: s.caughtUp.sessions, facts: s.caughtUp.facts.length })),
      /* CONSTRAINT F, THE RUNTIME RECORD.
       * Proving the JSON names all thirty ids proves the JSON, not the
       * delivery: an invitation that fires on a day a student is away leaves
       * the build green and the student unasked. This is the count of what
       * was actually offered, so the console can show an ASKED column and the
       * teacher can see who is overdue.
       *
       * FOR THE CONSOLE ONLY. stage.js must never render this. A standing
       * list of who has been picked is a public tally that a class will be
       * counting out loud by Tuesday, and what they will be counting is who
       * the teacher's computer likes. room_status.idle sets the precedent:
       * names on the wire that the projector chooses not to draw. */
      asked: (this.rosterData.roster || []).reduce((a, p) => {
        a[p.id] = {
          name: p.name,
          asked: this.asked[p.id] || 0,
          refunds: this.refunds[p.id] || 0,
          at: this.askedAt[p.id] || 0,
        };
        return a;
      }, {}),
      room_status: {
        connected: live.length,
        acted: live.filter((s) => s.acted).length,
        idle: live.filter((s) => this.now() - s.seen > 90000).map((s) => s.name),
      },
      students: live.map((s) => ({
        characterId: s.characterId, name: s.name, company: s.company, color: s.color,
        hex: s.hex, moveLeft: s.moveLeft, declared: s.declared, acted: !!s.acted,
        /* E4 · the boss deals resolve, so the room has to be able to see who
         * is carrying it. Rendered nowhere before this. */
        resolve: s.resolve, resolveUsed: s.resolveUsed,
        tint: s.tint || s.color,
        verb: s.verb, calling: s.calling, companyName: s.companyName,
        place: this.placeId(s), anchor: s.anchor || null,
        wordsLeft: s.words - s.wordsSpent, legacy: s.legacy,
      })),

      budget: {
        authored: this.segs.reduce((a, s) => a + s.seconds, 0),
        allowed: (this.data.periodMinutes - this.data.bellSlackMin) * 60,
        toBell: (this.data.periodMinutes * 60) -
                (this.startedAt ? (this.now() - this.startedAt) / 1000 : 0),
        remainingAuthored: (() => {
          let a = Math.max(0, len - this.elapsed);
          for (let k = this.idx + 1; k < this.segs.length; k++) a += this.segs[k].seconds;
          return a;
        })(),
      },
      outline: this.segs.map((x, i) => ({
        id: x.id, kind: x.kind, label: x.label || x.eyebrow || x.title || x.id,
        turn: x.turn || null, seconds: x.seconds,
        state: i < this.idx ? 'done' : (i === this.idx ? 'live' : 'ahead'),
      })),
    };
  }

  /* What one student is allowed to know about themselves. */
  privateFor(sid) {
    const st = this.students[sid];
    if (!st) return null;
    const mp = this.mapFor(st);
    /* Reach is drawn whenever walking is allowed, which now includes a
     * roaming read segment. */
    const reach = this.roamOpen && (this.movementFree || st.moveLeft > 0)
      ? mp.reachable(st.hex, this.movementFree ? 10000 : st.moveLeft, this._moveOpts(st))
      : {};
    const portal = mp.portalAt(st.hex);
    const actions = this.offerFor(sid);
    return {
      characterId: st.characterId, name: st.name, role: st.role, calling: st.calling,
      tint: st.tint || st.color, tintIndex: st.tintIndex,
      /* the documents this student has been given, oldest first */
      docs: (st.docs || []).slice(),
      /* what they did today, in the order they did it */
      trail: (st.trail || []).slice(),
      companyName: st.companyName, color: st.color,
      ability: st.ability, abilityBlurb: st.abilityBlurb,
      hex: st.hex, move: st.move, moveLeft: st.moveLeft,
      movementFree: this.movementFree,
      guidance: Adventure.guidance(this, st, actions),
      /* the dashed ring hexmap.js has been ready to draw all along */
      target: this.targetFor(st),
      place: mp.id, placeTitle: mp.title, indoors: !!mp.indoors,
      /* The way out of where you are, if you are standing on it. This is what
       * the GO INSIDE / GO OUT button is made of. */
      portal: (portal && portal.open !== false && (this.movementFree || st.moveLeft > 0)) ? {
        id: portal.id, label: portal.to.label || 'Go through',
        into: (this.maps[portal.to.place] || {}).title || portal.to.place,
        out: !!(this.maps[portal.to.place] && !this.maps[portal.to.place].indoors),
      } : null,
      light: this.light(),

      /* E3 · the bars, on the student's own device. privateFor sent no
       * clocks at all, so a student in a fight could only find out how it
       * was going by looking away from their own screen at the wall. */
      /* YOUR OWN INVITATIONS, AND ONLY YOUR OWN. A student is never told who
       * else was asked — that is the standing public tally this design exists
       * to avoid. */
      invites: Object.keys(st.flags || {})
        .filter((f) => f.indexOf('INV_') === 0)
        .map((f) => {
          const id = f.slice(4);
          const def = this._postingDefs[id] || {};
          return {
            id: id,
            title: def.title || id,
            line: def.line || '',
            where: def.where || '',
            done: !!st.flags['DONE_' + id],
          };
        }),

      /* HOW MANY DAYS. The householder's card promises "declare the true
       * number - of food, powder, or time. Everyone must act on it." So the
       * ledger is not on a student's screen until somebody declares it, and
       * then it is on ALL of them. One student, eight of thirty can do it,
       * and it changes what twenty-nine other people are looking at. */
      ledger: this.world.TRUE_NUMBER_DECLARED
        ? Object.keys(this.ledger).map((k) => ({
          id: k, label: this.ledger[k].label,
          value: this.ledger[k].value, unit: this.ledger[k].unit,
        }))
        : null,
      clocks: Object.keys(this.clocks).map((k) => ({
        id: k, label: this.clocks[k].label,
        filled: this.clocks[k].filled, segments: this.clocks[k].segments,
      })),
      words: st.words, wordsSpent: st.wordsSpent,
      resolve: st.resolve, resolveUsed: st.resolveUsed,
      legacy: st.legacy, declared: this.challengeOpen && st.declared, acted: !!st.acted, verb: st.verb,
      actionsLeft: st.actionsLeft,
      stats: this.effective(st).stats,
      items: (st.items || []).map((id) => this.item(id)).filter(Boolean),
      features: (mp.features || []).map((f) => ({
        id: f.id, kind: f.kind, hex: f.hex, label: f.label,
        open: f.open,
        /* PER VIEWER. hexmap.js, play.js and the legend all draw the
         * chest-done glyph from this field; sending the room-wide value
         * would grey out chests this student has never touched. */
        searched: (f.kind === 'chest' || f.kind === 'body' || f.kind === 'job')
          ? !this.engine.openTo(f, st) : f.searched,
        to: f.to || null })),
      townsfolk: this.townsfolk().filter((t) => t.place === mp.id),
      /* Only the people who are in the same PLACE as this student. Somebody
       * inside the store is not in the square, and must not be drawn there. */
      npcs: (this.scene.npcs || [])
        .filter((x) => (x.place || this.sceneMapId()) === mp.id)
        .map((x) => ({ id: x.id, name: x.name, hex: this.npcHex[x.id] || x.hex })),
      reach: Object.keys(reach).map((k) => {
        const p = k.split(',').map(Number);
        return { hex: mp.label(p[0], p[1]), cost: reach[k] };
      }),
      actions,
      lastOutcome: st.lastOutcome,
      /* shown once, then cleared, so a reload does not replay it */
      caughtUp: st.caughtUp || null,
      taught: Object.keys(st.taught),
      flags: Object.keys(st.flags),
      owed: this.engine.owedFacts(st).length,
    };
  }
}

module.exports = { Room };
