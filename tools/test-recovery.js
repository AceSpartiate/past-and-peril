#!/usr/bin/env node
/* Recovery tests use real content, an injected clock, and in-memory saves.
 * They never open or change the teacher's saved campaigns. */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { Room } = require('../server/room.js');
const HexMap = require('../app/js/hexmap.js');

const content = path.join(__dirname, '..', 'app', 'content');
const load = (file) => JSON.parse(fs.readFileSync(path.join(content, file), 'utf8'));
const terrain = load('terrain.json');
const maps = fs.readdirSync(content).filter((f) => /^map-.*\.json$/.test(f)).sort()
  .map((f) => HexMap.hydrate(load(f), terrain));
const scenes = fs.readdirSync(content).filter((f) => /^scene-s.*\.json$/.test(f)).sort().map(load);
const sessions = [load('session-1.json'), load('session-2.json')];
const roster = load('roster-s1.json');
const facts = load('facts-s1.json');
const common = load('actions-common.json');
const rooms = [];
let now = 1000000;
let passed = 0;

function build(opts) {
  const room = new Room('RECOVERY-TEST', sessions, maps, roster, scenes, facts,
    Object.assign({ manual: true, clock: () => now, common, callingCaps: false }, opts));
  rooms.push(room);
  return room;
}
const saved = (room) => JSON.parse(JSON.stringify(room.toJSON()));
const restore = (room) => {
  const next = build();
  assert.equal(next.restore(saved(room)), true);
  return next;
};
const join = (room, sid, index = 0) => {
  assert.equal(room.join(sid, roster.roster[index].id).ok, true);
  return room.students[sid];
};
function progress(st) {
  Object.assign(st, {
    legacy: 17, actionsLeft: 2, moveLeft: 1, wordsSpent: 1,
    resolveUsed: 1, declared: false, acted: true, verb: 'READ',
    docs: ['01'], trail: [{ session: 0, scene: 'S1.1', label: 'Read', taught: [] }],
    flags: { RECOVERY_TEST: true }, taught: { 'F01': true }, taughtVia: { 'F01': 'action' },
    used: { READ_TEST: true }, paidLegacy: { READ_TEST: true },
    aidBonus: 1, tierUp: 1, lastActionId: 'READ_TEST',
    lastOutcome: { label: 'Read', narrate: 'The document stays with you.' },
    caughtUp: { sessions: 1, facts: [], cards: [] },
  });
}
function sameProgress(actual, expected) {
  for (const key of [
    'characterId', 'legacy', 'actionsLeft', 'moveLeft', 'words', 'wordsSpent',
    'resolveUsed', 'declared', 'acted', 'verb', 'docs', 'trail', 'flags', 'taught',
    'taughtVia', 'used', 'paidLegacy', 'items', 'place', 'hex', 'anchor',
    'aidBonus', 'tierUp', 'lastActionId', 'lastOutcome', 'caughtUp',
  ]) assert.deepEqual(actual[key], expected[key], key + ' survives recovery');
}
function test(name, fn) {
  fn();
  passed++;
  console.log('  ok  ' + name);
}

async function main() {
  test('unclaimed characters retain all progress over repeated save/restart cycles', () => {
    const original = build();
    const first = join(original, 'first-device');
    const second = join(original, 'second-device', 1);
    progress(first);
    second.legacy = 9;
    const expected = JSON.parse(JSON.stringify(first));
    const once = restore(original);
    assert.equal(once.liveStudents().length, 0);
    assert.equal(once.toJSON().students.length, 2);
    const twice = restore(once);
    sameProgress(join(twice, 'replacement'), expected);
    assert.equal(twice.toJSON().students.length, 2);
    const third = restore(twice);
    assert.equal(join(third, 'absent-returning', 1).legacy, 9);
  });

  test('a stalled connection transfers the latest state to a different device', () => {
    const room = build();
    const st = join(room, 'old-device');
    progress(st);
    assert.equal(room.join('too-soon', st.characterId).error, 'taken');
    const expected = JSON.parse(JSON.stringify(st));
    now += 16000;
    sameProgress(join(room, 'new-device'), expected);
    assert.equal(room.students['old-device'], undefined);
    assert.equal(room.toJSON().students.length, 1);
  });

  test('disconnect then device transfer keeps updates made while the lid was closed', () => {
    const room = build();
    const st = join(room, 'closed-device');
    progress(st);
    room.leave('closed-device');
    st.legacy = 19;
    st.actionsLeft = 3;
    st.docs.push('02');
    const expected = JSON.parse(JSON.stringify(st));
    now += 2000;
    sameProgress(join(room, 'replacement-device'), expected);
  });

  test('a reused Chromebook keeps each character attached to their own progress', () => {
    const room = build();
    const first = join(room, 'first-device');
    const second = join(room, 'reused-device', 1);
    progress(first);
    second.legacy = 8;
    now += 16000;
    const expected = JSON.parse(JSON.stringify(first));
    sameProgress(join(room, 'reused-device'), expected);
    assert.equal(room.claimed[second.characterId], undefined);
    assert.equal(room.toJSON().students.length, 2);
    assert.equal(join(room, 'another-device', 1).legacy, 8);
  });

  test('live progress overrides an older parked copy when saving', () => {
    const room = build();
    const st = join(room, 'live-device');
    st.legacy = 12;
    room.parked[st.characterId] = { characterId: st.characterId, legacy: 3 };
    assert.equal(room.toJSON().students.length, 1);
    assert.equal(room.toJSON().students[0].legacy, 12);
  });

  test('parked characters follow session, scene, turn, and record transitions', () => {
    const room = build();
    const st = join(room, 'old-session');
    progress(st);
    st.flags.ABILITY_SPENT = true;
    st.flags.ACTED_THIS_SCENE = true;
    const next = restore(room);
    assert.equal(next.loadSession(1), true);
    const parked = next.parked[st.characterId];
    assert.equal(parked.flags.ABILITY_SPENT, undefined);
    assert.equal(parked.flags.ACTED_THIS_SCENE, undefined);
    assert.deepEqual(parked.used, {});
    assert.equal(parked.wordsSpent, 0);
    assert.equal(parked.legacy, 17);
    assert.equal(parked.place, next.sceneMapId());
    const turn = next.segs.findIndex((s) => next._isTurn(s));
    assert.notEqual(turn, -1);
    next._enter(turn);
    assert.equal(parked.moveLeft, next.effective(parked).move);
    assert.equal(parked.actionsLeft, next.actionsPerWindow);
    assert.equal(parked.acted, false);
    const record = next.segs.findIndex((s) => s.kind === 'record');
    assert.notEqual(record, -1);
    next._enter(record);
    assert.equal(next.sessionMustTeach.every((f) => parked.taught[f]), true);
    assert.equal(join(next, 'back-in-class').legacy, 17);
  });

  test('completed sessions advance immediately after restore without duplicate history', () => {
    const room = build();
    room.command('start');
    room._enter(room.segs.length - 1);
    now += room._len() * 1000;
    room.tick();
    assert.equal(room.snapshot().canAdvance, true);
    assert.equal(room.history.length, 1);
    const next = restore(room);
    assert.equal(next.running, false);
    assert.equal(next.snapshot().canAdvance, true);
    next.closeOut();
    assert.equal(next.history.length, 1);
    assert.equal(next.command('nextSession').ok, true);
    assert.equal(next.sessionIndex, 1);
    assert.equal(next.history.length, 1);
  });

  test('a pause on the final segment does not become a completed period', () => {
    const room = build();
    room.command('start');
    room._enter(room.segs.length - 1);
    room.command('pause');
    const d = saved(room);
    assert.equal(d.period.finished, false);
    d.period.finished = true; // Older saves used the paused final index alone.
    const next = build();
    assert.equal(next.restore(d), true);
    assert.equal(next.snapshot().canAdvance, false);
    assert.equal(next.command('nextSession').error, 'session-not-finished');
  });

  test('replay changes segment revision, pause/resume and restore preserve it', () => {
    const room = build();
    room.command('start');
    const revision = room.snapshot().segmentRevision;
    room.command('pause');
    room.command('resume');
    assert.equal(room.snapshot().segmentRevision, revision);
    room.command('replay');
    assert.equal(room.snapshot().segmentRevision, revision + 1);
    assert.equal(restore(room).snapshot().segmentRevision, revision + 1);
  });

  const destroyed = build({ manual: false });
  let writes = 0;
  let notifications = 0;
  destroyed.onChange(() => writes++);
  const off = destroyed.subscribe(() => notifications++, { viewer: true });
  destroyed.command('start');
  assert.ok(destroyed._saveTimer);
  assert.ok(destroyed.timer);
  destroyed.destroy();
  destroyed.destroy();
  const lastNotification = notifications;
  off();
  destroyed._emit();
  destroyed.onChange(() => writes++);
  assert.equal(destroyed.running, false);
  assert.equal(destroyed.timer, null);
  assert.equal(destroyed._saveTimer, null);
  assert.equal(destroyed.saver, null);
  assert.equal(destroyed.viewers, 0);
  await new Promise((resolve) => setTimeout(resolve, 3150));
  assert.equal(writes, 0);
  assert.equal(notifications, lastNotification);
  passed++;
  console.log('  ok  destroy cancels queued saves, ticking, and subscriber callbacks');
  console.log('\n' + passed + ' recovery scenarios passed.');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => rooms.forEach((room) => room.destroy()));
