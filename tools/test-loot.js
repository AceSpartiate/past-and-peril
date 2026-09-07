#!/usr/bin/env node
/* test-loot.js — items grant access, never magnitude, and a chest serves the
 * whole room rather than the first person to reach it.
 *
 * Both halves of Slice 2 have to be true at once. Personal containers without
 * the stat deletion is the largest stat-inflation event available in this
 * codebase, arriving inside a commit labelled safe; the stat deletion without
 * personal containers leaves ten of fourteen containers dead by period two.
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
const scenes = [1, 2, 3, 4, 5, 6].map((n) => load('scene-s2-' + n + '.json'));
const common = load('actions-common.json');
const facts = load('facts-s1.json');

let fails = 0;
const ok = (c, w) => { console.log('  ' + (c ? 'ok  ' : 'FAIL') + '  ' + w); if (!c) fails++; };

function build(n) {
  const session = load('session-2.json');
  let t = 1000000;
  const room = new Room('L', session, mapData, roster, scenes, facts,
                        { clock: () => t, manual: true, common: common });
  for (let i = 0; i < n; i++) room.join('s' + i, roster.roster[i].id);
  room.command('start');
  return { room, ping: () => { for (let i = 0; i < n; i++) room.ping('s' + i); } };
}

console.log('');
console.log('LOOT — access, not magnitude');
console.log('');

/* 1 · no item can reach the dice */
{
  const { room } = build(2);
  const st = room.liveStudents()[0];
  const before = JSON.stringify(room.effective(st).stats);
  ['ITEM_KEG_POWDER', 'ITEM_GOOD_TOOLS', 'ITEM_COLONY_PAPERS', 'ITEM_LEDGER_BOOK'].forEach((i) => st.items.push(i));
  const after = JSON.stringify(room.effective(st).stats);
  ok(before === after, 'four items change no stat at all (' + before + ')');
  const moveWas = room.effective(st).move;
  st.items.push('ITEM_GOOD_HORSE');
  ok(room.effective(st).move === moveWas + 2, 'effect.move still moves you: ' + moveWas + ' -> ' + room.effective(st).move);
  room.destroy();
}

console.log('');
/* 2 · a chest serves the room, not the first person to it */
{
  const { room } = build(3);
  const [a, b] = room.liveStudents();
  const f = room.feature('CACHE_FORD');
  ok(room.engine.openTo(f, a) && room.engine.openTo(f, b), 'the ford is open to both of them');
  f.takenBy = { [a.characterId]: true };
  ok(!room.engine.openTo(f, a), 'the one who took it cannot take it twice');
  ok(room.engine.openTo(f, b), 'and it is still there for everybody else');
  f.depth = 1;
  ok(!room.engine.openTo(f, b), 'depth 1 makes a container genuinely unique when it has to be');
  room.destroy();
}

console.log('');
/* 3 · slots decline rather than swap */
{
  const { room } = build(1);
  const st = room.liveStudents()[0];
  ok(room.giveItem(st, 'ITEM_LONG_RIFLE') === 'A Kentucky long rifle', 'the rifle goes in hand');
  ok(room.giveItem(st, 'ITEM_BROWN_BESS') === null, 'the Bess is declined — the hand is full, and there is no swap screen');
  ok(room.giveItem(st, 'ITEM_SCRAP_IRON') !== null, 'a pocket item still fits');
  ok(room.giveItem(st, 'ITEM_LONG_RIFLE') === null, 'you cannot take the same thing twice');
  ok(room.giveItem(st, 'ITEM_LEDGER_BOOK') !== null, 'carried is uncapped');
  ok(room.giveItem(st, 'ITEM_COLONY_PAPERS') !== null, 'and stays uncapped');
  room.destroy();
}

console.log('');
/* 4 · requires.item gates, and only for the holder */
{
  const { room } = build(2);
  /* offerFor returns nothing unless a turn window is open, so walk to a beat. */
  const beat = load('session-2.json').timeline.findIndex((x) => x.kind === 'beat' && x.window);
  room.command('goto', { index: beat });
  const [a, b] = room.liveStudents();
  room.giveItem(a, 'ITEM_LONG_RIFLE');
  const has = (st) => room.offerFor(st.sid).some((x) => x.id === 'KIT_RIFLE_MARK');
  ok(has(a), 'the holder is offered the rifle action');
  ok(!has(b), 'the student without one is not');
  room.destroy();
}

console.log('');
/* 5 · the drop. Nobody rolls, nobody is unlucky, and a TRADER's kit is not a
 *     RIFLEMAN's kit — that is the difference between a set and a uniform. */
{
  const session = load('session-2.json');
  session.timeline = [{
    id: 'drop', kind: 'read', scene: 'S2.1', seconds: 30,
    drop: 'ITEM_SCRAP_IRON',
    drop_by_calling: { TRADER: 'ITEM_LEDGER_BOOK', RIFLEMAN: 'ITEM_POWDER_HORN' },
  }];
  let t = 1000000;
  const room = new Room('L', session, mapData, roster, scenes, facts,
                        { clock: () => t, manual: true, common: common });
  for (let i = 0; i < 12; i++) room.join('d' + i, roster.roster[i].id);
  room.command('start');
  const live = room.liveStudents();
  const traders = live.filter((s) => s.calling === 'TRADER');
  const riflemen = live.filter((s) => s.calling === 'RIFLEMAN');
  const others = live.filter((s) => s.calling !== 'TRADER' && s.calling !== 'RIFLEMAN');
  ok(live.length > 0 && live.every((s) => (s.items || []).length === 1), 'everybody present got exactly one thing');
  ok(traders.every((s) => s.items[0] === 'ITEM_LEDGER_BOOK'), 'traders got the ledger (' + traders.length + ')');
  ok(riflemen.every((s) => s.items[0] === 'ITEM_POWDER_HORN'), 'riflemen got the horn (' + riflemen.length + ')');
  ok(others.every((s) => s.items[0] === 'ITEM_SCRAP_IRON'), 'everybody else got the fallback (' + others.length + ')');
  room.destroy();
}

console.log('');
/* 6 · a class of one still gets its drop */
{
  const session = load('session-2.json');
  session.timeline = [{ id: 'drop', kind: 'read', scene: 'S2.1', seconds: 30, drop: 'ITEM_SCRAP_IRON' }];
  let t = 1000000;
  const room = new Room('L', session, mapData, roster, scenes, facts,
                        { clock: () => t, manual: true, common: common });
  room.join('solo', roster.roster[0].id);
  room.command('start');
  ok(room.liveStudents()[0].items[0] === 'ITEM_SCRAP_IRON', 'the floor of one is served like anybody else');
  room.destroy();
}

console.log('');
console.log(fails === 0 ? '  ✓ loot grants access and never magnitude' : '  ✗ ' + fails + ' failure(s)');
console.log('');
process.exit(fails === 0 ? 0 : 1);
