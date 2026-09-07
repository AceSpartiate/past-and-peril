#!/usr/bin/env node
/* Screen regressions without a running classroom, saved students, or a browser.
 * The real client scripts run against a small DOM, controlled clock, and media
 * promises that can finish after the teacher has already paused or moved on. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
let checks = 0;
function equal(actual, expected, why) { assert.deepEqual(actual, expected, why); checks += 1; }
function ok(actual, why) { assert.ok(actual, why); checks += 1; }
async function settle() { for (let i = 0; i < 12; i += 1) await Promise.resolve(); }
function run(context, file) { vm.runInContext(read(file), context, { filename: file }); }

function element(tag = 'div') {
  const events = {}, classes = new Set();
  return {
    tagName: tag.toUpperCase(), style: {}, children: [], hidden: false,
    classList: {
      toggle(name, value) {
        const on = value === undefined ? !classes.has(name) : value;
        if (on) classes.add(name); else classes.delete(name);
      },
    },
    addEventListener(type, fn) { (events[type] ||= []).push(fn); },
    click() { (events.click || []).forEach((fn) => fn.call(this, { target: this })); },
    appendChild(child) { this.children.push(child); },
    querySelector(selector) { return this.children.find((child) => child.tagName === selector.toUpperCase()) || null; },
  };
}

async function routing(search, expectedRoom, expectedKey) {
  const nodes = {}, calls = [];
  const html = read('app/index.html');
  const links = [...html.matchAll(/<a\b[^>]*data-stage-link[^>]*>/g)].map(() => element('a'));
  equal(links.length, 2, 'Both projector links participate in room routing');
  const response = (value) => Promise.resolve({ ok: true, json: () => Promise.resolve(value) });
  const context = vm.createContext({
    console, URLSearchParams, location: { search },
    localStorage: { getItem: () => 'test-device' },
    document: {
      body: element('body'),
      getElementById: (id) => (nodes[id] ||= element()),
      querySelector: () => element(),
      querySelectorAll: () => links,
      createElement: element, addEventListener() {},
    },
    window: { addEventListener() {} }, setTimeout() {},
    Narrator: { describe: () => 'test voice', stop() {}, say() {}, setMuted() {} },
    EventSource: function (url) { calls.push({ stream: url }); },
    fetch(url, opts) {
      if (opts && opts.method === 'POST') {
        calls.push({ url, body: JSON.parse(opts.body) });
        return response({ ok: true });
      }
      if (url === 'content/session-1.json') return response(JSON.parse(read('app/content/session-1.json')));
      if (url === 'api/periods') return response({ periods: [] });
      if (url === 'api/where') return response({ ok: true, student: ['http://classroom/p'] });
      return response({ ok: true });
    },
  });
  run(context, 'app/js/net.js');
  run(context, 'app/js/console.js');
  await settle();
  ok(calls[0].stream.includes('room=' + expectedRoom), 'Connect initializes the selected room before any command');
  const opens = calls.filter((call) => call.body && call.body.type === 'open');
  if (expectedKey) {
    equal(opens.map((call) => [call.body.room, call.body.key]), [[expectedRoom, expectedKey]],
      'Opening the console sends its actual room and teacher key');
    ok(!nodes.preflight.innerHTML.includes('NO KEY'), 'The first preflight already recognizes the teacher key');
    ok(nodes.preflight.innerHTML.includes('Class ' + expectedRoom), 'Preflight names the selected class, not the content default');
  } else {
    equal(opens.length, 0, 'A console without a key does not send an unauthorized open command');
  }
  equal(links.map((link) => link.href), Array(2).fill('stage.html?room=' + expectedRoom),
    'Both separate projector windows retain the selected room');
  nodes['b-stage-inline'].click();
  equal(nodes['stage-inline'].children[0].src, 'stage.html?room=' + expectedRoom,
    'The inline projector retains the selected room without forwarding the teacher key');
}

function cinema() {
  let now = 0, nextFrame = 0;
  const pending = new Map(), images = new Map(), draws = [], nodes = {}, events = {};
  const ctx = new Proxy({
    measureText: (text) => ({ width: text.length * 6 }),
    drawImage: (img, sx, sy, sw, sh) => draws.push({ src: img.src, crop: [sx, sy, sw, sh] }),
  }, { get: (target, key) => key in target ? target[key] : () => {} });
  const canvas = Object.assign(element('canvas'), {
    getContext: () => ctx,
    getBoundingClientRect: () => ({ width: 640, height: 360 }),
  });
  nodes.kb = canvas;
  const voice = { text: null, paused: false, starts: [] };
  const narrator = {
    say(line) { voice.text = line && line.text; voice.paused = false; voice.starts.push(voice.text); },
    stop() { voice.text = null; voice.paused = false; },
    pause() { voice.paused = true; },
    resume() { voice.paused = false; },
  };
  const context = vm.createContext({
    console, performance: { now: () => now },
    window: { devicePixelRatio: 1, addEventListener() {} },
    document: { getElementById: (id) => (nodes[id] ||= element()), createElement: element },
    Image: function () {
      this.naturalWidth = 1000; this.naturalHeight = 600;
      Object.defineProperty(this, 'src', { get: () => this.url, set: (url) => { this.url = url; images.set(url, this); } });
    },
    requestAnimationFrame(fn) { const id = ++nextFrame; pending.set(id, fn); return id; },
    cancelAnimationFrame(id) { pending.delete(id); },
    fetch: () => new Promise(() => {}), setTimeout() {}, Narrator: narrator,
    Net: { on: (type, fn) => { events[type] = fn; }, probe: () => new Promise(() => {}) },
  });
  run(context, 'app/js/kenburns.js');
  return {
    context, canvas, nodes, images, draws, events, voice, pending,
    advance(ms) {
      now += ms;
      const frames = [...pending.values()]; pending.clear();
      frames.forEach((fn) => fn(now));
    },
  };
}

const shots = [
  { image: 'one.png', move: 'PUSH', from: [.5, .5, 1], to: [.5, .5, .5], voice: { text: 'First shot.' } },
  { image: 'two.png', move: 'PUSH', from: [.5, .5, 1], to: [.5, .5, .5], voice: { text: 'Second shot.' } },
];

async function playerChecks() {
  const h = cinema(), selections = [];
  h.context.canvas = h.canvas;
  const player = vm.runInContext('KenBurns.Player(canvas)', h.context);
  player.play(shots, 10000, (shot) => selections.push(shot.image), { elapsed: 6500, running: true });
  equal(selections, ['two.png'], 'A projector joining midsequence seeks directly to the correct shot');
  h.images.get('images/two.png').onload(); await settle();
  player.sync(6500, 10000, false);
  const pausedCrop = h.draws.at(-1).crop.slice();
  equal(h.pending.size, 0, 'Pausing cancels scheduled animation frames');
  h.advance(5000); player.resize();
  equal(h.draws.at(-1).crop, pausedCrop, 'A paused resize preserves the exact crop after wall time passes');
  player.sync(6500, 10000, true); h.advance(1000);
  ok(h.draws.at(-1).crop[2] < pausedCrop[2], 'Resume continues the crop from authoritative elapsed time');
  player.sync(1000, 10000, false);
  equal(selections, ['two.png', 'one.png'], 'Seeking backward changes shots immediately');
  h.images.get('images/one.png').onload(); await settle();
  equal(h.draws.at(-1).src, 'images/one.png', 'The sought shot is rendered');
  const before = selections.length;
  player.play(shots, 10000, (shot) => selections.push(shot.image), { elapsed: 1000, running: false });
  equal(selections.length, before + 1, 'Replay announces the shot again even at an identical elapsed time');
  await settle();

  const race = cinema(); race.context.canvas = race.canvas;
  const delayed = vm.runInContext('KenBurns.Player(canvas)', race.context);
  delayed.play(shots, 10000, null, { elapsed: 0, running: false });
  delayed.sync(6000, 10000, false);
  race.images.get('images/two.png').onload(); await settle();
  race.images.get('images/one.png').onload(); await settle();
  equal(race.draws.at(-1).src, 'images/two.png', 'A slow image from the previous shot cannot replace the current image');
  const stopped = cinema(); stopped.context.canvas = stopped.canvas;
  const abandoned = vm.runInContext('KenBurns.Player(canvas)', stopped.context);
  abandoned.play(shots, 10000); abandoned.stop();
  stopped.images.get('images/one.png').onload(); await settle();
  equal(stopped.draws.length, 0, 'An image arriving after Stop cannot resurrect a sequence');
}

function stageChecks() {
  const h = cinema(); run(h.context, 'app/js/stage.js');
  const state = {
    started: true, running: true, sessionIndex: 0, segmentRevision: 1,
    clocks: {}, ledger: {}, elapsed: 6.5, length: 10,
    segment: { id: 'cold_open', kind: 'sequence', shots },
  };
  h.events.state(state);
  equal(h.nodes['seq-caption'].textContent, 'Second shot.', 'The real Stage displays the correct late-join caption');
  equal(h.voice.text, 'Second shot.', 'Late-join narration matches the displayed shot');
  h.events.state({ ...state, running: false });
  equal(h.voice.paused, true, 'Teacher Pause also pauses projector narration');
  equal(h.pending.size, 0, 'Teacher Pause reaches the actual canvas player');
  h.advance(20000);
  equal(h.nodes['seq-caption'].textContent, 'Second shot.', 'A paused sequence does not advance captions');
  h.events.state(state);
  equal(h.voice.paused, false, 'Teacher Resume resumes narration');
  equal(h.voice.starts.length, 1, 'Resume does not restart the spoken line');
  h.events.state({ ...state, segmentRevision: 2, elapsed: 0 });
  equal(h.nodes['seq-caption'].textContent, 'First shot.', 'Replay of the same segment returns to its first shot');
  h.events.state({ ...state, segmentRevision: 3, elapsed: 0 });
  equal(h.voice.starts.length, 3, 'An immediate second Replay is distinguishable even before the clock advances');
  h.events.state({ ...state, segmentRevision: 3, elapsed: 6, manualRead: true });
  equal(h.voice.text, null, 'Teacher reading mode suppresses narration even when the shot changes');
  h.events.online(false);
  equal(h.pending.size, 0, 'A disconnected Stage freezes animation until a fresh state arrives');
  h.events.state({ ...state, segmentRevision: 3, elapsed: 8 });
  equal(h.nodes['seq-caption'].textContent, 'Second shot.', 'Reconnection seeks to the current classroom shot');
  equal(h.voice.text, 'Second shot.', 'Reconnection uses current narration settings');

  const paused = cinema(); run(paused.context, 'app/js/stage.js');
  paused.events.state({ ...state, running: false });
  equal(paused.voice.starts.length, 0, 'Opening a paused classroom does not start narration');
  paused.events.state(state);
  equal(paused.voice.starts, ['Second shot.'], 'Resuming a classroom opened while paused starts the current line');
  const readState = { ...state, segmentRevision: 4, segment: { id: 'read', kind: 'read', voice: { text: 'Read again.' } } };
  paused.events.state(readState);
  paused.events.state({ ...readState, segmentRevision: 5 });
  equal(paused.voice.starts.slice(-2), ['Read again.', 'Read again.'], 'Replay also repeats a read segment');
}

async function audioChecks() {
  const clips = [], spoken = [];
  const synth = {
    paused: false, getVoices: () => [], addEventListener() {}, cancel() {},
    pause() { this.paused = true; }, resume() { this.paused = false; },
    speak(line) { spoken.push(line.text); },
  };
  const context = vm.createContext({
    console, window: { speechSynthesis: synth }, fetch: () => new Promise(() => {}),
    SpeechSynthesisUtterance: function (text) { this.text = text; },
    Audio: function (src) {
      this.src = src; this.currentTime = 0; this.playing = false; this.events = {}; this.requests = [];
      this.addEventListener = (type, fn) => { this.events[type] = fn; };
      this.pause = () => { this.playing = false; };
      this.play = () => new Promise((resolve, reject) => {
        this.requests.push({ resolve: () => { this.playing = true; resolve(); }, reject });
      });
      clips.push(this);
    },
  });
  run(context, 'app/js/audio.js');
  const narrator = vm.runInContext('Narrator', context);
  narrator.say({ text: 'Loading line.' });
  narrator.pause(); clips[0].requests[0].resolve(); await settle();
  equal(clips[0].playing, false, 'Pause also stops an audio play promise that resolves late');
  clips[0].currentTime = 4;
  narrator.resume(); clips[0].requests[1].resolve(); await settle();
  equal([clips[0].playing, clips[0].currentTime], [true, 4], 'Recorded narration resumes at its retained position');
  narrator.say({ text: 'Replacement line.' });
  clips[0].events.error(); await settle();
  equal(spoken.length, 0, 'A failed old clip cannot interrupt a newer line with speech fallback');
  narrator.stop(); clips[1].requests[0].resolve(); await settle();
  equal(clips[1].playing, false, 'Stop invalidates pending playback before it can speak later');
  clips[1].events.error(); await settle();
  equal(spoken.length, 0, 'A stopped clip cannot revive itself through its error callback');
  narrator.say({ text: 'Browser fallback.' }); clips[2].events.error();
  equal(spoken, ['Browser fallback.'], 'The current failed recording still falls back to browser speech');
  narrator.pause(); equal(synth.paused, true, 'Pause reaches browser speech as well as recordings');
  narrator.resume(); equal(synth.paused, false, 'Resume reaches browser speech');
}

(async function () {
  await routing('?room=P3&key=screen-test-key', 'P3', 'screen-test-key');
  await routing('?room=P4', 'P4', null);
  await playerChecks();
  stageChecks();
  await audioChecks();
  console.log('SCREENS — ' + checks + ' assertions passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
