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
/* The build number, read once. Shown in the corner of the console so a
 * teacher with three machines can tell which of them has been updated. */
const VERSION = (() => {
  try { return fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim(); }
  catch (e) { return ''; }
})();
/* Every scene on disk, in session then scene order. This was a hand-kept
 * list of ten, so a new scene file was loaded by nothing and failed
 * silently. Sorted numerically, so scene 10 never lands before scene 2. */
const SCENE_FILES = fs.readdirSync(path.join(ROOT, 'content'))
  .filter((f) => f.indexOf('scene-s') === 0 && f.slice(-5) === '.json')
  .map((f) => f.slice(0, -5))
  .sort((a, b) => {
    const pa = a.split('-'), pb = b.split('-');
    return (Number(pa[1].slice(1)) - Number(pb[1].slice(1))) ||
           (Number(pa[2]) - Number(pb[2]));
  });
const sceneData = SCENE_FILES.map((f) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'content', f + '.json'), 'utf8')));
const factsData = JSON.parse(fs.readFileSync(path.join(ROOT, 'content/facts-s1.json'), 'utf8'));
const commonData = JSON.parse(fs.readFileSync(path.join(ROOT, 'content/actions-common.json'), 'utf8'));

/* One Room per class code. Five periods a day = five rooms, each with its own
 * campaign, exactly as design/09 wanted from a Durable Object per period. */
/* An isolated data directory lets checks run without opening saved classes. */
const store = new Store(process.env.PAST_PERIL_DATA_DIR || path.join(__dirname, '..', 'data'));
const rooms = new Map();
const roomStreams = new WeakMap();

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

/* ===========================================================================
 * WHICH ROOM IS THE CLASS IN?
 *
 * A teacher runs five periods a day and each is its own Room with its own
 * saved campaign. That has always worked on the server. It did NOT work for
 * the students:
 *
 *   the address on the board is http://<ip>:8099/p
 *   /p redirected to /play.html with no room
 *   app/js/net.js defaults to GN7B when no room is given
 *
 * So a teacher could open period 7C, press start, and have all thirty students
 * land in GN7B. Measured, not theorised: teacher in 7C, student in GN7B, two
 * live rooms, nobody in the one being taught. The desk would have said
 * "0 connected" all period with no hint as to why.
 *
 * So the server now knows which room is being taught, and /p sends students
 * there. The address on the board stays short and stays the same all year —
 * the redirect does the work, which also means the QR code on the projector
 * never has to change between periods. */
let activeRoom = null;

function normaliseRoom(code) {
  return String(code || '').toUpperCase().slice(0, 12) || null;
}

/* On a restart mid-day, the most recently saved period is overwhelmingly the
 * one being taught. Better than defaulting to GN7B and silently splitting the
 * class in half. */
function initialActiveRoom() {
  try {
    const codes = store.list();
    let best = null, bestAt = -1;
    codes.forEach((c) => {
      const d = store.read(c);
      /* epoch ms from the store, not an ISO string — see whenSaved in
       * app/js/console.js, where assuming otherwise showed nothing at all */
      const raw = d && d.savedAt;
      const at = typeof raw === 'number' ? raw : (Date.parse(raw || 0) || 0);
      if (at > bestAt) { bestAt = at; best = c; }
    });
    if (best) return normaliseRoom(best);
  } catch (e) {}
  return normaliseRoom(roster.classCode) || 'GN7B';
}
activeRoom = initialActiveRoom();

function currentRoom() { return activeRoom || normaliseRoom(roster.classCode) || 'GN7B'; }

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
    connections.delete(end);
    clearInterval(beat);
    off();
    if (role === 'student' && sid) room.leave(sid);
    if (process.env.DEBUG_STREAMS) console.log('  - stream closed  ' + role + '/' + sid + '  viewers=' + room.viewers);
  };
  let connections = roomStreams.get(room);
  if (!connections) { connections = new Set(); roomStreams.set(room, connections); }
  const end = () => { close(); res.end(); };
  connections.add(end);
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
      /* Which build is this? A teacher who has just updated one of three
       * machines has no way to tell them apart, and "am I looking at the new
       * one" is not a question the software should leave them guessing at. */
      version: VERSION,
    });
  }

  if (p === '/api/stream') {
    const room = getRoom(url.searchParams.get('room'));
    const role = url.searchParams.get('role') === 'student' ? 'student' : 'view';
    const sid = url.searchParams.get('sid') || '';
    return stream(req, res, room, sid, role);
  }

  /* START A CLASS OVER. Archives rather than deletes — see Store#archive.
   *
   * Teacher-keyed, and it requires the class code to be sent twice: once as the
   * room and once as a typed confirmation. A term of a class's work should not
   * be one stray click from gone, and the second field is what the teacher
   * types to show they meant this class and not the one above it. */
  if (p === '/api/archive' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.key !== TEACHER_KEY) return json(res, 403, { ok: false, error: 'not-the-teacher' });
    const code = normaliseRoom(b.room);
    if (!code) return json(res, 400, { ok: false, error: 'no-room' });
    if (normaliseRoom(b.confirm) !== code) {
      return json(res, 400, { ok: false, error: 'confirm-mismatch' });
    }
    /* Archive the latest progress, then stop every writer and old stream.
     * A failed write or rename leaves the live class available to the teacher. */
    const live = rooms.get(code);
    if (live && !store.write(code, live.toJSON())) {
      return json(res, 500, { ok: false, error: 'save-failed' });
    }
    const r = store.archive(code);
    if (r.ok) {
      if (live) {
        live.destroy();
        rooms.delete(code);
        const connections = roomStreams.get(live);
        if (connections) Array.from(connections).forEach((end) => end());
        roomStreams.delete(live);
      }
      if (activeRoom === code) activeRoom = initialActiveRoom();
    }
    return json(res, r.ok ? 200 : r.error === 'no-such-period' ? 404 : 500, r);
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
        rehearsal: !!((d.campaign && d.campaign.wasTestMode) || (live && live.testMode)),
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
    else if (b.type === 'vote') r = room.vote(b.sid, b.key === null ? null : b.key);
    else if (b.type === 'ping') r = { ok: true };
    else r = { ok: false, error: 'unknown' };
    if (r.ok) r.you = room.privateFor(b.sid);
    return json(res, 200, r);
  }

  if (p === '/api/cmd' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.key !== TEACHER_KEY) return json(res, 403, { ok: false, error: 'not-the-teacher' });
    /* The teacher touching a room is what makes it the one being taught. No
     * separate "open this room" step to forget — pressing anything on the desk
     * points the students' short URL at it. */
    if (b.room) activeRoom = normaliseRoom(b.room);
    const room = getRoom(b.room);
    return json(res, 200, room.command(b.type, b.payload));
  }

  /* WHERE THE STUDENTS ARE TOLD TO GO.
   *
   * `http://10.5.0.2:8099/play.html` is fourteen characters of ceremony after
   * the port, and every student who fumbles it needs the teacher — the exact
   * thing the autopilot exists to prevent. /p is the same page. */
  if (p === '/p' || p === '/play') {
    /* Add the room the teacher is actually teaching, unless the URL already
     * names one. This is why the address on the board never has to change
     * between periods, and why the projector's QR code stays valid all year. */
    const q = new URLSearchParams(url.search);
    if (!q.get('room')) q.set('room', currentRoom());
    res.writeHead(302, { Location: '/play.html?' + q.toString() });
    return res.end();
  }

  /* A projector opened from the startup banner follows the selected class. */
  if (p === '/stage.html' && !url.searchParams.get('room')) {
    const q = new URLSearchParams(url.search);
    q.set('room', currentRoom());
    res.writeHead(302, { Location: '/stage.html?' + q.toString() });
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
      classCode: currentRoom(),
      student: ips.map((ip) => 'http://' + ip + ':' + PORT + '/p'),
      studentLong: ips.map((ip) => 'http://' + ip + ':' + PORT + '/play.html'),
      confirmed: ips.filter((ip) => confirmedAddrs.has(ip))
        .map((ip) => 'http://' + ip + ':' + PORT + '/p'),
      /* why each address ranked where it did, for the teacher's own screen */
      addresses: rows,
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
