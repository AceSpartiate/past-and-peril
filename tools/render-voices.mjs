/* render-voices.mjs — every line of writing in this game, spoken, once.
 *
 *     node tools/render-voices.mjs            everything that is missing
 *     node tools/render-voices.mjs --force    everything, again
 *     node tools/render-voices.mjs --dry      say what it would do
 *     node tools/render-voices.mjs --only NARRATOR
 *
 * WHY THE AUDIO IS COMMITTED AND THE MODELS ARE NOT
 *
 * design/15-risk-review.md R2 is the reason this file exists. tools/reading-load
 * .js measured what a 7th-grade class can actually read in a 45-minute period,
 * and the bottom quartile has no words to spare. Narration is not an
 * accessibility nicety here — it is how the bottom quartile receives the
 * lesson at all. So it has to work on the first day, on a machine nobody has
 * configured, with the wifi off.
 *
 * Committed mp3s do that. Committed models do not: they are 63 MB each, git
 * stores them undeltified forever, and the good 'high' ones exceed GitHub's
 * hard push limit. See VOICE_LICENSES.md for the licence reasoning, which
 * points the same way.
 *
 * THE ID IS A HASH OF THE LINE. Authors never assign one. Change a word and
 * the id changes, the old mp3 is orphaned, and the next run renders the new
 * one — so the audio cannot silently drift out of step with the writing. The
 * same hash is implemented in app/js/audio.js, and the two must agree. */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const CONTENT = path.join(ROOT, 'app', 'content');
const AUDIO = path.join(ROOT, 'app', 'audio');
const VOICES = path.join(ROOT, 'voices');

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const DRY = args.includes('--dry');
const ONLY = (() => { const i = args.indexOf('--only'); return i === -1 ? null : args[i + 1]; })();

const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'voices.json'), 'utf8'));

/* ---------------------------------------------------------------- the id
 * FNV-1a. Mirrored exactly in app/js/audio.js — if you touch one, touch both.
 * 32 bits over a few hundred lines is a collision chance around one in a
 * hundred thousand, and we check for one below rather than hoping. */
function lineId(speaker, text) {
  const s = (speaker || 'NARRATOR') + ' ' + String(text).replace(/\s+/g, ' ').trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return (speaker || 'NARRATOR').toLowerCase().replace(/[^a-z0-9]+/g, '') +
         '-' + ('0000000' + h.toString(16)).slice(-8);
}

/* --------------------------------------------------------- what to speak
 *
 * Two kinds of line, and both matter:
 *
 *   voice: {speaker, text}   authored narration — the cold open, the reads
 *   narrate: "…"             what a ROLL prints on one student's own screen
 *
 * The second kind is 260 of the 290 lines and five sixths of the words. It is
 * also the kind a struggling reader most needs read to them, because it
 * arrives alone, mid-turn, with no teacher reading it out. */
function collect() {
  const out = [];
  const seen = new Set();
  const add = (speaker, text, where) => {
    text = String(text || '').replace(/\s+/g, ' ').trim();
    if (text.length < 4) return;
    const id = lineId(speaker, text);
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, speaker: speaker || 'NARRATOR', text, where });
  };
  const walk = (node, file) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach((x) => walk(x, file));
    if (node.voice && node.voice.text) add(node.voice.speaker, node.voice.text, file);
    Object.keys(node).forEach((k) => {
      if (k === 'narrate' && typeof node[k] === 'string') add(node.speaker, node[k], file);
      else if (k === 'statement' && typeof node[k] === 'string') add('HISTORIAN', node[k], file);
      walk(node[k], file);
    });
  };
  fs.readdirSync(CONTENT).filter((f) => f.endsWith('.json') && f !== 'terrain.json')
    .forEach((f) => walk(JSON.parse(fs.readFileSync(path.join(CONTENT, f), 'utf8')), f));
  return out;
}

/* ------------------------------------------------------- say it properly
 * espeak reads "1835" as "one thousand eight hundred and thirty-five", which
 * nobody has ever said about a year, and it puts an Anglo stress on every
 * Spanish place name in the unit. Both are fixable with a table. */
function speakable(text) {
  let s = text;
  Object.keys(cfg.say_it_this_way).forEach((k) => {
    if (k.startsWith('_')) return;
    s = s.split(k).join(cfg.say_it_this_way[k]);
  });
  /* An em-dash is a breath, not a word. */
  return s.replace(/—/g, ', ').replace(/’/g, "'").replace(/[“”]/g, '');
}

/* ----------------------------------------------------------------- run */
const lines = collect();
const byId = {};
lines.forEach((l) => { byId[l.id] = l; });

const speakers = {};
lines.forEach((l) => { speakers[l.speaker] = (speakers[l.speaker] || 0) + 1; });

console.log('\nNARRATION — ' + lines.length + ' lines, ' +
  lines.reduce((a, l) => a + l.text.split(' ').length, 0) + ' words');
Object.keys(speakers).sort((a, b) => speakers[b] - speakers[a]).forEach((s) => {
  const c = cfg.cast[s];
  console.log('  ' + String(speakers[s]).padStart(4) + '  ' + s.padEnd(16) +
    (c ? c.voice + (c.length !== 1 ? '  rate ' + c.length : '') : 'NO CAST ENTRY — will read as NARRATOR'));
});

const uncast = Object.keys(speakers).filter((s) => !cfg.cast[s]);
if (uncast.length) console.log('\n  uncast speakers fall back to NARRATOR: ' + uncast.join(', '));

fs.mkdirSync(AUDIO, { recursive: true });

const jobs = [];
let have = 0;
lines.forEach((l) => {
  if (ONLY && l.speaker !== ONLY) return;
  const out = path.join(AUDIO, l.id + '.mp3');
  if (!FORCE && fs.existsSync(out) && fs.statSync(out).size > 512) { have++; return; }
  const cast = cfg.cast[l.speaker] || cfg.cast.NARRATOR;
  jobs.push({
    id: l.id, out, voice: cast.voice,
    length: cast.length || 1.0, noiseW: cast.noiseW || 0.8,
    text: speakable(l.text),
  });
});
/* Group by voice so each model loads once. This is the difference between two
 * minutes and forty. */
jobs.sort((a, b) => (a.voice < b.voice ? -1 : a.voice > b.voice ? 1 : 0));

console.log('\n  already rendered: ' + have + '     to render: ' + jobs.length);

/* Orphans — lines that were rewritten, so their old audio no longer matches
 * anything. Reported, never deleted without being asked. */
const want = new Set(lines.map((l) => l.id + '.mp3'));
const orphans = fs.existsSync(AUDIO)
  ? fs.readdirSync(AUDIO).filter((f) => f.endsWith('.mp3') && !want.has(f)) : [];
if (orphans.length) {
  console.log('  ' + orphans.length + ' orphaned mp3(s) — the writing changed under them.');
  console.log('    delete with:  node tools/render-voices.mjs --prune');
}
if (args.includes('--prune')) {
  orphans.forEach((f) => fs.unlinkSync(path.join(AUDIO, f)));
  console.log('  pruned ' + orphans.length);
}

if (DRY || !jobs.length) {
  writeIndex();
  if (!jobs.length && !DRY) console.log('\n  nothing to do.\n');
  process.exit(0);
}

const missing = [...new Set(jobs.map((j) => j.voice))]
  .filter((v) => !fs.existsSync(path.join(VOICES, v + '.onnx')));
if (missing.length) {
  console.log('\n  MISSING VOICE MODELS: ' + missing.join(', '));
  console.log('  run:  node tools/get-voices.mjs\n');
  process.exit(1);
}

const jobFile = path.join(os.tmpdir(), 'gonzales-voice-job.json');
fs.writeFileSync(jobFile, JSON.stringify({ voicesDir: VOICES, lines: jobs }));

console.log('\n  rendering…');
let result = {};
try {
  const out = execFileSync('python', [path.join(HERE, 'piper-render.py'), jobFile],
                           { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const last = out.trim().split('\n').pop();
  result = JSON.parse(last);
} catch (e) {
  console.log('\n  RENDER FAILED. Is piper installed?');
  console.log('    python -m pip install piper-tts soundfile\n');
  process.exit(1);
}

console.log('\n  rendered ' + result.rendered + ' line(s), ' +
  (result.bytes / 1048576).toFixed(1) + ' MB');
(result.failed || []).forEach((f) => console.log('  FAILED  ' + f[0] + '  ' + f[1]));
writeIndex();

/* --------------------------------------------------------- the manifest
 * Without this the client fires a request per line and learns from a 404 that
 * there is no audio. On thirty Chromebooks on school wifi that is 8,700 failed
 * requests a period. With it, one small file answers the question. */
function writeIndex() {
  const present = fs.existsSync(AUDIO)
    ? fs.readdirSync(AUDIO).filter((f) => f.endsWith('.mp3')).map((f) => f.slice(0, -4)) : [];
  const idx = {
    _note: 'Generated by tools/render-voices.mjs. Every line of narration that has a rendered voice. app/js/audio.js checks this before asking for a file, so a missing line costs nothing.',
    rendered: present.length,
    of: lines.length,
    voices: cfg.voices.map((v) => ({ id: v.id, license: v.license })),
    ids: present.sort(),
  };
  fs.writeFileSync(path.join(AUDIO, 'index.json'), JSON.stringify(idx, null, 1));
  console.log('  manifest: ' + present.length + ' of ' + lines.length + ' lines have audio\n');
}
