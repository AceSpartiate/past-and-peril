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
const { Engine } = require('./engine.js');

const TICK_MS = 250;

class Room {
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
    this.manualRead = false;
    this.lastRoll = null;

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
    const spread = [];
    const seed = dest.parse(dest.data.entry || '');
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
    Object.values(this.students).forEach((st) => {
      if (this.placeId(st) === want) { taken[st.hex] = true; return; }
      const back = st.anchor && st.anchor.place === want ? st.anchor.hex : null;
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
  destroy() { if (this.timer) clearInterval(this.timer); this.subs.clear(); }

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
    this.sessionMustTeach = [];
    Object.values(this.scenes).forEach((sc) => {
      if (sc.session !== next.session) return;
      (sc.must_teach || []).forEach((f) => {
        if (this.sessionMustTeach.indexOf(f) === -1) this.sessionMustTeach.push(f);
      });
    });
    Object.values(this.students).forEach((st) => {
      st.used = {}; st.paidLegacy = {}; st.declared = false; st.verb = null;
      st.lastOutcome = null; st.wordsSpent = 0;
      delete st.flags.ACTED_THIS_SCENE;
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
    this.idx = Math.max(0, Math.min(this.segs.length - 1, i));
    this.elapsed = 0;
    this.extra = 0;
    this.segStamp = this.now();
    const s = this._seg();

    if (s && s.clocks) {
      Object.keys(s.clocks).forEach((k) => {
        const c = this.clocks[k];
        if (c) c.filled = Math.min(c.segments, c.filled + s.clocks[k]);
      });
    }
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
      Object.values(this.students).forEach((st) => {
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
      Object.values(this.students).forEach((st) => {
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
      Object.values(this.students).forEach((st) => {
        st.docs = st.docs || [];
        if (st.docs.indexOf(s.handout) === -1) st.docs.push(s.handout);
      });
      this.handedOut = this.handedOut || [];
      if (this.handedOut.indexOf(s.handout) === -1) this.handedOut.push(s.handout);
    }

    /* A new turn window refreshes everyone's movement and clears last turn's
     * declaration. The server decides this so thirty clients cannot disagree. */
    if (this._isTurn(s)) {
      Object.values(this.students).forEach((st) => {
        st.move = this.effective(st).move;
        st.moveLeft = st.move;
        st.actionsLeft = this.actionsPerWindow;
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
  get turnOpen() { return this.started && this.running && this._isTurn(this._seg()); }

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
    if (holder && holder !== sid) {
      const prev = this.students[holder];
      const quiet = !prev || (this.now() - prev.seen) > 15000;
      if (!quiet) {
        return { ok: false, error: 'taken', message: 'Somebody is already playing that person.' };
      }
      delete this.students[holder];      // they went quiet: this is a reconnect
    }

    const existing = this.students[sid] || this.parked[characterId];
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
      actionsLeft: existing ? existing.actionsLeft : this.actionsPerWindow,
      used: existing ? existing.used : {},
      verb: existing ? existing.verb : null,
      origin: person.origin,
      mark: person.mark,
      stats: person.stats,
      strength: person.strength,
      flags: existing ? existing.flags : {},
      taught: existing ? existing.taught : {},
      taughtVia: existing ? existing.taughtVia : {},
      lastActionId: existing ? existing.lastActionId : null,
      aidBonus: 0,
      lastOutcome: existing ? existing.lastOutcome : null,
      seen: this.now(),
    };
    delete this.parked[characterId];
    delete this.standIns[characterId];      // the stand-in is relieved
    this.students[sid] = st;
    const seat = (this.attended[this.sessionIndex] = this.attended[this.sessionIndex] || {});
    const firstToday = !seat[characterId];
    seat[characterId] = true;

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
    this.parked[st.characterId] = {
      characterId: st.characterId, hex: st.hex, moveLeft: st.moveLeft,
      words: st.words, wordsSpent: st.wordsSpent,
      resolve: st.resolve, resolveUsed: st.resolveUsed, legacy: st.legacy,
      declared: st.declared, acted: st.acted, verb: st.verb,
      tint: st.tint, tintIndex: st.tintIndex,
      docs: st.docs || [],
      flags: st.flags, taught: st.taught, taughtVia: st.taughtVia,
      used: st.used, paidLegacy: st.paidLegacy, items: st.items,
      place: st.place, anchor: st.anchor,
      lastActionId: st.lastActionId,
    };
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
    if (!this.turnOpen) return { ok: false, error: 'closed' };

    const mp = this.mapFor(st);
    const target = mp.parse(hexLabel);
    if (!target || !mp.terrain(target.c, target.r)) return { ok: false, error: 'no-such-hex' };

    const reach = mp.reachable(st.hex, st.moveLeft, this._moveOpts(st));
    const cost = reach[target.c + ',' + target.r];
    if (cost === undefined) return { ok: false, error: 'out-of-range' };

    st.moveLeft -= cost;
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
    if (!this.turnOpen) return { ok: false, error: 'closed' };
    const f = this.feature(featureId);
    if (!f || !f.to || !this.maps[f.to.place]) return { ok: false, error: 'no-such-way' };
    if (this.featurePlace(featureId) !== this.placeId(st)) return { ok: false, error: 'not-here' };
    if (st.hex !== f.hex) return { ok: false, error: 'not-on-it' };
    if (f.open === false) return { ok: false, error: 'shut' };
    if (st.moveLeft < 1) return { ok: false, error: 'no-move-left' };

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
    st.moveLeft -= 1;
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
  effective(st) {
    const stats = Object.assign({}, st.stats);
    let move = st.moveBase + (stats.land || 0);
    (st.items || []).forEach((id) => {
      const it = this.item(id);
      if (!it || !it.effect) return;
      if (it.effect.move) move += it.effect.move;
      Object.keys(it.effect.stat || {}).forEach((k) => { stats[k] = (stats[k] || 0) + it.effect.stat[k]; });
    });
    return { stats, move };
  }

  /* ------------------------------------------------------------- the engine */
  ctxFor(st) {
    /* The engine rolls against EFFECTIVE stats, so a powder horn or the colony
     * papers are worth something at the table and not just in an inventory. */
    const eff = this.effective(st);
    const view = Object.assign(Object.create(Object.getPrototypeOf(st)), st, { stats: eff.stats });
    return {
      student: view,
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
    if (!this.turnOpen || st.declared) return [];
    return this.engine.offer(this.ctxFor(st));
  }

  /* One action per turn window. Declaring does NOT end movement — deciding
   * early must never park a student (the idle floor, design/08). */
  perform(sid, actionId) {
    const st = this.students[sid];
    if (!st) return { ok: false, error: 'not-joined' };
    if (!this.turnOpen) return { ok: false, error: 'closed' };
    if (st.declared) return { ok: false, error: 'already-declared' };

    const ctx = this.ctxFor(st);
    const r = this.engine.resolve(actionId, ctx, { aidBonus: st.aidBonus });
    if (!r.ok) return r;
    /* World actions: searching a container, working a door. */
    if (r.action.loot) {
      const f = this.feature(r.action.loot);
      if (!f || f.searched) return { ok: false, error: 'already-searched' };
      f.searched = true;
      st.items = (st.items || []).concat(f.contents || []);
      const names = (f.contents || []).map((i) => (this.item(i) || {}).name).filter(Boolean);
      st.move = this.effective(st).move;
      r.outcome = Object.assign({}, r.outcome, {
        narrate: names.length
          ? 'You go through it. ' + names.join(', and ') + '.'
          : 'Somebody has already been through this.',
        legacy: 1,
      });
      r.gained = names;
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
    if (r.cost.move) st.moveLeft -= r.cost.move;
    if (r.cost.word) st.wordsSpent += r.cost.word;

    this.applyOutcome(st, r.outcome, ctx);

    st.used[actionId] = true;
    st.acted = true;                 // has had their turn — see the note above
    if (this.actionsPerWindow > 0) {
      st.actionsLeft = Math.max(0, st.actionsLeft - 1);
      st.declared = st.actionsLeft <= 0;
    }
    st.verb = r.action.verb || 'ACT';
    st.lastActionId = actionId;
    st.aidBonus = 0;
    st.lastOutcome = {
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
    if (o.grant_move) st.moveLeft += o.grant_move;

    /* AID and GUARD reach across to a neighbour — the co-op that makes the
     * reserve ladder's first rung worth being on. */
    if (o.aid_target || o.guard_target) {
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
        finished: this.started && !this.running && this.idx >= this.segs.length - 1,
      },
      campaign: {
        clocks: this.clocks,
        ledger: this.ledger,
        standing: this.standing || {},
        world: this.world,
        tally: this.tally,
        retired: this.retired,
        standIns: this.standIns,
        attended: this.attended,
        features: Object.values(this._featIx).map((e) => ({ id: e.f.id, open: e.f.open, searched: e.f.searched })),
        spotlighted: this.spotlighted,
      },
      students: Object.keys(this.students).map((sid) => {
        const st = this.students[sid];
        return {
          characterId: st.characterId, hex: st.hex, moveLeft: st.moveLeft,
          words: st.words, wordsSpent: st.wordsSpent,
          resolve: st.resolve, resolveUsed: st.resolveUsed, legacy: st.legacy,
          declared: st.declared, acted: st.acted, verb: st.verb,
          tint: st.tint, tintIndex: st.tintIndex,
          docs: st.docs || [],
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
    this.tally = c.tally || {};
    this.retired = c.retired || {};
    this.standIns = c.standIns || {};
    this.attended = c.attended || {};
    (c.features || []).forEach((sf) => {
      const f = this.feature(sf.id);
      if (!f) return;
      if (sf.open !== undefined) f.open = sf.open;
      if (sf.searched !== undefined) f.searched = sf.searched;
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
      this.parked[sd.characterId] = Object.assign({}, sd);
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

  onChange(fn) { this.saver = fn; }
  _dirty() {
    if (!this.saver) return;
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
      },
      started: this.started,
      running: this.running,
      manualRead: this.manualRead,
      resumedFromDisk: !!this.resumedFromDisk,
      priorSessions: (this.history || []).length,
      sessionIndex: this.sessionIndex,
      sessionCount: this.sessions.length,
      canAdvance: !!this.closedOut && this.sessionIndex < this.sessions.length - 1,
      index: this.idx,
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
      room_status: {
        connected: live.length,
        acted: live.filter((s) => s.acted).length,
        idle: live.filter((s) => this.now() - s.seen > 90000).map((s) => s.name),
      },
      students: live.map((s) => ({
        characterId: s.characterId, name: s.name, company: s.company, color: s.color,
        hex: s.hex, moveLeft: s.moveLeft, declared: s.declared, acted: !!s.acted,
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
    const reach = this.turnOpen && st.moveLeft > 0
      ? mp.reachable(st.hex, st.moveLeft, this._moveOpts(st))
      : {};
    const portal = mp.portalAt(st.hex);
    return {
      characterId: st.characterId, name: st.name, role: st.role, calling: st.calling,
      tint: st.tint || st.color, tintIndex: st.tintIndex,
      /* the documents this student has been given, oldest first */
      docs: (st.docs || []).slice(),
      companyName: st.companyName, color: st.color,
      ability: st.ability, abilityBlurb: st.abilityBlurb,
      hex: st.hex, move: st.move, moveLeft: st.moveLeft,
      place: mp.id, placeTitle: mp.title, indoors: !!mp.indoors,
      /* The way out of where you are, if you are standing on it. This is what
       * the GO INSIDE / GO OUT button is made of. */
      portal: (portal && portal.open !== false && st.moveLeft > 0) ? {
        id: portal.id, label: portal.to.label || 'Go through',
        into: (this.maps[portal.to.place] || {}).title || portal.to.place,
        out: !!(this.maps[portal.to.place] && !this.maps[portal.to.place].indoors),
      } : null,
      light: this.light(),
      words: st.words, wordsSpent: st.wordsSpent,
      resolve: st.resolve, resolveUsed: st.resolveUsed,
      legacy: st.legacy, declared: st.declared, acted: !!st.acted, verb: st.verb,
      actionsLeft: st.actionsLeft,
      stats: this.effective(st).stats,
      items: (st.items || []).map((id) => this.item(id)).filter(Boolean),
      features: (mp.features || []).map((f) => ({
        id: f.id, kind: f.kind, hex: f.hex, label: f.label,
        open: f.open, searched: f.searched, to: f.to || null })),
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
      actions: this.offerFor(sid),
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
