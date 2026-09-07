#!/usr/bin/env node
/* test-abilities.js — the eight Calling abilities, against what the cards say.
 *
 * Every one of these is printed on a Calling Card that sits beside a student's
 * Slate all campaign, and until now was executed by nothing at all. The point
 * of this file is that the app and the paper agree — including the words
 * "once per session", which appear on all eight cards and which st.used cannot
 * express, because st.used resets on a scene change.
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

const ABIL = {
  RIFLEMAN: 'ABIL_STEADY', RIDER: 'ABIL_AHEAD', SMITH: 'ABIL_MADE', TRADER: 'ABIL_LEDGER',
  CLERK: 'ABIL_CHAPTER', HEALER: 'ABIL_HANDS', RANCHERO: 'ABIL_OLDER', HOUSEHOLDER: 'ABIL_HOWMANY',
};

function build(n, opts) {
  let t = 1000000;
  /* Room takes the whole session LIST as its first argument — passing one
   * object gives you a campaign of length 1 and loadSession(1) refuses. */
  const room = new Room('A', sessions, mapData, roster, scenes, facts,
                        { clock: () => t, manual: true, common: common });
  const take = (opts && opts.ids) || roster.roster.slice(0, n).map((p) => p.id);
  take.forEach((id, i) => room.join('a' + i, id));
  room.command('start');
  const beat = sessions[0].timeline.findIndex((x) => x.kind === 'beat' && x.window);
  room.command('goto', { index: beat });
  return { room, beat };
}
const offered = (room, st) => room.offerFor(st.sid).map((a) => a.id);

console.log('');
console.log('ABILITIES — what the Calling Card already promised');
console.log('');

/* 1 · each Calling is offered its own, and nobody else's */
{
  const { room } = build(30);
  const live = room.liveStudents();
  let good = 0, leaked = 0;
  live.forEach((st) => {
    const list = offered(room, st);
    if (list.indexOf(ABIL[st.calling]) !== -1) good++;
    Object.keys(ABIL).forEach((c) => {
      if (c !== st.calling && list.indexOf(ABIL[c]) !== -1) leaked++;
    });
  });
  ok(good === live.length, 'all ' + live.length + ' students are offered their own ability');
  ok(leaked === 0, 'and nobody is offered another Calling\'s');
  ok(Object.keys(ABIL).length === 8,
     'eight abilities, not thirty - they key off Calling, so a householder shares theirs seven ways');
  room.destroy();
}

console.log('');
/* 2 · once per SESSION, which st.used cannot express */
{
  const { room } = build(30);
  const st = room.liveStudents().filter((x) => x.calling === 'CLERK')[0];
  ok(offered(room, st).indexOf('ABIL_CHAPTER') !== -1, 'the clerk is offered it');
  const r = room.perform(st.sid, 'ABIL_CHAPTER');
  ok(r.ok, 'and can spend it');
  ok(!!st.flags.ABILITY_SPENT, 'which sets the spend flag');
  st.declared = false;
  ok(offered(room, st).indexOf('ABIL_CHAPTER') === -1, 'it is gone for the rest of the scene');

  /* the whole point: a scene change clears st.used, and must NOT give it back */
  const elsewhere = sessions[0].timeline
    .map((x, i) => ({ x, i }))
    .filter((e) => e.x.kind === 'beat' && e.x.window && e.x.scene !== room.sceneId);
  ok(elsewhere.length > 0, 'session 1 has a beat on another scene to walk to');
  room.command('goto', { index: elsewhere[0].i });
  st.declared = false;
  ok(Object.keys(st.used).length === 0, 'st.used has been cleared by the scene change');
  ok(offered(room, st).indexOf('ABIL_CHAPTER') === -1,
     'and the ability is STILL spent - session, not scene');
  room.destroy();
}

console.log('');
/* 3 · and it comes back next session */
{
  const { room } = build(30);
  const st = room.liveStudents().filter((x) => x.calling === 'CLERK')[0];
  room.perform(st.sid, 'ABIL_CHAPTER');
  ok(!!st.flags.ABILITY_SPENT, 'spent in session 1');
  room.loadSession(1);
  ok(!st.flags.ABILITY_SPENT, 'and recharged by session 2 - flags otherwise persist forever');
  room.destroy();
}

console.log('');
/* 4 · STEADY: a 7-9 on an ARMS muster, and nothing else */
{
  const { room } = build(30);
  const st = room.liveStudents().filter((x) => x.calling === 'RIFLEMAN')[0];
  room.perform(st.sid, 'ABIL_STEADY');
  ok(st.tierUp === 1, 'the rifleman banks it');

  const eng = room.engine;
  const real = eng.d6.bind(eng);
  const arms = {
    id: 'X_ARMS', verb: 'ACT', label: 'x', detail: 'x', requires: {},
    roll: { stat: 'arms', dc: 7 },
    outcomes: { strong: { narrate: 's' }, partial: { narrate: 'p' }, weak: { narrate: 'w' } },
  };
  const talk = Object.assign({}, arms, { id: 'X_TALK', roll: { stat: 'talk', dc: 7 } });
  eng.actions.X_ARMS = arms;
  eng.actions.X_TALK = talk;

  /* The dice have to land 7-9 AFTER the stat, not before it — this rifleman
   * has arms 3, so a flat 4+4 is already an 11 and needs no help. */
  const pips = (stat) => Math.max(1, Math.round((8 - (st.stats[stat] || 0)) / 2));
  eng.d6 = () => pips('talk');
  const t1 = eng.resolve('X_TALK', room.ctxFor(st), { tierUp: st.tierUp });
  ok(t1.tier === 'partial' && !t1.steadied,
     'a TALK roll of 7-9 is not steadied - the card says Arms (total ' + t1.total + ')');
  eng.d6 = () => pips('arms');
  const a1 = eng.resolve('X_ARMS', room.ctxFor(st), { tierUp: st.tierUp });
  ok(a1.tier === 'strong' && a1.steadied,
     'an ARMS roll of 7-9 becomes a 10+ (total ' + a1.total + ')');

  eng.d6 = () => 6;                     // 6+6 = 12, already strong
  const a2 = eng.resolve('X_ARMS', room.ctxFor(st), { tierUp: st.tierUp });
  ok(a2.tier === 'strong' && !a2.steadied, 'a roll that was already strong does not spend it');

  eng.d6 = () => 1;                     // 1+1 = 2, weak
  const a3 = eng.resolve('X_ARMS', room.ctxFor(st), { tierUp: st.tierUp });
  ok(a3.tier === 'weak' && !a3.steadied, 'and neither does a weak one - the card promises a 7-9');

  eng.d6 = real;
  room.destroy();
}

console.log('');
/* 5 · HANDS reaches a company, not a neighbour */
{
  const c5 = roster.roster.filter((p) => p.company === 'C5').map((p) => p.id);
  const c1 = roster.roster.filter((p) => p.company === 'C1').map((p) => p.id).slice(0, 2);
  const { room } = build(0, { ids: c5.concat(c1) });
  const live = room.liveStudents();
  const healer = live.filter((x) => x.calling === 'HEALER')[0];
  live.forEach((x) => { x.resolveUsed = 2; });
  room.perform(healer.sid, 'ABIL_HANDS');
  const mine = live.filter((x) => x.company === healer.company);
  const theirs = live.filter((x) => x.company !== healer.company);
  ok(mine.length > 1 && mine.every((x) => x.resolveUsed === 1),
     'every one of the healer\'s company is cleared (' + mine.length + ')');
  ok(theirs.length > 0 && theirs.every((x) => x.resolveUsed === 2),
     'and nobody else is (' + theirs.length + ')');
  room.destroy();
}

console.log('');
/* 6 · THE LEDGER helps YOU, which is the opposite way round from AID */
{
  const { room } = build(30);
  const tr = room.liveStudents().filter((x) => x.calling === 'TRADER')[0];
  const before = tr.aidBonus || 0;
  const r = room.perform(tr.sid, 'ABIL_LEDGER');
  ok(r.ok, 'the trader can call a debt in (needs somebody adjacent to name)');
  ok(tr.aidBonus === before + 1, 'and the help runs toward THEM, not away');
  room.destroy();
}

console.log('');
/* 7 · HOW MANY DAYS changes what everybody else is looking at */
{
  const { room } = build(30);
  const live = room.liveStudents();
  const hh = live.filter((x) => x.calling === 'HOUSEHOLDER')[0];
  const other = live.filter((x) => x.sid !== hh.sid)[0];
  ok(room.privateFor(other.sid).ledger === null, 'nobody can see the ledger to start with');
  room.perform(hh.sid, 'ABIL_HOWMANY');
  const led = room.privateFor(other.sid).ledger;
  ok(Array.isArray(led) && led.length > 0,
     'after one householder declares it, everybody can (' +
     (led || []).map((l) => l.label + ' ' + l.value).join(', ') + ')');
  room.destroy();
}

console.log('');
/* 8 · a class of one still has an ability */
{
  const healerId = roster.roster.filter((p) => p.calling === 'HEALER')[0].id;
  const { room } = build(0, { ids: [healerId] });
  const st = room.liveStudents()[0];
  ok(offered(room, st).indexOf(ABIL[st.calling]) !== -1,
     'the solo player is offered theirs (' + st.calling + ')');
  st.resolveUsed = 2;
  room.perform(st.sid, 'ABIL_HANDS');
  ok(st.resolveUsed === 1, 'a company of one is still a company');
  room.destroy();
}

console.log('');
console.log(fails === 0 ? '  ✓ the app does what the Calling Card says' : '  ✗ ' + fails + ' failure(s)');
console.log('');
process.exit(fails === 0 ? 0 : 1);
