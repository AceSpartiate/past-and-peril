#!/usr/bin/env node
/* Exercise the HTTP handlers with real rooms and an in-memory store.
 * No classroom saves, credentials, ports, or browser sessions are touched. */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { createRequire } = require('module');
const { Room } = require('../server/room.js');

const filename = path.join(__dirname, '..', 'server', 'serve.js');
const localRequire = createRequire(filename);
const key = 'synthetic-server-test-key';
let handler;
const intervals = new Set();
const clone = (x) => JSON.parse(JSON.stringify(x));

class MemoryStore {
  constructor() { this.saved = new Map(); this.archived = new Map(); }
  read(code) { return this.saved.has(code) ? clone(this.saved.get(code)) : null; }
  list() { return Array.from(this.saved.keys()); }
  write(code, data) {
    if (this.failWrite) return false;
    this.saved.set(code, clone(data));
    return true;
  }
  archive(code) {
    if (this.failArchive) return { ok: false, error: 'disk-unavailable' };
    if (!this.saved.has(code)) return { ok: false, error: 'no-such-period' };
    this.archived.set(code, this.read(code));
    this.saved.delete(code);
    return { ok: true };
  }
}

const context = vm.createContext({
  __dirname: path.dirname(filename), URL, URLSearchParams, Buffer,
  console: { log() {}, error() {} },
  process: { env: { TEACHER_KEY: key }, on() {}, exit() { throw new Error('Unexpected exit'); } },
  setInterval(fn) { const timer = { fn, unref() {} }; intervals.add(timer); return timer; },
  clearInterval(timer) { intervals.delete(timer); },
  require(id) {
    if (id === 'http') return { createServer(fn) { handler = fn; return { listen() {} }; } };
    if (id === './store.js') return { Store: MemoryStore };
    if (id === './room.js') return { Room: class extends Room {
      constructor(...args) { args[6] = Object.assign({}, args[6], { manual: true }); super(...args); }
    } };
    return localRequire(id);
  },
});
vm.runInContext(fs.readFileSync(filename, 'utf8') +
  '\nglobalThis.test = { rooms, store, getRoom, saveAll };', context, { filename });
const state = context.test;

async function request(url, body) {
  const req = new EventEmitter();
  req.url = url;
  req.method = body === undefined ? 'GET' : 'POST';
  req.socket = { localAddress: '192.0.2.1' };
  req.destroy = () => {};
  const res = new EventEmitter();
  res.body = '';
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.write = (chunk) => { res.body += chunk; };
  res.end = (chunk) => { if (chunk) res.write(chunk); res.ended = true; res.emit('close'); };
  const pending = handler(req, res);
  if (body !== undefined) { req.emit('data', JSON.stringify(body)); req.emit('end'); }
  await pending;
  return res;
}

async function run() {
  const where = await request('/api/where');
  assert.equal(where.status, 200);
  const discovery = JSON.parse(where.body);
  assert.equal(Object.hasOwn(discovery, 'teacher'), false);
  assert.equal(where.body.includes(key), false);
  assert.ok(discovery.student.length && discovery.classCode);
  assert.equal((await request('/api/cmd', { key: 'wrong', room: 'P3', type: 'open' })).status, 403);
  assert.equal((await request('/api/archive', { room: 'P3', confirm: 'P3' })).status, 403);
  assert.equal((await request('/api/cmd', { key, room: 'P3', type: 'open' })).status, 200);
  assert.equal(JSON.parse((await request('/api/where')).body).classCode, 'P3');
  assert.equal((await request('/p')).headers.Location, '/play.html?room=P3');
  assert.equal((await request('/stage.html')).headers.Location, '/stage.html?room=P3');
  console.log('  ok  discovery keeps the key private; teacher commands and class routing work');

  await request('/api/join', { room: 'P3', sid: 'student', characterId: 'p01' });
  const room = state.rooms.get('P3');
  room.students.student.legacy = 17;
  const stream = await request('/api/stream?room=P3&role=view');
  const timerCount = intervals.size;
  assert.ok(room._saveTimer, 'A save is pending before archive');
  assert.equal((await request('/api/archive', { key, room: 'P3', confirm: 'P4' })).status, 400);
  assert.equal(state.rooms.get('P3'), room);

  state.store.failWrite = true;
  assert.equal((await request('/api/archive', { key, room: 'P3', confirm: 'P3' })).status, 500);
  assert.equal(state.rooms.get('P3'), room);
  assert.equal(stream.ended, undefined);
  state.store.failWrite = false;
  state.store.failArchive = true;
  assert.equal((await request('/api/archive', { key, room: 'P3', confirm: 'P3' })).status, 500);
  assert.equal(state.rooms.get('P3'), room);
  assert.equal(typeof room.saver, 'function');
  state.store.failArchive = false;

  assert.equal((await request('/api/archive', { key, room: 'P3', confirm: 'P3' })).status, 200);
  assert.equal(state.store.archived.get('P3').students[0].legacy, 17);
  assert.equal(state.rooms.has('P3'), false);
  assert.equal(state.store.saved.has('P3'), false);
  assert.equal(room._saveTimer, null);
  assert.equal(room.saver, null);
  assert.equal(stream.ended, true);
  assert.equal(room.viewers, 0);
  assert.equal(intervals.size, timerCount - 1, 'Old stream heartbeat is stopped');
  state.saveAll();
  assert.equal(state.store.saved.has('P3'), false);
  console.log('  ok  archive preserves the latest progress and stops old saves and streams');
  console.log('  ok  failed archive/write leaves the live class intact');

  await request('/api/join', { room: 'P3', sid: 'replacement', characterId: 'p01' });
  assert.notEqual(state.rooms.get('P3'), room);
  assert.equal(state.rooms.get('P3').students.replacement.legacy, 0);
  console.log('  ok  reusing an archived class code starts a fresh campaign');
}

run().then(() => console.log('\n  Server access and archive checks passed.'))
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => { state.rooms.forEach((room) => room.destroy()); });
