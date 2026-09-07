#!/usr/bin/env node
/* test-toll.js — the boss takes its turn, and we check that it lands.
 *
 * segment.toll is the one genuinely new capability in the Béxar slice, and it
 * fires from _tick() on a wall clock rather than at a segment boundary, so
 * none of the other harnesses touch it. This drives a real Room, on real
 * content, with a synthetic toll segment spliced into the timeline.
 *
 * Every assertion here is about something that has silently done nothing
 * before: GUARDED is written by thirteen shipped actions and read by none of
 * them, and a clock has never been advanced by anything but a student.
 */
const fs = require('fs');
const path = require('path');
const { Room } = require('../server/room.js');

const ROOT = path.join(__dirname, '..', 'app');
const load = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'content', f), 'utf8'));
const HexMapMod = require('../app/js/hexmap.js');
const terrainData = load('terrain.json');
const mapData = fs.readdirSync(path.join(ROOT, 'content'))
  .filter((f) => /^map-.*\.json$/.test(f)).sort()
  .map((f) => HexMapMod.hydrate(load(f), terrainData));
const roster = load('roster-s1.json');
const scenes = [1, 2, 3, 4, 5].map((n) => load('scene-s2-' + n + '.json'));
const common = load('actions-common.json');
const facts  = load('facts-s1.json');

let fails = 0;
const ok = (cond, what) => {
  console.log('  ' + (cond ? 'ok  ' : 'FAIL') + '  ' + what);
  if (!cond) fails++;
};

/* A session whose timeline is one beat carrying a toll. */
function build(toll, opts) {
  const session = JSON.parse(JSON.stringify(load('session-2.json')));
  session.timeline = [
    { id: 'boss_phase', kind: 'beat', scene: 'S2.3', seconds: 200, toll: toll },
    { id: 'after', kind: 'read', scene: 'S2.3', seconds: 30 },
  ];
  let t = 1000000;
  const room = new Room('T', session, mapData, roster, scenes, facts,
                        { clock: () => t, manual: true, common: common });
  const n = (opts && opts.students) || 4;
  for (let i = 0; i < n; i++) room.join('s' + i, roster.roster[i].id);
  room.command('start');
  let at = 0;
  const walk = (sec) => {
    /* liveStudents() drops anybody unseen for 15 seconds, so the clock is
     * walked a second at a time with everybody pinging — the same thing a
     * browser does. Jumping it empties the room and the toll hits nobody. */
    for (; at < sec; at++) {
      t = 1000000 + at * 1000;
      for (let i = 0; i < n; i++) room.ping('s' + i);
      room.tick();
    }
  };
  return { room, at: walk };
}

console.log('');
console.log('TOLL — segment.toll fires inside the beat, not at its edge');
console.log('');

/* 1 · timing: warn ahead of the hit, hit on time, neither early */
{
  const { room, at } = build({ at: [60], warn: 'The guns are ranging.', lead: 10,
                               resolve: 1, clocks: { BEXAR: 1 } });
  const bexar0 = room.clocks.BEXAR.filled;
  at(40);
  ok(room.broadcasts.every((b) => b.text !== 'The guns are ranging.'), 'no warning at 40s (lead is 10)');
  ok(room.clocks.BEXAR.filled === bexar0, 'no toll at 40s');
  at(52);
  ok(room.broadcasts.some((b) => b.text === 'The guns are ranging.'), 'warning at 52s, ten seconds ahead');
  ok(room.clocks.BEXAR.filled === bexar0, 'still no toll at 52s — the tell arrives first');
  at(61);
  ok(room.clocks.BEXAR.filled === bexar0 + 1, 'toll lands at 61s and pushes the clock');
  const anyHurt = room.liveStudents().some((s) => s.resolveUsed === 1);
  ok(anyHurt, 'and it costs resolve');
  at(120);
  ok(room.clocks.BEXAR.filled === bexar0 + 1, 'it fires once, not once per tick');
  room.destroy();
}

console.log('');
/* 2 · except_flag: GUARDED is read for the first time in this repo's life */
{
  const { room, at } = build({ at: [30], resolve: 2, except_flag: ['GUARDED'] });
  const live = room.liveStudents();
  live[0].flags.GUARDED = true;
  at(31);
  ok(live[0].resolveUsed === 0, 'GUARDED student takes nothing');
  ok(live[1].resolveUsed === 2, 'unguarded student takes the full toll');
  ok(!live[0].flags.GUARDED, 'GUARDED is spent by the toll it stopped');
  room.destroy();
}

console.log('');
/* 3 · except_hex_in: the answer to the tell is positional too */
{
  const { room, at } = build({ at: [30], resolve: 2, except_hex_in: ['E8', 'F8'] });
  const live = room.liveStudents();
  live[0].hex = 'E8';
  live[1].hex = 'F8';
  at(31);
  ok(live[0].resolveUsed === 0 && live[1].resolveUsed === 0, 'students in cover take nothing');
  ok(live[2].resolveUsed === 2, 'a student in the open takes the toll');
  room.destroy();
}

console.log('');
/* 4 · a class of one. Nothing may require a second student to exist. */
{
  const { room, at } = build({ at: [30], resolve: 1, except_flag: ['GUARDED'],
                               except_hex_in: ['E8'] }, { students: 1 });
  const solo = room.liveStudents()[0];
  at(31);
  ok(room.liveStudents().length === 1, 'the room runs with one student');
  ok(solo.resolveUsed === 1, 'the solo player takes the toll like anybody else');
  solo.hex = 'E8';
  room.destroy();
}

console.log('');
/* 5 · resolve is capped, and clear_resolve is the aftermath's job.
 *     resolveUsed has NO reset path anywhere in this repo — not turn, not
 *     scene, not loadSession — so a boss that deals it and never clears it
 *     hurts a student for the rest of the unit. */
{
  const { room, at } = build({ at: [10, 20, 30, 40, 50, 60], resolve: 2 });
  const s0 = room.liveStudents()[0];
  at(70);
  ok(s0.resolveUsed === s0.resolve, 'resolve damage clamps at the pool size (' + s0.resolve + ')');
  room.destroy();
}
{
  const { room, at } = build({ at: [10], clear_resolve: 4 });
  const s0 = room.liveStudents()[0];
  s0.resolveUsed = 3;
  at(11);
  ok(s0.resolveUsed === 0, 'an aftermath toll with clear_resolve heals the room');
  room.destroy();
}

console.log('');
/* 6 · each beat gets its own schedule; three phases on one scene is three tolls */
{
  const session = JSON.parse(JSON.stringify(load('session-2.json')));
  const toll = { at: [20], clocks: { BEXAR: 1 } };
  session.timeline = [
    { id: 'p1', kind: 'beat', scene: 'S2.3', seconds: 40, toll: toll },
    { id: 'p2', kind: 'beat', scene: 'S2.3', seconds: 40, toll: toll },
    { id: 'p3', kind: 'beat', scene: 'S2.3', seconds: 40, toll: toll },
  ];
  let t = 1000000;
  const room = new Room('T', session, mapData, roster, scenes, facts,
                        { clock: () => t, manual: true, common: common });
  room.join('s0', roster.roster[0].id);
  room.command('start');
  const b0 = room.clocks.BEXAR.filled;
  room.liveStudents()[0].used.MARKER = true;
  for (let sec = 1; sec <= 118; sec++) {
    t = 1000000 + sec * 1000; room.ping('s0'); room.tick();
  }
  ok(room.clocks.BEXAR.filled === b0 + 3, 'three beats on one scene fire three tolls');
  ok(room.liveStudents()[0].used.MARKER === true,
     'and st.used survives all three — your kit is once per FIGHT, not per phase');
  room.destroy();
}

console.log('');
console.log(fails === 0 ? '  ✓ the toll lands, and only where it should'
                        : '  ✗ ' + fails + ' failure(s)');
console.log('');
process.exit(fails === 0 ? 0 : 1);
