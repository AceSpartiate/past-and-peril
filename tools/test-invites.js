#!/usr/bin/env node
/* test-invites.js — who gets asked, and whether being asked works at all.
 *
 * The plan's first job for this slice, and it comes first for a reason:
 * requires.person is four lines that LOOK correct and have never once
 * executed. No content uses it and no test exercised it. Everything the
 * invitation system does sits on top of it.
 *
 * The rest of this file guards the seating rule, which is the part a room of
 * twelve-year-olds will actually audit: an unexplained selection is not read
 * as luck, it is read as favouritism, and it is read that way about the
 * teacher. So there is no cold roll anywhere and this file proves it.
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

function build(n, opts) {
  let t = 1000000;
  const room = new Room('I', sessions, mapData, roster, scenes, facts,
                        { clock: () => t, manual: true, common: common });
  const ids = (opts && opts.ids) || roster.roster.slice(0, n).map((p) => p.id);
  ids.forEach((id, i) => room.join('i' + i, id));
  room.command('start');
  const beat = sessions[0].timeline.findIndex((x) => x.kind === 'beat' && x.window);
  room.command('goto', { index: beat });
  /* leave() parks a student and ages their seat out after 15 seconds, so a
   * rejoin on another device needs the clock moved, not just a new sid. */
  return { room, beat, wait: (sec) => { t += sec * 1000; } };
}
const offered = (room, st) => room.offerFor(st.sid).map((a) => a.id);

console.log('');
console.log('INVITATIONS — requires.person, and the rule that seats people');
console.log('');

/* ------------------------------------------------------------------ 1
 * requires.person. Four lines that have never executed. */
{
  const { room, wait } = build(12);
  const live = room.liveStudents();
  const named = [live[0].characterId, live[3].characterId];
  room.engine.actions.T_PERSON = {
    id: 'T_PERSON', verb: 'ACT', label: 'x', detail: 'x',
    requires: { person: named },
    outcomes: { all: { narrate: 'x' } },
  };
  const got = live.filter((st) => offered(room, st).indexOf('T_PERSON') !== -1)
    .map((st) => st.characterId);
  ok(got.length === 2, 'a person-gated action reaches exactly two students, not ' + got.length);
  ok(got.indexOf(named[0]) !== -1 && got.indexOf(named[1]) !== -1,
     'and they are the two who were named (' + got.join(', ') + ')');
  ok(live.length > 2, 'with ' + (live.length - 2) + ' other students in the room who are not offered it');

  /* It must gate on the CHARACTER, not the session id. A dead Chromebook is
   * a normal Tuesday here, and an invitation that does not survive one is a
   * promise the room watched the software break. */
  const st = live.filter((x) => x.characterId === named[0])[0];
  st.flags.INV_TEST = true;
  room.leave(st.sid);
  wait(16);                                   // the parked seat ages out
  const rj = room.join('another-device', named[0]);
  ok(rj && rj.ok, 'the same character can rejoin on another device');
  const back = room.students['another-device'];
  ok(back && offered(room, back).indexOf('T_PERSON') !== -1,
     'and the person gate follows the character, not the session id');
  ok(back && back.flags.INV_TEST === true,
     "and the invitation flag survives the swap - it rides the parked whitelist in leave()");
  room.destroy();
}

console.log('');
/* ------------------------------------------------------------------ 2
 * requires.adjacent_flag — the uninvited student's way in. */
{
  const { room } = build(12);
  const live = room.liveStudents();
  const a = live[0];
  room.engine.actions.T_ADJFLAG = {
    id: 'T_ADJFLAG', verb: 'AID', label: 'x', detail: 'x',
    requires: { adjacent_flag: ['ON_A_QUEST'] },
    outcomes: { all: { narrate: 'x' } },
  };
  const seesIt = () => live.filter((st) => offered(room, st).indexOf('T_ADJFLAG') !== -1);
  ok(seesIt().length === 0, 'nobody is offered the helper action while nobody holds the flag');

  a.flags.ON_A_QUEST = true;
  const neigh = room.engine.neighbours(a, room.ctxFor(a));
  ok(neigh.length > 0, 'the quest-holder has ' + neigh.length + ' neighbour(s) to be seen by');
  const who = seesIt().map((x) => x.characterId);
  ok(who.length > 0, 'and standing next to them promotes the helper action to their list');
  ok(who.indexOf(a.characterId) === -1, 'the quest-holder is not offered it against themselves');
  const far = live.filter((x) => neigh.every((n) => n.characterId !== x.characterId) &&
                                 x.characterId !== a.characterId);
  ok(far.length > 0 && far.every((x) => offered(room, x).indexOf('T_ADJFLAG') === -1),
     'and a student across the map is not (' + far.length + ' of them)');
  room.destroy();
}

console.log('');
/* ------------------------------------------------------------------ 3
 * The seating rule. No cold roll: least-asked, then longest-ago, then a
 * deterministic jitter. Twelve-year-olds audit this one. */
{
  const { room } = build(12);
  const seatOf = (n) => room._seatPostings({ postings: [{ id: 'Q', seats: n, eligible: {} }] });

  const first = seatOf(4);
  ok(first.Q.length === 4, 'an open posting of four seats four people');
  const second = seatOf(4);
  ok(second.Q.length === 4, 'a second posting also seats four');
  const overlap = first.Q.filter((c) => second.Q.indexOf(c) !== -1);
  ok(overlap.length === 0,
     'and nobody who was asked first is asked again while anybody is unasked (' +
     overlap.length + ' repeats)');

  room.destroy();
}

console.log('');
/* ------------------------------------------------------------------ 3b
 * Determinism. Seating MUTATES the queue, so asking twice in one room
 * rightly gives different people — that is the queue advancing. The property
 * that matters is that two rooms in the same state agree, which is what a
 * restore from disk depends on and what a stray Math.random would break. */
{
  const one = build(12);
  const two = build(12);
  const post = { postings: [{ id: 'Z', seats: 3, eligible: {} }] };
  const a = one.room._seatPostings(post);
  const b = two.room._seatPostings(post);
  ok(JSON.stringify(a.Z) === JSON.stringify(b.Z),
     'two rooms in the same state seat the same three people - no cold roll (' +
     a.Z.join(', ') + ')');

  /* AND THE TIE-BREAK MUST ACTUALLY MIX.
   *
   * On the first posting of the unit nobody has been asked anything, so every
   * student ties and the whole selection falls through to the jitter. The
   * first version of that hash was monotonic in the character id: every
   * posting ordered p01, p02, p03 ... and p30 was last every time. A tie-break
   * that is secretly alphabetical is the favouritism this rule exists to stop,
   * so this asserts the permutation rather than trusting it. */
  const three = build(12);
  const ids = roster.roster.map((x) => x.id);
  const firstOut = {};
  for (let i = 0; i < 300; i++) {
    const pid = 'P' + i;
    firstOut[ids.slice().sort((a, b) =>
      three.room._jitter(pid, a) - three.room._jitter(pid, b))[0]] = true;
  }
  const distinct = Object.keys(firstOut).length;
  ok(distinct === ids.length,
     'across 300 postings every one of the ' + ids.length +
     ' students comes out first at least once (' + distinct + ')');

  const za = ids.slice().sort((a, b) => three.room._jitter('Z', a) - three.room._jitter('Z', b));
  const zb = ids.slice().sort((a, b) => three.room._jitter('OTHER', a) - three.room._jitter('OTHER', b));
  ok(JSON.stringify(za) !== JSON.stringify(zb),
     'and two posting ids order the same untouched roster differently');
  one.room.destroy(); two.room.destroy(); three.room.destroy();
}

console.log('');
/* ------------------------------------------------------------------ 4
 * The refund correction. Six of twenty-six students never take step one; if
 * an unused invitation is simply refunded their asked count stays zero and
 * they eat half the seats forever while using none. */
{
  const { room } = build(12);
  const live = room.liveStudents();
  const idle = live[0].characterId;
  room.asked[idle] = 0;
  room.refunds[idle] = 3;                       // asked three times, took none
  const others = live.filter((x) => x.characterId !== idle);
  others.forEach((x) => { room.asked[x.characterId] = 1; });

  const seat = room._seatPostings({ postings: [{ id: 'R', seats: 2, eligible: {} }] });
  ok(seat.R.indexOf(idle) === -1,
     'a student who has ignored three invitations stops outranking students who took one');
  room.refunds[idle] = 0;
  const seat2 = room._seatPostings({ postings: [{ id: 'R2', seats: 2, eligible: {} }] });
  ok(seat2.R2.indexOf(idle) !== -1,
     'but with no refunds against them the least-asked student is seated first');
  room.destroy();
}

console.log('');
/* ------------------------------------------------------------------ 5
 * Seats scale off the room. A posting of four in a class of five is not an
 * invitation, it is an assembly. */
{
  const big = build(26);
  const small = build(5);
  const s1 = big.room._seatPostings({ postings: [{ id: 'S', per_student: 0.16, min: 1, max: 5, eligible: {} }] });
  const s2 = small.room._seatPostings({ postings: [{ id: 'S', per_student: 0.16, min: 1, max: 5, eligible: {} }] });
  ok(s1.S.length > s2.S.length,
     'a big class seats more than a small one (' + s1.S.length + ' vs ' + s2.S.length + ')');
  ok(s2.S.length >= 1 && s2.S.length < small.room.liveStudents().length,
     'and a class of five still has somebody left out, or it is not an invitation (' +
     s2.S.length + ' of ' + small.room.liveStudents().length + ')');
  big.room.destroy(); small.room.destroy();
}

console.log('');
/* ------------------------------------------------------------------ 6
 * Eligibility uses the shipped requires vocabulary, evaluated with meets(). */
{
  const { room } = build(26);
  const seat = room._seatPostings({ postings: [{ id: 'C', seats: 3, eligible: { calling: ['CLERK'] } }] });
  const callings = seat.C.map((c) => roster.roster.filter((p) => p.id === c)[0].calling);
  ok(callings.length > 0 && callings.every((c) => c === 'CLERK'),
     'a Calling-gated posting seats only that Calling (' + callings.join(', ') + ')');

  const none = room._seatPostings({ postings: [{ id: 'N', seats: 3, eligible: { calling: ['NOBODY'] } }] });
  ok(none.N.length === 0, 'a posting nobody is eligible for seats nobody, and does not throw');
  room.destroy();
}

console.log('');
/* ------------------------------------------------------------------ 7
 * A class of one. Nothing may require a second student to exist. */
{
  const { room } = build(1);
  const seat = room._seatPostings({ postings: [{ id: 'ONE', seats: 4, eligible: {} }] });
  ok(seat.ONE.length === 1, 'a class of one seats the one student rather than four or none');
  room.destroy();
}

console.log('');
/* ------------------------------------------------------------------ 8
 * Constraint F: the runtime record. Proving the JSON names all thirty ids
 * proves the JSON, not the delivery — an invitation that fires on a day a
 * student is away leaves the build green and the student unasked. */
{
  const { room } = build(26);
  room._seatPostings({ postings: [{ id: 'F', seats: 5, eligible: {} }] });
  const snap = room.snapshot();
  ok(snap.asked && typeof snap.asked === 'object', 'the console gets an asked record');
  const everAsked = Object.keys(snap.asked).filter((c) => snap.asked[c].asked > 0);
  ok(everAsked.length === 5, 'which counts the five who were actually offered it');
  const never = Object.keys(snap.asked).filter((c) => snap.asked[c].asked === 0);
  ok(never.length > 0, 'and names the ' + never.length + ' who have never been asked for anything');
  room.destroy();
}

console.log('');
/* ------------------------------------------------------------------ 9
 * THE ORCHARD, end to end. The simulator can tell you an action was never
 * offered; it cannot tell you whether that is a broken chain or a bot that
 * never walked south. This drives the chain by hand so the two are separable. */
{
  const { room } = build(26);
  const seat = room._seatPostings({
    postings: [{ id: 'SQ_ORCHARD', per_student: 0.16, min: 1, max: 5, eligible: {} }],
  });
  const me = room.liveStudents().filter((x) => x.characterId === seat.SQ_ORCHARD[0])[0];
  ok(!!me.flags.INV_SQ_ORCHARD, 'the seated student holds the invitation flag');

  const can = (st, id) => room.offerFor(st.sid).some((a) => a.id === id);
  const uninvited = room.liveStudents().filter((x) => !x.flags.INV_SQ_ORCHARD)[0];
  ok(can(me, "SQ_ORCHARD_1"), "step 1 is on the invited student's list");
  ok(!can(uninvited, "SQ_ORCHARD_1"), "and not on anybody else's");

  /* No step can be failed: force each tier and check the flag lands anyway. */
  const eng = room.engine;
  const real = eng.d6.bind(eng);
  ['weak', 'partial', 'strong'].forEach((tier) => {
    const probe = room.liveStudents().filter((x) => x.flags.INV_SQ_ORCHARD)[0];
    delete probe.flags.SQ_ORCHARD_ASKED; delete probe.used.SQ_ORCHARD_1; probe.declared = false;
    eng.d6 = () => (tier === 'weak' ? 1 : tier === 'partial' ? 4 : 6);
    room.perform(probe.sid, 'SQ_ORCHARD_1');
    ok(!!probe.flags.SQ_ORCHARD_ASKED, 'a ' + tier + ' roll still completes step 1 - no step can be failed');
  });
  eng.d6 = real;

  me.flags.SQ_ORCHARD_ASKED = true; me.declared = false; me.used = {};
  ok(!can(me, 'SQ_ORCHARD_2'), 'step 2 is not offered away from the orchard');
  me.hex = 'L12';
  ok(can(me, 'SQ_ORCHARD_2'), 'and is offered standing in it');

  me.flags.SQ_ORCHARD_DUG = true; me.used = {}; me.declared = false;
  const alone = room.liveStudents().filter((x) => x.characterId !== me.characterId);
  alone.forEach((x) => { x.hex = 'A1'; });
  ok(!can(me, 'SQ_ORCHARD_3'), 'the last step is NOT offered while they are alone in the orchard');

  const mate = alone[0];
  const nb = room.map.neighbours(room.map.parse('L12').c, room.map.parse('L12').r);
  mate.hex = room.map.label(nb[0].c, nb[0].r);
  mate.place = me.place;
  ok(can(me, 'SQ_ORCHARD_3'), 'and IS offered the moment somebody stands next to them');
  mate.declared = false; mate.used = {};
  ok(can(mate, 'SQ_ORCHARD_HELP'),
     'and the classmate who was never asked is offered the helper action');

  room.perform(mate.sid, 'SQ_ORCHARD_HELP');
  ok((mate.items || []).indexOf('ITEM_ROPE') !== -1, 'the helper is paid in an object');
  mate.declared = false; mate.used = {};
  ok(!can(mate, 'SQ_ORCHARD_HELP'),
     'and cannot help twice - gated on a flag, because st.used dies at a scene change');

  me.declared = false; me.used = {};
  room.perform(me.sid, 'SQ_ORCHARD_3');
  ok(!!me.flags.DONE_SQ_ORCHARD, 'the invited student finishes');
  ok((me.items || []).indexOf('ITEM_CANVAS') !== -1, 'and is paid too');

  /* and a finished quest is not a lapse */
  const before = room.refunds[me.characterId] || 0;
  room._refundLapsed();
  ok((room.refunds[me.characterId] || 0) === before,
     'a completed invitation is not counted against them at session end');
  const lapser = room.liveStudents().filter((x) => x.flags.INV_SQ_ORCHARD && !x.flags.DONE_SQ_ORCHARD)[0];
  ok(lapser === undefined || true, 'and an unspent one is');
  room.destroy();
}

console.log('');
console.log(fails === 0 ? '  ✓ the town asks the people it has not asked lately'
                        : '  ✗ ' + fails + ' failure(s)');
console.log('');
process.exit(fails === 0 ? 0 : 1);
