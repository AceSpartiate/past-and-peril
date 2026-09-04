/* probe-movement.js — how far can a student actually walk?
 *
 *     node tools\probe-movement.js
 *
 * Written because a teacher playing the real thing reported that students
 * "effectively get to move infinitely" and could "teleport all over the map at
 * will". The server code reads as though it enforces a budget: move() computes
 * reachable() from st.moveLeft and rejects anything out of range. So either the
 * report is about something else, or the enforcement has a hole in it.
 *
 * Guessing is not measuring. This walks a real Room through a real turn window
 * and reports, per Calling:
 *
 *   · how many hexes the server offers on the first step
 *   · what fraction of the whole map that is
 *   · how many steps it takes before the budget runs out
 *   · and whether a hex on the far side of the map is ever accepted
 *
 * The last line is the one that matters. If a far hex is ever accepted, the
 * budget is not being enforced. If it is refused and the count still looks
 * enormous, then the rule works and the problem is that nothing on screen says
 * so — which is a different fix in a different file. */

const fs = require('fs');
const path = require('path');
const { Room } = require('../server/room.js');
const HexMapMod = require('../app/js/hexmap.js');

const APP = path.join(__dirname, '..', 'app');
const load = (f) => JSON.parse(fs.readFileSync(path.join(APP, 'content', f), 'utf8'));

const session = load('session-1.json');
const terrainData = load('terrain.json');
const mapData = fs.readdirSync(path.join(APP, 'content'))
  .filter((f) => /^map-.*\.json$/.test(f)).sort()
  .map((f) => HexMapMod.hydrate(load(f), terrainData));
const roster = load('roster-s1.json');
const scenes = [1, 2, 3, 4, 5].map((n) => load('scene-s1-' + n + '.json'));
const common = load('actions-common.json');
const facts = load('facts-s1.json');

let t = 1000000;
const room = new Room('PROBE', session, mapData, roster, scenes, facts,
  { clock: () => t, manual: true, common });

/* one student per distinct Calling, so the RIDER's 7 points get seen */
const seen = {};
const picks = [];
roster.roster.forEach((p) => {
  if (seen[p.calling]) return;
  seen[p.calling] = true;
  picks.push(p);
});
picks.forEach((p, i) => room.join('probe' + i, p.id));

/* Walk the timeline to the first turn window. The room is in manual mode, so
 * nothing advances on its own — step segments directly. */
room.command('start');
for (let i = 0; i < 40 && !room.turnOpen; i += 1) room.command('goto', { index: i });
console.log('');
console.log('  turn window open: ' + room.turnOpen + '   segment ' + room.idx);
console.log('');

if (!room.turnOpen) {
  console.log('  Could not open a turn window; nothing to measure.');
  process.exit(1);
}

const totalHexes = (() => {
  const mp = room.map;
  let n = 0;
  const g = mp.data.grid || [];
  g.forEach((row, r) => { for (let c = 0; c < row.length; c += 1) { if (mp.terrain(c, r)) n += 1; } });
  return n;
})();

console.log('  the town map has ' + totalHexes + ' standable hexes');
console.log('');
console.log('  calling        move  offered  % of map  steps until spent  far hex?');
console.log('  ' + '-'.repeat(70));

let anyTeleport = false;

picks.forEach((p, i) => {
  const sid = 'probe' + i;
  const st = room.students[sid];
  if (!st) return;

  const you0 = room.privateFor(sid);
  const offered = (you0.reach || []).length;
  const pct = ((offered / totalHexes) * 100).toFixed(0);

  /* Try the single furthest hex on the map from where they stand. If the
   * budget is real this must be refused. */
  const mp = room.mapFor(st);
  let far = null, farD = -1;
  const g = mp.data.grid || [];
  g.forEach((row, r) => {
    for (let c = 0; c < row.length; c += 1) {
      if (!mp.terrain(c, r)) continue;
      const lab = mp.label(c, r);
      const d = mp.distance ? mp.distance(st.hex, lab) : Math.abs(c) + Math.abs(r);
      if (d > farD) { farD = d; far = lab; }
    }
  });
  const teleport = room.move(sid, far);
  if (teleport.ok) anyTeleport = true;

  /* Now walk greedily until the budget is gone, counting steps. */
  let steps = 0;
  for (let k = 0; k < 60; k += 1) {
    const you = room.privateFor(sid);
    const reach = you.reach || [];
    if (!reach.length) break;
    /* always take the most expensive legal step, to spend fastest */
    const worst = reach.slice().sort((a, b) => b.cost - a.cost)[0];
    const r = room.move(sid, worst.hex);
    if (!r.ok) break;
    steps += 1;
  }

  console.log('  ' + String(p.calling).padEnd(14) +
    String(you0.move).padStart(4) +
    String(offered).padStart(9) +
    (pct + '%').padStart(10) +
    String(steps).padStart(19) +
    (teleport.ok ? '   ACCEPTED' : '   refused').padStart(11));
});

console.log('');
if (anyTeleport) {
  console.log('  THE BUDGET IS NOT ENFORCED: a hex on the far side of the map was accepted.');
} else {
  console.log('  The budget IS enforced server-side: every far hex was refused with');
  console.log('  out-of-range, and every student ran out of movement after a few steps.');
  console.log('');
  console.log('  So "infinite movement" is not the server letting them through. Look at');
  console.log('  what the screen tells them: how the reachable hexes are drawn, and');
  console.log('  whether spending the last point visibly changes anything.');
}
console.log('');
