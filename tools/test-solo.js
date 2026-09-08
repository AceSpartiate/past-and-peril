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
 * THE SCRIM IS OFF. A read segment used to be forty-five seconds of a screen
 * that answered nothing - while the read itself posed the turn's question.
 * Every segment is playable now except the two that call the room to order. */
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

  room.command('goto', { index: readIdx });
  ok(room._seg().kind === 'read', 'and we are standing on it, not on a checklist');
  ok(room.turnOpen, 'a read segment is PLAYABLE now - this is the scrim coming off');
  ok(room.roamOpen, 'the map is live with it');
  const st2 = room.liveStudents().filter((x) => x.sid === st.sid)[0];
  ok(st2.moveLeft > 0, 'they have movement to use (' + st2.moveLeft + ')');
  const dest = room.privateFor(st.sid).reach.filter((r) => r.cost <= 1)[0];
  ok(room.move(st.sid, dest.hex).ok === true, 'they can walk while the narrator talks');
  ok(room.offerFor(st.sid).length > 0, 'and they are offered something to DO while he talks');
  ok(room.privateFor(st.sid).reach.length > 0, 'the reach is drawn for them');

  /* AND THE ROOM CAN STILL BE CALLED TO ORDER. This is the half of the
   * bargain that matters to a teacher: one adult, thirty twelve-year-olds,
   * and two moments in the period that need every head up. If EYES_UP ever
   * stops closing the turn, the trade this change made is off. */
  const eyes = sessions[0].timeline.findIndex((x) => Room.EYES_UP.indexOf(x.kind) > -1);
  ok(eyes > -1, 'session 1 has an eyes-up segment');
  room.command('goto', { index: eyes });
  ok(!room.turnOpen, 'an eyes-up segment still closes the turn (' + room._seg().kind + ')');
  ok(!room.roamOpen, 'and takes the map with it');
  ok(room.move(st.sid, dest.hex).ok === false, 'walking is refused');
  ok(room.offerFor(st.sid).length === 0, 'and nothing at all is offered');
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
/* ------------------------------------------------------------------ 6
 * TEST MODE. A full class of nobody, so a period can be watched before
 * twenty-six of them arrive. It writes to a real room and a real save file,
 * so the guards matter more than the feature does. */
{
  const { room } = build(0);
  const r = room.command('testMode', { on: true });
  ok(r.ok && r.seated === roster.roster.length,
     'an empty room seats the whole roster (' + r.seated + ')');
  ok(r.away >= 0 && r.away < r.seated,
     r.away + ' of them are away today, because a rehearsal of a full house is the wrong rehearsal');
  ok(room.snapshot().testMode === true, 'and every screen is told it is a rehearsal');
  ok(Object.keys(room.students).every((sid) => sid.indexOf('bot:') === 0),
     'every seat is held by a bot sid, so a real student can take one back');

  const off = room.command('testMode', { on: false });
  ok(off.ok && Object.keys(room.students).length === 0, 'stopping clears every bot');
  ok(room.snapshot().testMode === false, 'and the room stops calling itself a rehearsal');
  ok(room.toJSON().campaign.wasTestMode === true,
     'but the SAVE remembers it forever - a rehearsed period must never be mistaken for a class');
  room.destroy();
}

console.log('');
{
  const { room } = build(3);
  const r = room.command('testMode', { on: true });
  ok(!r.ok && r.error === 'real-students-present',
     'and it refuses outright in a room with ' + r.students + ' real student(s) in it');
  ok(Object.keys(room.students).length === 3, 'leaving them exactly as they were');
  room.destroy();
}

console.log('');
/* ------------------------------------------------------------------ 7
 * PRESENT, not ever-joined. The refusal counted every seat in the room,
 * which made the feature useless on the only rooms a teacher actually has:
 * the ones a class already sat in. A seat nobody has pinged in a minute is
 * a Chromebook that went home. */
{
  const { room, wait } = build(3);
  wait(120);
  ok(room.liveStudents().length === 0, 'two minutes on, nobody is in the room');
  const r = room.command('testMode', { on: true });
  ok(r.ok && r.seated === roster.roster.length,
     'so a room three students walked out of can still be rehearsed (' + r.seated + ' seated)');
  ok(Object.keys(room.students).every((sid) => sid.indexOf('bot:') === 0),
     'and their abandoned seats are held by bots, not by their ghosts');
  room.destroy();
}

console.log('');
/* ------------------------------------------------------------------ 8
 * And it seats them BEFORE the room opens, because that is the order the
 * gate button uses: a period that starts empty and fills up over the next
 * thirty seconds is not the period a class plays. */
{
  let t = 1000000;
  const room = new Room('S', sessions, mapData, roster, scenes, facts,
                        { clock: () => t, manual: true, common: common });
  ok(!room.started, 'the room has not been opened');
  const r = room.command('testMode', { on: true });
  ok(r.ok && r.seated === roster.roster.length,
     'the whole roster sits down anyway (' + r.seated + ')');
  room.command('start');
  ok(room.liveStudents().length === roster.roster.length,
     'and every one of them is still there when it opens');
  room.destroy();
}

console.log('');
/* ------------------------------------------------------------------ 9
 * PICK A SESSION. nextSession only ever stepped forward, and only once a
 * period had closed out, so the only way to reach session 2 was to teach
 * session 1 to the end - and there was no button for either. */
{
  const { room } = build(4);
  const snap = room.snapshot();
  ok((snap.meta.sessions || []).length === sessions.length,
     'the snapshot names what there is to choose from (' + (snap.meta.sessions || []).length + ')');

  const mid = room.command('setSession', { index: 1 });
  ok(!mid.ok && mid.error === 'period-in-progress',
     'it refuses while a class is standing in the middle of a period');
  ok(room.sessionIndex === 0, 'and leaves them in the one they were in');

  const forced = room.command('setSession', { index: 1, force: true });
  ok(forced.ok && room.sessionIndex === 1, 'told twice, it switches');
  ok(!room.started, 'the period starts over');
  ok(room.liveStudents().length === 4, 'and the class is still in their seats');

  ok(room.command('setSession', { index: 99, force: true }).error === 'no-such-session',
     'a session that does not exist is refused rather than clamped');
  room.destroy();
}

console.log('');
/* ------------------------------------------------------------------ 10
 * EXPLORATION STAYS OPEN ACROSS NARRATION AND WINDOW BOUNDARIES.
 * Boss budgets are covered by test-adventure.js. Never drain an unlimited
 * exploration budget in an unbounded loop. */
{
  const { room } = build(8);
  const st = room.liveStudents()[0];

  const crossTown = () => {
    const you = room.privateFor(st.sid);
    const step = you.reach.slice().sort((a, b) => b.cost - a.cost)[0];
    ok(you.movementFree, 'exploration explicitly reports free movement');
    ok(step && step.cost > st.move, 'a destination beyond a challenge budget is reachable');
    const before = st.moveLeft;
    ok(step && room.move(st.sid, step.hex).ok, 'the server accepts the long walk');
    ok(st.moveLeft === before, 'walking does not spend challenge movement');
  };

  const win = sessions[0].timeline.findIndex((x) => x.window);
  ok(sessions[0].timeline[win + 1].roam && sessions[0].timeline[win + 2].roam,
     'a turn window really is followed by two roaming reads');

  room.command('goto', { index: win });
  crossTown();
  crossTown();

  room.command('goto', { index: win + 1 });
  crossTown();

  room.command('goto', { index: win + 2 });
  crossTown();

  room.command('goto', { index: win + 3 });
  crossTown();
  room.destroy();
}

console.log('');
/* ------------------------------------------------------------------ 11
 * The spread survives the clamp - a Rider is still a Rider - and nobody is
 * left on a budget that walks to nothing. */
{
  const { room } = build(30);
  const seen = {};
  room.liveStudents().forEach((st) => {
    const m = room.effective(st).move;
    (seen[st.calling] = seen[st.calling] || {})[m] = true;
    ok(m >= Room.MOVE_MIN && m <= Room.MOVE_MAX,
       st.calling + ' walks ' + m + ', inside ' + Room.MOVE_MIN + '–' + Room.MOVE_MAX) ;
  });
  const fast = Object.keys(seen.RIDER || {}).map(Number).sort().pop();
  const slow = Object.keys(seen.CLERK || {}).map(Number).sort()[0];
  ok(fast > slow, 'a Rider still outwalks a Clerk (' + fast + ' against ' + slow + ')');
  room.destroy();
}

console.log('');
console.log(fails === 0 ? '  ✓ their map says GO HERE and their top card says what to press'
                        : '  ✗ ' + fails + ' failure(s)');
console.log('');
process.exit(fails === 0 ? 0 : 1);
