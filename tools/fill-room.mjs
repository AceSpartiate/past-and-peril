/* fill-room.mjs — put a class in the room, over the wire.
 *
 *     node tools/fill-room.mjs                 22 students into GN7B
 *     node tools/fill-room.mjs --n 28
 *     node tools/fill-room.mjs --room 7B --n 25
 *     node tools/fill-room.mjs --host 192.168.4.38
 *     node tools/fill-room.mjs --quiet          join, then sit still
 *
 * WHY THIS EXISTS
 *
 * You cannot be thirty students. tools/sim-class.js already drives thirty bots
 * against the engine, but it does that IN PROCESS — it never opens a socket,
 * so it proves nothing about the server, the SSE streams, the roster locking,
 * the Calling caps, or whether the console and the projector actually show a
 * full room.
 *
 * This joins over HTTP, exactly the way a Chromebook does. Every request it
 * makes is a request a tapping finger makes. So while it runs you can sit at
 * the console with a real class in front of you, watch the coverage meter
 * move, put the projector up, and open one more browser window as a real
 * student standing among them.
 *
 * It is NOT a substitute for children. Read the last four lines of
 * tools/sim-class.js.
 *
 * Ctrl-C leaves cleanly: the bots stop, the server ages them out, and the
 * period is untouched. */

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i === -1 ? dflt : args[i + 1];
};
const has = (name) => args.indexOf('--' + name) !== -1;

const HOST = flag('host', 'localhost');
const PORT = Number(flag('port', 8099));
const ROOM = flag('room', null);
const WANT = Number(flag('n', 22));
const QUIET = has('quiet');
const BASE = 'http://' + HOST + ':' + PORT;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* deterministic, so a run you liked can be run again */
let seed = Number(flag('seed', 7)) >>> 0 || 7;
function rnd() {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 4294967296;
}
const pick = (a) => a[Math.floor(rnd() * a.length)];

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}
async function get(path) {
  const r = await fetch(BASE + path);
  return r.json();
}

/* ------------------------------------------------------------------- boot */
let hello;
try {
  hello = await get('/api/hello');
} catch (e) {
  console.log('\n  No server at ' + BASE);
  console.log('  Start it first:   node server/serve.js\n');
  process.exit(1);
}
const room = ROOM || hello.classCode;
console.log('\nFILLING ' + room + ' at ' + BASE);
console.log('  ' + hello.title + '  (session ' + hello.session + ')');

const res = await get('/api/roster?room=' + encodeURIComponent(room));
const roster = res.roster || [];
const free = roster.filter((p) => !p.taken && !p.retired);
console.log('  ' + roster.length + ' names, ' + free.length + ' free\n');

/* Join in a sensible order: the trades the town is short of first, which is
 * what the pick screen tells a real class to do, so the Calling caps get
 * exercised the way they would be in a room. */
const order = free.slice().sort((a, b) => {
  if (!!b.wanted !== !!a.wanted) return b.wanted ? 1 : -1;
  return 0;
});

const bots = [];
for (const person of order) {
  if (bots.length >= WANT) break;
  const sid = 'fill-' + person.id;
  const j = await post('/api/join', { room, sid, characterId: person.id });
  if (!j.ok) {
    console.log('  -- ' + person.name.padEnd(24) + j.error +
                (j.error === 'calling-full' ? '   (the cap doing its job)' : ''));
    continue;
  }
  bots.push({ sid, id: person.id, name: person.name, calling: person.calling, nextAt: 0 });
  console.log('  ok ' + person.name.padEnd(24) + person.calling);
  await sleep(60);            // arrive like people, not like a load test
}

const taken = {};
bots.forEach((b) => { taken[b.calling] = (taken[b.calling] || 0) + 1; });
console.log('\n  ' + bots.length + ' in the room:  ' +
  Object.keys(taken).sort().map((c) => c + ' ' + taken[c]).join(' · '));
console.log('\n  Now open, on this laptop:');
console.log('    the desk        ' + BASE + '/?key=' + (process.env.TEACHER_KEY || 'see the server output'));
console.log('    the projector   ' + BASE + '/stage.html');
console.log('    one student     ' + BASE + '/p?sid=me');
console.log('\n  Press START on the desk. Ctrl-C here when you are done.\n');

if (QUIET) {
  console.log('  --quiet: they will stand there and do nothing.\n');
  setInterval(() => { bots.forEach((b) => post('/api/act', { room, sid: b.sid, type: 'ping' }).catch(() => {})); }, 8000);
} else {
  loop();
}

/* ------------------------------------------------------------------- play
 * One pass every second: keep the connection warm, and if the window is open
 * move a bit and take an action. Latency per bot is spread so thirty of them
 * do not all act on the same tick, which is the thing that makes a console
 * look fake. */
async function loop() {
  let t = 0;
  for (;;) {
    t += 1;
    let open = false, seg = '';
    try {
      const st = await get('/api/hello');   // cheap liveness
      open = true;
    } catch (e) { /* server went away; keep trying */ }

    for (const b of bots) {
      try {
        const r = await post('/api/act', { room, sid: b.sid, type: 'ping' });
        const you = r && r.you;
        if (!you) continue;
        const windowOpen = you.reach !== undefined && (you.actions || []).length > 0;

        if (t < b.nextAt) continue;

        /* move, sometimes, and prefer somewhere the scene cares about */
        if ((you.reach || []).length && rnd() < 0.7) {
          const hex = pick(you.reach).hex;
          await post('/api/act', { room, sid: b.sid, type: 'move', hex });
        }

        /* then do something, if there is anything and we have not yet */
        const acts = you.actions || [];
        if (acts.length && !you.declared) {
          const a = rnd() < 0.25 ? acts[0] : pick(acts);
          await post('/api/act', { room, sid: b.sid, type: 'act', actionId: a.id });
          /* a real student takes 20 to 60 seconds over the next one */
          b.nextAt = t + 20 + Math.floor(rnd() * 40);
        }
      } catch (e) { /* one bot failing is not an outage */ }
    }
    await sleep(1000);
  }
}

/* ---------------------------------------------------------------- goodbye */
let leaving = false;
async function bye() {
  if (leaving) return;
  leaving = true;
  console.log('\n  letting go of ' + bots.length + ' students…');
  /* There is no /api/leave — the server ages a quiet student out and keeps
   * their claim for fifteen seconds so a reconnect works. Closing is enough. */
  console.log('  done. The period itself is untouched.\n');
  process.exit(0);
}
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
