#!/usr/bin/env node
/* test-solo.js — the solo layer: chores, the breadcrumb, and a live map.
 *
 * Three things that are individually small and together decide whether a
 * student who reads none of the instructions still has something to do. The
 * Pardo Test: their map says GO HERE and their top card says what to press.
 */
const fs = require('fs');
const path = require('path');
const { Room } = require('../server/room.js');

const ROOT = path.join(__dirname, '..', 'app');
const load = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'content', f), 'utf8'));
const HexMapMod = require('../app/js/hexmap.js');
const terrain = load('terrain.json');
const mapData = fs.readdirSync(path.join(ROOT, 'content'))
  .filter((f) => /^map-.*\.json$/.test(f)).sort()
  .map((f) => HexMapMod.hydrate(load(f), terrain));
const roster = load('roster-s1.json');
const scenes = [1, 2, 3, 4, 5].map((n) => load('scene-s1-' + n + '.json'))
  .concat([1, 2, 3, 4, 5, 6].map((n) => load('scene-s2-' + n + '.json')));
const common = load('actions-common.json');
const facts = load('facts-s1.json');
const sessions = [load('session-1.json'), load('session-2.json')];

let fails = 0;
const ok = (c, w) => { console.log('  ' + (c ? 'ok  ' : 'FAIL') + '  ' + w); if (!c) fails++; };

function build(n) {
  let t = 1000000;
  const room = new Room('S', sessions, mapData, roster, scenes, facts,
                        { clock: () => t, manual: true, common: common });
  roster.roster.slice(0, n).forEach((p, i) => room.join('s' + i, p.id));
  room.command('start');
  const beat = sessions[0].timeline.findIndex((x) => x.kind === 'beat' && x.window);
  room.command('goto', { index: beat });
  return { room, beat, wait: (sec) => { t += sec * 1000; } };
}
const offered = (room, st) => room.offerFor(st.sid).map((a) => a.id);
/* room.map is the first NON-INDOOR map in load order - bexar_alamo, not the
 * town. The map a student is standing on is always mapFor(st). */
const townOf = (room, st) => room.mapFor(st);

console.log('');
console.log('THE SOLO LAYER — a chore, a ring, and a map that answers');
console.log('');

/* ------------------------------------------------------------------ 1
 * Chores are promoted the way chests are, and are worth taking. */
{
  const { room } = build(12);
  const st = room.liveStudents()[0];
  const jobs = (townOf(room, st).features || []).filter((f) => f.kind === 'job');
  ok(jobs.length >= 15, 'the town map carries ' + jobs.length + ' chores');

  st.hex = jobs[0].hex;
  const list = offered(room, st);
  ok(list.indexOf('JOB:' + jobs[0].id) !== -1, 'standing on one promotes it');

  /* the correction that matters: isMeaningful counts neither legacy nor
   * resource, so a chore paying only those would be FILLER by the engine's
   * own published test and would not suppress the AID/GUARD/HOLD reserve. */
  const act = room.engine.jobAction(jobs[0], jobs[0].hex);
  ok(room.engine.isMeaningful(act, room.ctxFor(st)),
     'and it counts as meaningful work, not filler');
  ok((act.outcomes.all.set_flags || []).indexOf('DID_' + jobs[0].id) !== -1,
     'because the engine synthesises the flag rather than trusting the author');

  const r = room.perform(st.sid, 'JOB:' + jobs[0].id);
  ok(r.ok, 'it can be done');
  st.declared = false; st.used = {};
  ok(offered(room, st).indexOf('JOB:' + jobs[0].id) === -1, 'and not twice by the same student');

  const other = room.liveStudents()[1];
  other.hex = jobs[0].hex;
  ok(offered(room, other).indexOf('JOB:' + jobs[0].id) !== -1,
     'but it is still there for everybody else - a chore is per student');
  room.destroy();
}

console.log('');
/* ------------------------------------------------------------------ 2
 * Chores come back each period. takenBy lives in the CAMPAIGN block, which is
 * right for a chest and wrong for a chore: fifteen over six sessions is two
 * and a half per student per period, which is a countdown, not a manifold. */
{
  const { room } = build(12);
  const st = room.liveStudents()[0];
  const job = (townOf(room, st).features || []).filter((f) => f.kind === 'job')[0];
  st.hex = job.hex;
  room.perform(st.sid, 'JOB:' + job.id);
  ok(Object.keys(job.takenBy || {}).length === 1, 'the chore is taken');
  room.loadSession(1);
  ok(Object.keys(job.takenBy || {}).length === 0, 'and the town needs it doing again next period');
  room.destroy();
}

console.log('');
/* ------------------------------------------------------------------ 3
 * The breadcrumb, and the jam it must not manufacture. */
{
  const { room } = build(26);
  const rings = {};
  room.liveStudents().forEach((st) => {
    const t = room.targetFor(st);
    if (t) rings[t] = (rings[t] || 0) + 1;
  });
  const pointed = Object.keys(rings);
  ok(pointed.length > 1,
     'twenty-six students are pointed at ' + pointed.length + ' different hexes, not one');
  const worst = Math.max.apply(null, Object.values(rings));
  ok(worst < room.liveStudents().length,
     'and no single hex collects the whole class (worst is ' + worst + ')');

  /* never an NPC hex, never a door */
  const npcHexes = Object.values(room.npcHex || {});
  const doorHexes = (townOf(room, room.liveStudents()[0]).features || []).filter((f) => f.kind === 'door').map((f) => f.hex);
  ok(pointed.every((h) => npcHexes.indexOf(h) === -1),
     'no ring lands on an NPC - that is the K6 jam the correction exists to stop');
  ok(pointed.every((h) => doorHexes.indexOf(h) === -1), 'and none lands on a door');

  /* it points at real work, and stops pointing once you have done it */
  const st = room.liveStudents()[0];
  const first = room.targetFor(st);
  const f = (townOf(room, st).features || []).filter((x) => x.hex === first)[0];
  ok(!!f && (f.kind === 'job' || f.kind === 'chest' || f.kind === 'body'),
     'the ring is over a chore or a container (' + (f && f.kind) + ')');
  f.takenBy = { [st.characterId]: true };
  ok(room.targetFor(st) !== first, 'and it moves on once that student has taken it');
  room.destroy();
}

console.log('');
/* ------------------------------------------------------------------ 4
 * ROAM. move() refuses unless turnOpen, so a read segment is sixty seconds of
 * a screen that does not answer. Walking is allowed; acting still is not. */
{
  const { room } = build(12);
  const st = room.liveStudents()[0];
  const step = room.privateFor(st.sid).reach.filter((r) => r.cost <= 1)[0];
  ok(!!step, 'there is somewhere to walk to during a turn');

  /* Take a real read segment and drive BOTH states through it. Hunting the
   * shipped timeline for a non-roaming read is no good any more - every read
   * with a map behind it now roams, so the search fell through to index -1,
   * _enter clamped it to 0, and three assertions quietly passed against a
   * checklist instead. */
  const readIdx = sessions[0].timeline.findIndex((x) => x.kind === 'read' && x.scene);
  ok(readIdx > -1, 'session 1 has a read segment with a map behind it');

  delete room.segs[readIdx].roam;
  room.command('goto', { index: readIdx });
  ok(room._seg().kind === 'read', 'and we are standing on it, not on a checklist');
  ok(!room.turnOpen, 'a read segment closes the turn');
  ok(!room.roamOpen, 'and without roam it closes the map with it');
  ok(room.move(st.sid, step.hex).ok === false, 'so walking is refused');

  /* the same segment, roaming */
  room.segs[readIdx].roam = true;
  room.command('goto', { index: readIdx });
  ok(!room.turnOpen, 'a roaming read still closes the TURN');
  ok(room.roamOpen, 'but opens the map');
  const st2 = room.liveStudents().filter((x) => x.sid === st.sid)[0];
  ok(st2.moveLeft > 0, 'and gives them movement to use (' + st2.moveLeft + ')');
  const dest = room.privateFor(st.sid).reach.filter((r) => r.cost <= 1)[0];
  ok(room.move(st.sid, dest.hex).ok === true, 'so they can walk while the narrator talks');
  const acts = room.offerFor(st.sid);
  ok(acts.length === 0, 'and they still cannot act - nothing is offered');
  const anyAction = common.actions[0].id;
  ok(room.perform(st.sid, anyAction).ok === false, 'perform is still refused outright');
  ok(room.privateFor(st.sid).reach.length > 0, 'the reach is drawn for them');
  room.destroy();
}

console.log('');
/* ------------------------------------------------------------------ 5
 * A class of one. Nothing here may need a second student. */
{
  const { room } = build(1);
  const st = room.liveStudents()[0];
  ok(room.targetFor(st) !== null, 'the solo player gets a ring');
  const job = (townOf(room, st).features || []).filter((f) => f.kind === 'job')[0];
  st.hex = job.hex;
  ok(offered(room, st).indexOf('JOB:' + job.id) !== -1, 'and a chore to do when they get there');
  room.destroy();
}

console.log('');
console.log(fails === 0 ? '  ✓ their map says GO HERE and their top card says what to press'
                        : '  ✗ ' + fails + ' failure(s)');
console.log('');
process.exit(fails === 0 ? 0 : 1);
