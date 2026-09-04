#!/usr/bin/env node
/* sim-class.js — thirty synthetic students against the real engine.
 *
 * design/16-build-order.md makes the software its own test harness, because no
 * class is available until the whole thing is built. This is the substitute for
 * standing at the back of the room and watching.
 *
 * It is NOT a mock. It drives the real `Room` and the real `Engine` with the
 * real content, on a virtual clock, so a 45-minute period runs in milliseconds
 * and can be repeated for variance.
 *
 * IT CANNOT TELL US WHETHER THIS IS FUN. A bot has no boredom and no delight.
 * Every number below can be green and the room can still be flat.
 *
 *   node tools/sim-class.js            one period
 *   node tools/sim-class.js --runs 20  twenty, with variance
 *   node tools/sim-class.js --seed 7
 */

const fs = require('fs');
const path = require('path');
const { Room } = require('../server/room.js');

const ROOT = path.join(__dirname, '..', 'app');
const load = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'content', f), 'utf8'));


const args = process.argv.slice(2);
const argv = (k, d) => {
  const i = args.indexOf('--' + k);
  return i === -1 ? d : Number(args[i + 1]);
};
const RUNS = argv('runs', 1);
const SEED0 = argv('seed', 1);

const WHICH = (function () { const i = args.indexOf('--session');
  return i === -1 ? 1 : Number(args[i + 1]); })();
const session = load('session-' + WHICH + '.json');
/* Every place, hydrated against the master legend — the simulator has to see
 * the same world the browser does or it is testing a different game. */
const HexMapMod = require('../app/js/hexmap.js');
const terrainData = load('terrain.json');
const mapData = fs.readdirSync(path.join(__dirname, '..', 'app', 'content'))
  .filter((f) => /^map-.*\.json$/.test(f)).sort()
  .map((f) => HexMapMod.hydrate(load(f), terrainData));
const roster  = load('roster-s1.json');
const SCENES  = [1, 2, 3, 4, 5].map((n) => 'scene-s' + WHICH + '-' + n);
const scenes  = SCENES.map((f) => load(f + '.json'));
const scene   = scenes[0];
const common  = load('actions-common.json');
const facts   = load('facts-s1.json');
const APW = argv('actions', 0);          // override actionsPerWindow to compare

/* Hexes this scene has something to say about: anywhere an action names in
 * hex_in, and wherever an NPC behind an adjacency gate is standing. Cached per
 * scene, because it does not change inside one. */
const _wantCache = {};
function wantedHexes(room) {
  const key = room.sceneId;
  if (_wantCache[key]) return _wantCache[key];
  const out = [];
  const sc = room.scene || {};
  (sc.actions || []).forEach((a) => {
    const req = a.requires || {};
    (req.hex_in || []).forEach((h) => { if (out.indexOf(h) === -1) out.push(h); });
    if (req.adjacent_npc && room.npcHex[req.adjacent_npc]) {
      const h = room.npcHex[req.adjacent_npc];
      if (out.indexOf(h) === -1) out.push(h);
    }
  });
  _wantCache[key] = out;
  return out;
}

/* odd-r offset -> cube, so "how far is that" is one subtraction. */
function hexDist(room, a, b) {
  const mp = room.map;
  const pa = mp.parse(a), pb = mp.parse(b);
  if (!pa || !pb) return Infinity;
  const cube = (p) => {
    const x = p.c - (p.r - (p.r & 1)) / 2;
    const z = p.r;
    return [x, -x - z, z];
  };
  const A = cube(pa), B = cube(pb);
  return Math.max(Math.abs(A[0] - B[0]), Math.abs(A[1] - B[1]), Math.abs(A[2] - B[2]));
}

/* deterministic RNG so a finding can be reproduced from its seed */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; };
}

/* ------------------------------------------------------------------ profiles
 * Reading rates come from tools/reading-load.js. Latency is how long after a
 * window opens this student actually does something. */
const PROFILES = [
  { id: 'fast+thorough', wpm: 200, latency: [3, 9],   moves: 2, acts: true,  weight: 4 },
  { id: 'fast+skimming', wpm: 200, latency: [2, 5],   moves: 1, acts: true,  weight: 4 },
  { id: 'steady',        wpm: 150, latency: [8, 22],  moves: 1, acts: true,  weight: 10 },
  { id: 'slow reader',   wpm: 110, latency: [20, 55], moves: 1, acts: true,  weight: 7 },
  { id: 'struggling',    wpm: 80,  latency: [35, 80], moves: 0, acts: true,  weight: 3 },
  { id: 'disengaged',    wpm: 110, latency: [60, 200],moves: 0, acts: false, weight: 2 },
];

function assignProfiles(rand) {
  const pool = [];
  PROFILES.forEach((p) => { for (let i = 0; i < p.weight; i++) pool.push(p); });
  return roster.roster.map(() => pool[Math.floor(rand() * pool.length)]);
}

/* ------------------------------------------------------------------ one run */
function run(seed) {
  const rand = rng(seed);
  let t = 1000000;                                  // virtual ms
  const room = new Room('SIM', session, mapData, roster, scenes, facts,
                        { clock: () => t, manual: true, common: common,
                          actionsPerWindow: APW || undefined });

  const profiles = assignProfiles(rand);
  const bots = roster.roster.map((p, i) => ({
    sid: 'bot' + i,
    characterId: p.id,
    name: p.name,
    calling: p.calling,
    profile: profiles[i],
    absent: rand() < 0.05,                          // ~1–2 away on any given day
    idleSec: 0,
    engagedSec: 0,
    nextAt: undefined,
    decidedAt: [],
    actionsTaken: [],
    factsFromPlay: 0,
    factsFromFallback: 0,
  }));

  bots.forEach((b) => { if (!b.absent) room.join(b.sid, b.characterId); });

  const offered = {};                               // actionId -> times offered
  const chosen = {};                                // actionId -> times chosen
  let windowIdx = 0;
  const windows = [];
  let overruns = 0;

  room.command('start');

  const STEP = 1000;                                 // one virtual second
  const HARD_STOP = t + 60 * 60 * 1000;

  let lastSegId = null;
  let winStats = null;

  while (t < HARD_STOP) {
    t += STEP;
    bots.forEach((b) => { if (!b.absent) room.ping(b.sid); });
    room.tick();

    const snap = room.snapshot();
    if (!snap.started) break;
    const seg = snap.segment;
    if (!seg) break;

    if (seg.id !== lastSegId) {
      if (winStats) windows.push(winStats);
      lastSegId = seg.id;
      bots.forEach((b) => { b.nextAt = undefined; });
      winStats = room.turnOpen
        ? { id: seg.id, opened: t, len: snap.length, idle: 0, declared: 0, latency: [] }
        : null;
      if (winStats) windowIdx += 1;
    }

    if (!room.turnOpen || !winStats) {
      if (snap.index >= snap.count - 1 && !snap.running) break;
      continue;
    }

    const elapsed = (t - winStats.opened) / 1000;

    bots.forEach((b) => {
      if (b.absent) return;
      const st = room.students[b.sid];
      if (!st) return;

      const acts = room.offerFor(b.sid);
      acts.forEach((a) => { offered[a.id] = (offered[a.id] || 0) + 1; });

      /* IDLE, by design/08's definition: the window is open and there is
       * nothing meaningful to do. Movement does not count — being able to walk
       * somewhere is not having something to do. */
      if (acts.length === 0) { b.idleSec += 1; winStats.idle += 1; }

      /* A student who never acts registers as NOT idle, because their options
       * are all still sitting there. That is a real artefact of the definition
       * in design/08, so engagement is measured separately — otherwise the most
       * disengaged student in the room scores best on the idle metric. */
      if (st.declared) b.engagedSec += 1;

      if (st.declared) return;

      /* A student reads the options before tapping, and reads the outcome
       * after. Cadence comes from their words-per-minute in tools/
       * reading-load.js: about 60 words of options plus a ~45-word outcome, so
       * a strong reader turns around an action in ~25s and a struggling one in
       * ~60s. Without this the bots tapped every simulated second and produced
       * 127,000 actions a period, which is not a finding about the design. */
      if (b.nextAt === undefined) {
        const lat = b.profile.latency;
        b.nextAt = lat[0] + rand() * (lat[1] - lat[0]);
      }
      if (elapsed < b.nextAt) return;
      if (!b.profile.acts && rand() > 0.15) return;   // disengaged: usually nothing

      // move first, sometimes
      for (let m = 0; m < b.profile.moves; m++) {
        const reach = room.privateFor(b.sid).reach;
        if (!reach.length) break;
        const want = wantedHexes(room);
        let pick;
        if (want.length && rand() < 0.35) {
          /* head for the nearest hex the scene actually cares about */
          let best = null, bestD = Infinity;
          reach.forEach((r) => {
            want.forEach((w) => {
              const d = hexDist(room, r.hex, w);
              if (d < bestD) { bestD = d; best = r; }
            });
          });
          pick = best || reach[0];
        } else {
          pick = reach[Math.floor(rand() * reach.length)];
        }
        room.move(b.sid, pick.hex);
      }

      const list = room.offerFor(b.sid);
      if (!list.length) return;
      /* A skimmer takes the first thing; a thorough student reads to the end.
       * Both are realistic and they stress different parts of the pool. */
      const idx = b.profile.id === 'fast+skimming'
        ? 0
        : Math.floor(rand() * list.length);
      const choice = list[idx];
      const before = Object.keys(st.taught).length;
      const res = room.perform(b.sid, choice.id);
      if (res.ok) {
        chosen[choice.id] = (chosen[choice.id] || 0) + 1;
        b.actionsTaken.push(choice.id);
        b.decidedAt.push(elapsed);
        winStats.declared += 1;
        winStats.latency.push(elapsed);
        const gained = Object.keys(st.taught).length - before;
        if (choice.fallback) b.factsFromFallback += gained;
        else b.factsFromPlay += gained;
        const words = 60 + 45;                       // options read + outcome read
        b.nextAt = elapsed + (words / b.profile.wpm) * 60 * (0.8 + rand() * 0.5);
      }
    });
  }
  if (winStats) windows.push(winStats);

  const snap = room.snapshot();
  const cov = room.coverage();
  const live = room.liveStudents();

  // dead rules: authored actions nobody was ever offered
  const authored = scenes.reduce((a, sc) => a.concat(sc.actions.map((x) => x.id)), [])
    .concat(common.actions.map((a) => a.id));
  const dead = authored.filter((id) => !offered[id]);

  room.destroy();

  return {
    seed,
    bots, windows, offered, chosen, dead,
    coverage: cov,
    sessionCoverage: room.sessionCoverage(),
    via: room.liveStudents().map((st) => ({
      sid: st.sid,
      play: Object.values(st.taughtVia).filter((v) => v === 'play').length,
      fallback: Object.values(st.taughtVia).filter((v) => v === 'fallback').length,
      record: Object.values(st.taughtVia).filter((v) => v === 'record').length,
    })),
    spotlighted: Object.keys(room.spotlighted).length,
    connected: live.length,
    absent: bots.filter((b) => b.absent).length,
    endedAt: snap.index,
    segments: snap.count,
    overruns,
    bellSpare: snap.budget.toBell,
  };
}

/* ------------------------------------------------------------------ report */
function pct(n, d) { return d ? Math.round((100 * n) / d) + '%' : '—'; }
function stat(arr) {
  if (!arr.length) return { min: 0, max: 0, mean: 0, p90: 0 };
  const a = arr.slice().sort((x, y) => x - y);
  return {
    min: a[0], max: a[a.length - 1],
    mean: a.reduce((s, x) => s + x, 0) / a.length,
    p90: a[Math.floor(a.length * 0.9)],
  };
}
function bar(v, max, w) {
  const n = Math.max(0, Math.min(w, Math.round((v / (max || 1)) * w)));
  return '█'.repeat(n) + '·'.repeat(w - n);
}

const runs = [];
for (let i = 0; i < RUNS; i++) runs.push(run(SEED0 + i));

console.log('');
console.log('THIRTY STUDENTS, ' + RUNS + ' PERIOD' + (RUNS > 1 ? 'S' : '') + ' — simulated against the real engine');
console.log('='.repeat(74));
const r0 = runs[0];
console.log('  Session ' + session.session + ' · ' + scenes.length + ' scenes · ' +
            (scenes.reduce((a, x) => a + x.actions.length, 0) + common.actions.length) +
            ' authored actions · ' + facts.facts.length + ' facts · ' +
            r0.windows.length + ' turn windows');
console.log('');

/* --- 1. coverage: can anybody miss required content? */
let missed = 0, viaPlay = 0, viaFallback = 0, sessShort = 0, sessTotal = 0;
runs.forEach((r) => {
  r.coverage.students.forEach((s) => { if (s.missing.length) missed += 1; });
  r.bots.forEach((b) => { viaPlay += b.factsFromPlay; viaFallback += b.factsFromFallback; });
  sessShort += r.sessionCoverage.short;
  sessTotal += r.sessionCoverage.total;
});
const totalStudents = runs.reduce((a, r) => a + r.coverage.students.length, 0);
console.log('1 · CAN A STUDENT MISS REQUIRED CONTENT?');
console.log('   short at the end of the last scene:                  ' + missed + ' of ' + totalStudents);
console.log('   short of any of the SESSION required facts (' + runs[0].sessionCoverage.need + '):' +
            '  ' + sessShort + ' of ' + sessTotal);
console.log('   facts delivered through play vs the fallback sweep:  ' +
            viaPlay + ' play / ' + viaFallback + ' fallback  (' +
            pct(viaFallback, viaPlay + viaFallback) + ' swept)');
console.log('   ' + (missed === 0 && sessShort === 0 ? '✓ THE FACTS ARE FREE holds'
            : '✗ COVERAGE FAILED'));
console.log('');

/* --- 2. the idle floor */
const allIdle = [];
runs.forEach((r) => r.bots.filter((b) => !b.absent).forEach((b) => allIdle.push(b.idleSec)));
const idle = stat(allIdle);
console.log('2 · THE IDLE FLOOR — seconds with nothing meaningful to do');
console.log('   mean ' + idle.mean.toFixed(1) + 's   p90 ' + idle.p90 + 's   worst ' + idle.max + 's');
console.log('   ' + (idle.max <= 20 ? '✓ under the 20-second floor' :
            '⚠ worst case is over the 20-second floor in design/08'));
const declaredWindows = [];
runs.forEach((r) => r.bots.filter((b) => !b.absent)
  .forEach((b) => declaredWindows.push(b.actionsTaken.length)));
const dw = stat(declaredWindows);
const nWin = r0.windows.length || 1;
console.log('   actions per window: mean ' + (dw.mean / nWin).toFixed(1) +
            '  worst ' + (dw.min / nWin).toFixed(1) + '  best ' + (dw.max / nWin).toFixed(1));
console.log('');

/* --- 3. when do they decide, and does anyone run out of window? */
const lat = [];
runs.forEach((r) => r.bots.forEach((b) => b.decidedAt.forEach((d) => lat.push(d))));
const L = stat(lat);
const undeclared = runs.reduce((a, r) =>
  a + r.windows.reduce((x, w) => x + Math.max(0, (30 - r.absent) - w.declared), 0), 0);
const windowsTotal = runs.reduce((a, r) => a + r.windows.length, 0);
console.log('3 · WHEN DO THEY DECIDE?  (the DECLARE window is ' +
            (r0.windows[0] ? r0.windows[0].len + 's' : '—') + ')');
console.log('   fastest ' + L.min.toFixed(0) + 's   mean ' + L.mean.toFixed(0) +
            's   p90 ' + L.p90.toFixed(0) + 's   slowest ' + L.max.toFixed(0) + 's');
console.log('   declarations missed across all windows: ' + undeclared +
            '  (' + pct(undeclared, windowsTotal * 30) + ' of chances)');
console.log('');

/* --- 4. is the pool being used, or are three actions doing all the work? */
const chosenAll = {};
runs.forEach((r) => Object.keys(r.chosen).forEach((k) => { chosenAll[k] = (chosenAll[k] || 0) + r.chosen[k]; }));
const picks = Object.entries(chosenAll).sort((a, b) => b[1] - a[1]);
const totalPicks = picks.reduce((a, p) => a + p[1], 0);
const poolTotal = scenes.reduce((a, s2) => a + s2.actions.length, 0) +
                  common.actions.length + facts.facts.length;
console.log('4 · IS THE POOL BEING USED?  ' + picks.length + ' of ' + poolTotal +
            ' actions were chosen at least once');
picks.slice(0, 6).forEach(([id, n]) => {
  console.log('   ' + bar(n, picks[0][1], 16) + ' ' + String(n).padStart(4) + '  ' + id);
});
const deadAll = r0.dead.filter((id) => runs.every((r) => r.dead.includes(id)));
console.log('   never offered to anyone, in any run: ' + (deadAll.length ? deadAll.join(', ') : 'none ✓'));

/* HOW DEEP DOES A SCENE'S POOL NEED TO BE?
 * Authored actions are once per scene; the always-available ones repeat. When a
 * student burns through the authored pool the rest of their window is AID,
 * GUARD and HOLD — which is the reserve ladder working, but thin texture if it
 * is most of the window. This is the number that says how much to author. */
const REPEATABLE = ['GEN_AID', 'GEN_GUARD', 'GEN_HOLD'];
let rep = 0, auth = 0;
Object.keys(chosenAll).forEach(function (k) {
  if (REPEATABLE.indexOf(k) !== -1) rep += chosenAll[k]; else auth += chosenAll[k];
});
const perStudentPerWindow = (dw.mean / nWin);
console.log('   authored vs always-available: ' + auth + ' / ' + rep +
            '  (' + pct(rep, rep + auth) + ' fell back on AID/GUARD/HOLD)');
console.log('   → a ' + (r0.windows[0] ? r0.windows[0].len : 240) + 's self-paced window consumes ~' +
            perStudentPerWindow.toFixed(0) + ' actions per student.');
console.log('     design/08 budgeted ~7 authored actions per scene, sized for the');
console.log('     paper model. On this measurement a scene needs ~' +
            Math.ceil(perStudentPerWindow * 1.6) + ' reachable actions');
console.log('     to keep a window in authored content.');
console.log('');

/* --- 5. the spotlight guarantee */
const spots = runs.map((r) => r.spotlighted);
console.log('5 · THE SPOTLIGHT (design/14: every name reaches the Stage once a session)');
const conn = runs.map((r) => 30 - r.absent);
console.log('   students named: ' + stat(spots).min + '–' + stat(spots).max +
            ' of ' + stat(conn).min + '–' + stat(conn).max + ' who were present');
console.log('   ' + (stat(spots).min >= stat(conn).min ? '✓ everybody present was named'
            : '⚠ up to ' + (stat(conn).max - stat(spots).min) + ' present students went unnamed'));
console.log('');

/* --- 6. by profile: who is being served badly? */
console.log('6 · BY READING PROFILE — this is the equity check');
console.log('   Everyone ends the session with all 17 required facts. What differs is');
console.log('   HOW they got there — found in play, prompted by the sweep, or told');
console.log('   outright at Set the Record Straight.');
console.log('');
console.log('   profile          n  actions   found  prompted   told');
console.log('   ' + '-'.repeat(58));
PROFILES.forEach((p) => {
  const bs = [];
  runs.forEach((r) => r.bots.forEach((b) => { if (!b.absent && b.profile.id === p.id) bs.push(b); }));
  if (!bs.length) return;
  const a = stat(bs.map((b) => b.actionsTaken.length));
  const vias = [];
  runs.forEach((r) => r.via.forEach((v) => {
    const b = r.bots.filter((x) => x.sid === v.sid)[0];
    if (b && !b.absent && b.profile.id === p.id) vias.push(v);
  }));
  const V = (k) => stat(vias.map((v) => v[k])).mean;
  console.log('   ' + p.id.padEnd(16) + String(bs.length).padStart(3) +
    ('  ' + a.mean.toFixed(1)).padStart(9) +
    ('  ' + V('play').toFixed(1)).padStart(8) +
    ('  ' + V('fallback').toFixed(1)).padStart(10) +
    ('  ' + V('record').toFixed(1)).padStart(7));
});
console.log('');
console.log('='.repeat(74));
console.log('A bot has no boredom and no delight. None of the above measures whether');
console.log('this is fun, and nothing that can be written here ever will.');
console.log('');
