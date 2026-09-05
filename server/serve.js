#!/usr/bin/env node
/* serve.js — the classroom server. Zero dependencies.
 *
 * WHY THIS RUNS ON YOUR LAPTOP AND NOT IN THE CLOUD
 * design/09-screens-and-cloud.md specified Cloudflare Workers + Durable
 * Objects, and that remains a fine destination. It is not the right FIRST
 * target for this room:
 *   · nothing leaves the building, so there is no vendor to get vetted
 *   · no account, no bill, no deploy step
 *   · IT WORKS WHEN THE SCHOOL WIFI IS DOWN — students reach your laptop over
 *     the local network even when the building has no internet at all
 * `Room` is transport-agnostic, so hosting it in a Durable Object later is a
 * swap rather than a rewrite.
 *
 * WHY SSE AND NOT WEBSOCKETS
 * Broadcast is one-way (server → thirty screens) and actions are occasional
 * POSTs, which is exactly the shape SSE fits. EventSource also reconnects by
 * itself for free — a closed Chromebook lid resumes with no code — and school
 * proxies that sometimes block WebSocket upgrades never block plain HTTP.
 *
 *   node server/serve.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Room } = require('./room.js');
const { Store } = require('./store.js');
const handouts = require('./handouts.js');
const people = require('./people.js');

const ROOT = path.join(__dirname, '..', 'app');
const PORT = process.env.PORT ? Number(process.env.PORT) : 8099;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2',
};

/* ------------------------------------------------------------------ content */
const SESSION_FILES = ['session-1', 'session-2'];
const sessions = SESSION_FILES.map((f) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'content', f + '.json'), 'utf8')));
const session = sessions[0];
/* EVERY PLACE IN THE CAMPAIGN.
 *
 * Any content/map-*.json is a place — the town, Béxar, the inside of a house.
 * Dropping a new one in the folder adds it to the world with no code change,
 * which is the same promise design/11 makes about the ASCII grids themselves.
 * Each is hydrated against the master legend in terrain.json so a map file is
 * a grid and a few landmarks, never a colour scheme. */
const HexMapMod = require('../app/js/hexmap.js');
const terrainData = JSON.parse(fs.readFileSync(path.join(ROOT, 'content/terrain.json'), 'utf8'));
const MAP_FILES = fs.readdirSync(path.join(ROOT, 'content'))
  .filter((f) => /^map-.*\.json$/.test(f)).sort();
const mapData = MAP_FILES.map((f) =>
  HexMapMod.hydrate(JSON.parse(fs.readFileSync(path.join(ROOT, 'content', f), 'utf8')), terrainData));
console.log('  · ' + mapData.length + ' places: ' + mapData.map((m) => m.id).join(', '));
const roster = JSON.parse(fs.readFileSync(path.join(ROOT, 'content/roster-s1.json'), 'utf8'));
const SCENE_FILES = ['scene-s1-1', 'scene-s1-2', 'scene-s1-3', 'scene-s1-4', 'scene-s1-5',
                     'scene-s2-1', 'scene-s2-2', 'scene-s2-3', 'scene-s2-4', 'scene-s2-5'];
const sceneData = SCENE_FILES.map((f) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'content', f + '.json'), 'utf8')));
const factsData = JSON.parse(fs.readFileSync(path.join(ROOT, 'content/facts-s1.json'), 'utf8'));
const commonData = JSON.parse(fs.readFileSync(path.join(ROOT, 'content/actions-common.json'), 'utf8'));

/* One Room per class code. Five periods a day = five rooms, each with its own
 * campaign, exactly as design/09 wanted from a Durable Object per period. */
const store = new Store(path.join(__dirname, '..', 'data'));
const rooms = new Map();

function getRoom(code) {
  code = (code || roster.classCode || 'GN7B').toUpperCase().slice(0, 12);
  if (rooms.has(code)) return rooms.get(code);

  const room = new Room(code, sessions, mapData, roster, sceneData, factsData,
                        { common: commonData });
  const saved = store.read(code);
  if (saved && room.restore(saved)) {
    console.log('  · ' + code + ' restored — ' +
      (saved.period.finished ? 'session complete' : 'segment ' + saved.period.idx) +
      ', ' + (saved.students || []).length + ' characters, ' +
      (saved.history || []).length + ' prior session(s)');
  }
  room.onChange((r) => store.write(code, r.toJSON()));
  rooms.set(code, room);
  return room;
}

/* Save every open room. Called on the way out, and periodically, because a
 * classroom laptop is not shut down politely. */
function saveAll(reason) {
  let n = 0;
  rooms.forEach((room, code) => { if (store.write(code, room.toJSON())) n += 1; });
  if (n) console.log('  · saved ' + n + ' room' + (n > 1 ? 's' : '') + (reason ? ' (' + reason + ')' : ''));
}
setInterval(() => saveAll(), 60000).unref();

['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, () => { saveAll('shutting down'); process.exit(0); });
});
process.on('uncaughtException', (e) => {
  console.error('uncaught: ' + (e && e.stack));
  saveAll('after a crash');
  process.exit(1);
});

/* The teacher key. Printed in the terminal, never on a student's screen. It is
 * not a security boundary against a determined adult — it stops a bored
 * twelve-year-old from finding the pause button.
 *
 * It is PERSISTED, so the teacher bookmarks the console URL once and it keeps
 * working after every restart. A key that changed each boot would mean hunting
 * through terminal output at 8:41am, which is when this must not happen. */
const KEY_FILE = path.join(__dirname, '..', '.teacher-key');
function teacherKey() {
  if (process.env.TEACHER_KEY) return process.env.TEACHER_KEY;
  try {
    const k = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (k) return k;
  } catch (e) { /* first run */ }
  const k = crypto.randomBytes(3).toString('hex');
  try { fs.writeFileSync(KEY_FILE, k); } catch (e) { /* read-only disk: still works this session */ }
  return k;
}
const TEACHER_KEY = teacherKey();

/* ------------------------------------------------------------------ helpers */
function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({ 'Cache-Control': 'no-cache' }, headers || {}));
  res.end(body);
}
function json(res, code, obj) {
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
  });
}
/* Which address do I tell the children? See server/addresses.js — that used to
 * live here AND in tools/preflight.mjs, in two copies that gave the same wrong
 * answer, which is exactly how one gets fixed and the other does not. */
const addresses = require('./addresses.js');

/* Addresses a real client has connected to us on: the strongest signal there
 * is, because it is evidence rather than inference. One string compare per
 * request. */
const confirmedAddrs = new Set();
function noteLocalAddress(req) {
  try {
    let a = req.socket && req.socket.localAddress;
    if (!a) return;
    a = String(a).replace(/^::ffff:/, '');           // IPv4-mapped IPv6
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(a)) return;
    if (a === '127.0.0.1') return;                   // the teacher's own browser
    confirmedAddrs.add(a);
  } catch (e) { /* bookkeeping must never break a request */ }
}

function rankedAddresses() { return addresses.ranked(confirmedAddrs); }
function lanAddresses() { return addresses.list(confirmedAddrs); }

/* ------------------------------------------------------------------ SSE */
function stream(req, res, room, sid, role) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');

  let last = '';
  const push = (snap) => {
    try {
      const payload = { state: snap };
      if (role === 'student') payload.you = room.privateFor(sid);
      const s = JSON.stringify(payload);
      if (s === last) return;              // don't spend a school network on no-ops
      last = s;
      res.write('data: ' + s + '\n\n');
    } catch (e) { /* a dead socket is not an emergency */ }
  };

  const off = room.subscribe(push, { viewer: role !== 'student' });
  const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 20000);

  /* Listen on the RESPONSE, not the request. For a GET with no body Node
   * considers the *request* complete as soon as the headers are in, so
   * req.on('close') fires immediately and would tear down a stream that is
   * still very much alive. res 'close' is the connection actually going away. */
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(beat);
    off();
    if (role === 'student' && sid) room.leave(sid);
    if (process.env.DEBUG_STREAMS) console.log('  - stream closed  ' + role + '/' + sid + '  viewers=' + room.viewers);
  };
  res.on('close', close);
  res.on('error', close);
  if (process.env.DEBUG_STREAMS) console.log('  + stream opened  ' + role + '/' + sid + '  viewers=' + room.viewers);
}

/* ------------------------------------------------------------------ server */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, '');

  // ---- API
  if (p === '/api/hello') {
    return json(res, 200, {
      ok: true, server: 'gonzales', classCode: roster.classCode,
      session: session.session, title: session.title,
    });
  }

  if (p === '/api/stream') {
    const room = getRoom(url.searchParams.get('room'));
    const role = url.searchParams.get('role') === 'student' ? 'student' : 'view';
    const sid = url.searchParams.get('sid') || '';
    return stream(req, res, room, sid, role);
  }

  if (p === '/api/periods') {
    /* What the "Before the bell" screen needs: every class code this machine
     * has ever run, and where each of them got to. */
    const out = store.list().map((code) => {
      const live = rooms.get(code);
      const d = live ? live.toJSON() : store.read(code);
      if (!d) return null;
      return {
        code: code,
        session: d.session,
        open: !!live,
        finished: !!(d.period && d.period.finished),
        segment: d.period ? d.period.idx : 0,
        priorSessions: (d.history || []).length,
        characters: (d.students || []).length,
        ledger: d.campaign ? d.campaign.ledger : null,
        standing: d.campaign ? d.campaign.standing : null,
        legacy: (d.students || []).reduce((a, s2) => a + (s2.legacy || 0), 0),
        savedAt: d.savedAt,
      };
    }).filter(Boolean);
    return json(res, 200, { ok: true, periods: out });
  }

  /* The client needs every place, because a student may walk into any of them
   * mid-turn and there is no time to fetch a map then. They are small. */
  /* THE DOCUMENTS.
   *
   * There is no paper any more, so the primary sources have to be reachable
   * from a Chromebook. They cannot simply be served as files: the static
   * handler is rooted at app/ and refuses anything outside it (correctly), and
   * handouts/ is a sibling of app/ where the teacher edits them.
   *
   * So they come through here, parsed into blocks the client renders by
   * building elements — never by assigning innerHTML. See server/handouts.js
   * for why that matters more than usual here. */
  /* THE PERSON CARD.
   *
   * What the historical record says about the person a student is playing, and
   * what it does not. Keyed by roster id rather than name so the client never
   * has to know about the name-matching heuristic in server/people.js.
   *
   * The deck's teacher-only sections are stripped there, before anything is
   * served. tools/check-people.mjs asserts it on every run. */
  if (p === '/api/person') {
    const id = String(url.searchParams.get('id') || '');
    const person = (roster.roster || []).filter((x) => x.id === id)[0];
    if (!person) return json(res, 404, { ok: false, error: 'no-such-character' });
    const card = people.forName(person.name, person.id);
    return json(res, 200, {
      ok: true,
      id: person.id,
      name: person.name,
      role: person.role,
      calling: person.calling,
      company: person.companyName,
      origin: person.origin,
      ability: person.ability,
      abilityBlurb: person.abilityBlurb,
      stats: person.stats,
      /* null when the deck has no card for them — five characters are in that
       * position, and saying so is better than inventing something */
      card: card ? { name: card.name, blocks: card.blocks } : null,
    });
  }

  if (p === '/api/handouts') {
    return json(res, 200, { ok: true, handouts: handouts.list() });
  }
  if (p === '/api/handout') {
    /* Exactly two digits. Not a path, not a name — an id that indexes a map
     * built at startup, so there is nothing here for a traversal to traverse. */
    const id = String(url.searchParams.get('id') || '');
    if (!/^\d\d$/.test(id)) return json(res, 400, { ok: false, error: 'bad-id' });
    const doc = handouts.get(id);
    if (!doc || id === '00') return json(res, 404, { ok: false, error: 'no-such-handout' });
    return json(res, 200, { ok: true, handout: doc });
  }

  if (p === '/api/maps') {
    return json(res, 200, { ok: true, maps: mapData });
  }

  if (p === '/api/roster') {
    const room = getRoom(url.searchParams.get('room'));
    return json(res, 200, { ok: true, roster: room.publicRoster(),
                            balance: room.balanceSummary(),
                            /* the figurine palette, and how many classmates
                             * already hold each colour, so the creation screen
                             * can steer without forbidding */
                            tints: Room.TINTS, tintsTaken: room.tintsTaken() });
  }

  if (p === '/api/join' && req.method === 'POST') {
    const b = await readBody(req);
    const room = getRoom(b.room);
    if (!b.sid || !b.characterId) return json(res, 400, { ok: false, error: 'bad-request' });
    /* tint is the figurine colour they picked on the way in. Validated inside
     * join() against Room.TINTS by index, so a hand-crafted request cannot put
     * an arbitrary colour — or an arbitrary string — on thirty screens. */
    return json(res, 200, room.join(b.sid, b.characterId, b.tint));
  }

  if (p === '/api/act' && req.method === 'POST') {
    const b = await readBody(req);
    const room = getRoom(b.room);
    room.ping(b.sid);
    let r;
    if (b.type === 'move') r = room.move(b.sid, b.hex);
    else if (b.type === 'act') r = room.perform(b.sid, b.actionId);
    else if (b.type === 'enter') r = room.enter(b.sid, b.featureId);
    else if (b.type === 'caughtUp') r = room.seenCatchUp(b.sid);
    else if (b.type === 'ping') r = { ok: true };
    else r = { ok: false, error: 'unknown' };
    if (r.ok) r.you = room.privateFor(b.sid);
    return json(res, 200, r);
  }

  if (p === '/api/cmd' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.key !== TEACHER_KEY) return json(res, 403, { ok: false, error: 'not-the-teacher' });
    const room = getRoom(b.room);
    return json(res, 200, room.command(b.type, b.payload));
  }

  /* WHERE THE STUDENTS ARE TOLD TO GO.
   *
   * `http://10.5.0.2:8099/play.html` is fourteen characters of ceremony after
   * the port, and every student who fumbles it needs the teacher — the exact
   * thing the autopilot exists to prevent. /p is the same page. */
  if (p === '/p' || p === '/play') {
    res.writeHead(302, { Location: '/play.html' + (url.search || '') });
    return res.end();
  }

  /* What to put on the projector while they arrive. */
  if (p === '/join') {
    res.writeHead(302, { Location: '/join.html' + (url.search || '') });
    return res.end();
  }

  /* Every address this machine answers on, worked out HERE — a browser cannot
   * see its own LAN address, and on a laptop with wifi, ethernet and a couple
   * of virtual adapters there is no way for a person to guess which one the
   * mini PC across the room can reach. So we print them all and say try them
   * in order. */
  if (p === '/api/where') {
    const rows = rankedAddresses();
    const ips = rows.map((r) => r.ip);
    /* The projector polls this. `confirmed` is the list of addresses a real
     * client has actually reached us on, so the moment the first student gets
     * in, the address in huge type and the QR code become a fact rather than a
     * ranked guess — and if the ranking was wrong, the screen corrects itself
     * in front of the class instead of staying wrong all period. */
    return json(res, 200, {
      ok: true,
      port: PORT,
      classCode: roster.classCode,
      student: ips.map((ip) => 'http://' + ip + ':' + PORT + '/p'),
      studentLong: ips.map((ip) => 'http://' + ip + ':' + PORT + '/play.html'),
      confirmed: ips.filter((ip) => confirmedAddrs.has(ip))
        .map((ip) => 'http://' + ip + ':' + PORT + '/p'),
      /* why each address ranked where it did, for the teacher's own screen */
      addresses: rows,
      teacher: 'http://localhost:' + PORT + '/?key=' + TEACHER_KEY,
      stage: 'http://localhost:' + PORT + '/stage.html',
      join: 'http://localhost:' + PORT + '/join',
    });
  }

  // ---- static
  let rel = decodeURIComponent(p);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(ROOT)) return send(res, 403, 'no');

  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, '404 ' + rel, { 'Content-Type': 'text/plain; charset=utf-8' });
    send(res, 200, buf, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = lanAddresses();
  const host = ips[0] || 'localhost';
  const line = (s) => console.log('  ' + s);
  console.log('');
  console.log('PAST & PERIL — classroom server');
  console.log('='.repeat(62));
  line('Session ' + session.session + ' — ' + session.title);
  line('Class code: ' + roster.classCode);
  console.log('');
  console.log('  YOU (bookmark this — the key is not on any student screen)');
  line('  http://localhost:' + PORT + '/?key=' + TEACHER_KEY);
  console.log('');
  console.log('  STUDENTS (write this on the board)');
  line('  http://' + host + ':' + PORT + '/p');
  if (ips.length > 1) {
    console.log('');
    line('  If that one does not work from another machine, this laptop also');
    line('  answers on these — try them in order:');
    ips.slice(1).forEach((ip) => line('    http://' + ip + ':' + PORT + '/p'));
  }
  console.log('');
  console.log('  PUT THIS ON THE PROJECTOR WHILE THEY ARRIVE');
  /* localhost only exists in a browser ON THIS MACHINE. If the projector is
   * driven by a different computer — and in a classroom it usually is — the
   * old single line sent the teacher to a page that could not load, with no
   * hint as to why. So name the machine, and give the address that works from
   * anywhere in the room. */
  line('  On THIS laptop:       http://localhost:' + PORT + '/join');
  if (ips[0]) line('  From another machine: http://' + ips[0] + ':' + PORT + '/join');
  line('  (the address in huge type, a QR code, and who has joined so far)');
  console.log('');
  console.log('  PROJECTOR, once the lesson starts');
  line('  On THIS laptop:       http://localhost:' + PORT + '/stage.html');
  if (ips[0]) line('  From another machine: http://' + ips[0] + ':' + PORT + '/stage.html');
  console.log('');
  console.log('  Nothing leaves this machine. No internet required.');
  console.log('');
  console.log('  FIRST TIME ON THIS LAPTOP: Windows will almost certainly block');
  console.log('  the port until you allow it. If another machine cannot connect,');
  console.log('  run this ONCE in an Administrator PowerShell:');
  console.log('');
  console.log('    New-NetFirewallRule -DisplayName "Past and Peril" `');
  console.log('      -Direction Inbound -Protocol TCP -LocalPort ' + PORT + ' -Action Allow');
  console.log('');
  console.log('  If students still cannot reach it, your network has client isolation');
  console.log('  turned on — ask IT to allow device-to-device on the student wifi.');
  console.log('');
});
