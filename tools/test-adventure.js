#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { Room } = require('../server/room.js');
const HexMap = require('../app/js/hexmap.js');

const CONTENT = path.join(__dirname, '..', 'app', 'content');
const load = (name) => JSON.parse(fs.readFileSync(path.join(CONTENT, name), 'utf8'));
const terrain = load('terrain.json');
const maps = fs.readdirSync(CONTENT).filter((f) => /^map-.*\.json$/.test(f)).sort()
  .map((f) => HexMap.hydrate(load(f), terrain));
const scenes = fs.readdirSync(CONTENT).filter((f) => /^scene-s.*\.json$/.test(f)).sort().map(load);
const sessions = [load('session-1.json'), load('session-2.json')];
const roster = load('roster-s1.json');
const facts = load('facts-s1.json');
const common = load('actions-common.json');
let now = 1000000;
let passed = 0;
const rooms = [];

function build(sessionData = sessions, students = 1) {
  const room = new Room('ADVENTURE-TEST', sessionData, maps, roster, scenes, facts,
    { manual: true, clock: () => now, common, callingCaps: false });
  rooms.push(room);
  for (let i = 0; i < students; i++) assert.equal(room.join('s' + i, roster.roster[i].id).ok, true);
  return room;
}
function test(name, fn) {
  fn();
  passed++;
  console.log('  ok  ' + name);
}
function words(text) { return String(text || '').trim().split(/\s+/).filter(Boolean).length; }

test('the opening starts play immediately and keeps housekeeping and cinema brief', () => {
  const room = build();
  assert.equal(room.snapshot().playMode, 'waiting');
  assert.equal(sessions[0].timeline[0].seconds <= 15, true);
  assert.equal(sessions[0].timeline[1].seconds <= 35, true);
  for (const session of sessions) {
    assert.equal(session.timeline[0].seconds <= 15, true);
    assert.equal(session.timeline[1].seconds <= 35, true);
    assert.equal(session.timeline[1].shots.reduce((n, shot) => n + words(shot.voice.text), 0) <= 50, true);
  }
  room.command('start');
  const view = room.privateFor('s0');
  assert.equal(room.snapshot().playMode, 'explore');
  assert.equal(room.turnOpen, true);
  assert.equal(view.movementFree, true);
  assert.ok(view.actions.length > 0);
  assert.ok(view.guidance.options.length <= 3);
  assert.ok(view.guidance.options.some((x) => x.kind === 'job' || x.kind === 'chest'));
  assert.equal(new Set(view.guidance.options.map((x) => x.reward)).size, view.guidance.options.length);
  for (const option of view.guidance.options) {
    if (option.atTarget) assert.ok(view.actions.some((a) => a.id === option.actionId));
    else assert.ok(view.reach.some((h) => h.hex === option.hex));
  }
});

test('free exploration permits repeat actions and reports actual effects with unique ids', () => {
  const room = build();
  room.command('start');
  const st = room.students.s0;
  room.clocks.TEST = { label: 'TEST PROGRESS', segments: 2, filled: 0 };
  room.ledger.test = { label: 'Test stores', value: 1, unit: 'crate' };
  room.engine.actions.TEST_REPEAT = {
    id: 'TEST_REPEAT', label: 'Test the result.', verb: 'ACT', repeatable: true,
    cost: { move: 2, word: 1 }, roll: { stat: 'land', dc: 7 },
    outcomes: { strong: {}, partial: {}, weak: {} },
  };
  for (const outcome of Object.values(room.engine.actions.TEST_REPEAT.outcomes)) {
    Object.assign(outcome, { narrate: 'The test changes the room.', clocks: { TEST: 2 },
      resource: { test: -2 }, resolve: 1, legacy: 2, grant_item: 'ITEM_LEDGER_BOOK' });
  }
  const moveWas = st.moveLeft;
  const first = room.perform('s0', 'TEST_REPEAT');
  const second = room.perform('s0', 'TEST_REPEAT');
  assert.equal(first.ok && second.ok, true);
  assert.notEqual(first.outcome.id, second.outcome.id);
  assert.equal(st.moveLeft, moveWas);
  assert.equal(st.declared, false);
  assert.equal(st.actionsLeft, 0);
  const effect = Object.fromEntries(first.outcome.effects.map((x) => [x.label, x.value]));
  assert.deepEqual(effect, {
    'TEST PROGRESS': 2, 'Test stores': -1, Strain: 1,
    Contribution: 2, Words: -1, Found: "Zumwalt's ledger",
  });
  assert.equal(room.privateFor('s0').guidance.completed, 2);
});

test('a challenge refreshes movement, permits three actions, then closes actions only', () => {
  const room = build();
  room.command('start');
  const boss = room.segs.findIndex((s) => s.boss);
  room.command('goto', { index: boss });
  const st = room.students.s0;
  assert.equal(room.snapshot().playMode, 'challenge');
  assert.equal(room.movementFree, false);
  assert.equal(st.actionsLeft, 3);
  room.engine.actions.TEST_CHALLENGE = {
    id: 'TEST_CHALLENGE', label: 'Hold your place.', repeatable: true,
    outcomes: { all: { narrate: 'You hold.' } },
  };
  assert.equal(room.perform('s0', 'TEST_CHALLENGE').ok, true);
  assert.equal(room.perform('s0', 'TEST_CHALLENGE').ok, true);
  assert.equal(room.perform('s0', 'TEST_CHALLENGE').ok, true);
  assert.equal(room.perform('s0', 'TEST_CHALLENGE').error, 'already-declared');
  assert.equal(st.actionsLeft, 0);
  const destination = room.privateFor('s0').reach.find((x) => x.cost > 0);
  assert.ok(destination);
  const before = st.moveLeft;
  assert.equal(room.move('s0', destination.hex).ok, true);
  assert.equal(st.moveLeft, before - destination.cost);
});

test('challenge outcomes award honestly, survive replay and save, and carry forward', () => {
  const room = build(sessions, 3);
  room.command('start');
  const after = room.segs.findIndex((s) => s.challengeResult);
  const def = room.segs[after].challengeResult;
  assert.equal(def.progress, 'MUSTER');
  assert.equal(def.pressure, 'PATIENCE');
  room.giveItem(room.students.s1, def.reward);
  room.giveItem(room.students.s2, 'ITEM_POWDER_HORN');
  room.clocks.MUSTER.filled = room.clocks.MUSTER.segments;
  room.clocks.PATIENCE.filled = 0;
  room.command('goto', { index: after });
  const result = room.challengeResult;
  assert.equal(result.won, true);
  assert.match(result.awarded.p01, /^Awarded: A length of good rope\.$/);
  assert.match(result.awarded.p02, /^Already carried:/);
  assert.match(result.awarded.p03, /^Pack full:/);
  const itemCounts = room._allStudents().map((st) => st.items.length);
  room.command('replay');
  assert.deepEqual(room._allStudents().map((st) => st.items.length), itemCounts);
  assert.deepEqual(room.challengeResult, result);
  const saved = JSON.parse(JSON.stringify(room.toJSON()));
  const restored = build(sessions, 0);
  assert.equal(restored.restore(saved), true);
  assert.deepEqual(restored.challengeResult, result);
  assert.equal(restored.loadSession(1), true);
  assert.deepEqual(restored.challengeResult, result);
});

test('both bosses assess clocks without rewriting the historical outcome', () => {
  for (const session of sessions) {
    const after = session.timeline.find((s) => s.challengeResult);
    assert.ok(after && after.challengeResult.progress && after.challengeResult.pressure);
  }
  const room = build(sessions[1]);
  room.command('start');
  const after = room.segs.findIndex((s) => s.challengeResult);
  room.clocks.PLAZA.filled = 0;
  room.clocks.TOLL.filled = room.clocks.TOLL.segments;
  room.command('goto', { index: after });
  assert.equal(room.challengeResult.won, false);
  assert.match(room.challengeResult.summary, /work still left/i);
  assert.equal(room.students.s0.items.includes('ITEM_CANVAS'), false);
});

test('the town votes on its own devices, and the hand count still counts', () => {
  const room = build(sessions, 3);
  room.command('start');
  const at = room.segs.findIndex((x) => x.kind === 'tally');
  assert.ok(at > -1);

  /* CLOSED UNTIL ASKED. A vote is only legal on the beat that asks it. */
  assert.equal(room.vote('s0', 'A').error, 'no-vote-open');

  room.command('goto', { index: at });
  const seg = room.segs[at];
  assert.equal(room.vote('s0', 'ZZ').error, 'no-such-option');

  assert.equal(room.vote('s0', seg.options[0].key).ok, true);
  assert.equal(room.vote('s1', seg.options[0].key).ok, true);
  assert.equal(room.vote('s2', seg.options[1].key).ok, true);
  assert.equal(room.tallyCounts()[seg.options[0].key], 2);
  assert.equal(room.tallyCounts()[seg.options[1].key], 1);

  /* CHANGING YOUR MIND MOVES THE COUNT, IT DOES NOT ADD TO IT. Three
   * students must never produce four votes however often they tap. */
  assert.equal(room.vote('s2', seg.options[0].key).ok, true);
  assert.equal(room.tallyCounts()[seg.options[0].key], 3);
  assert.equal(room.tallyCounts()[seg.options[1].key], undefined);
  const total = () => Object.values(room.tallyCounts()).reduce((a, b) => a + b, 0);
  assert.equal(total(), 3);

  /* Tapping your own choice takes it back. */
  assert.equal(room.vote('s2', seg.options[0].key).vote, null);
  assert.equal(total(), 2);
  assert.equal(room.privateFor('s2').vote, null);
  assert.equal(room.privateFor('s0').vote, seg.options[0].key);

  /* THE STEPPERS STAY. A dead Chromebook still has a voice, and the
   * teacher's manual count adds to the devices rather than replacing them. */
  room.command('tally', { key: seg.options[1].key, d: 4 });
  assert.equal(room.tallyCounts()[seg.options[1].key], 4);
  assert.equal(total(), 6);
  assert.equal(room.snapshot().tally[seg.options[1].key], 4);

  /* It survives a save and restore, like every other part of a period. */
  const saved = JSON.parse(JSON.stringify(room.toJSON()));
  const back = build(sessions, 3);
  back.restore(saved);
  assert.equal(back.tallyCounts()[seg.options[0].key], 2);
  assert.equal(back.tallyCounts()[seg.options[1].key], 4);

  /* And it is what carries forward as the decision this town made. */
  room.command('goto', { index: room.segs.length - 1 });
  room.closeOut();
  const decision = room.history[room.history.length - 1].decision;
  assert.equal(decision[seg.options[0].key], 2);
  assert.equal(decision[seg.options[1].key], 4);

  /* A vote is never a fact. Nothing here teaches, so nobody who abstains,
   * arrives late or has no device can be short a required fact for it. */
  assert.equal(seg.teach, undefined);
  (seg.options || []).forEach((o) => assert.equal(o.teach, undefined));
});

test('the timer watches the room and buys it time, but never past the bell', () => {
  const room = build(sessions, 4);
  room.command('start');
  const win = room.segs.findIndex((x) => x.window);
  room.command('goto', { index: win });
  const seg = room.segs[win];

  /* Not yet: the window has only just opened. */
  room.elapsed = 0;
  room._autoExtend();
  assert.equal(room.extra, 0);

  /* A minute out with a room that has barely started: buy it 30 seconds. */
  room.elapsed = seg.seconds - 30;
  room._autoExtend();
  assert.equal(room.extra, Room.EXTEND_STEP);
  assert.equal(room.snapshot().autoExtended, Room.EXTEND_STEP);

  /* A busy room is left alone. Four students, all working. */
  room.extra = 0;
  room.liveStudents().forEach((st) => { st.actsThisWindow = Room.EXTEND_ACTS; });
  room.elapsed = seg.seconds - 30;
  room._autoExtend();
  assert.equal(room.extra, 0, 'a room that is already working gets nothing');

  /* Below the threshold it fires again: one of four is 25%. */
  room.liveStudents().forEach((st, i) => { st.actsThisWindow = i === 0 ? Room.EXTEND_ACTS : 0; });
  room._autoExtend();
  assert.equal(room.extra, Room.EXTEND_STEP);

  /* IT STOPS. Not more than EXTEND_MAX in one window, however idle the room. */
  room.extendedTotal = 0;
  for (let i = 0; i < 20; i++) { room.elapsed = room._len() - 30; room._autoExtend(); }
  assert.ok(room.extra <= Room.EXTEND_MAX, room.extra + " is inside " + Room.EXTEND_MAX);

  /* AND IT NEVER SPENDS MORE THAN THE BELL CAN AFFORD. Once the slack a
   * period holds in reserve is gone, the window ends on time whatever the
   * room is doing - a class that runs past the bell is the worse failure. */
  const slack = (room.data.bellSlackMin || 0) * 60;
  room.extendedTotal = slack;
  room.extra = 0;
  room.elapsed = seg.seconds - 30;
  room._autoExtend();
  assert.equal(room.extra, 0, 'no extension once the bell slack is spent');

  /* An empty room is not a slow room. */
  const solo = build(sessions, 0);
  solo.command('start');
  solo.command('goto', { index: win });
  solo.elapsed = solo.segs[win].seconds - 30;
  solo._autoExtend();
  assert.equal(solo.extra, 0);
});

rooms.forEach((room) => room.destroy());
console.log('\n' + passed + ' adventure regression scenarios passed.');
