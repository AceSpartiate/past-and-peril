/* start.mjs — THE WHOLE START PROCEDURE.
 *
 * START-CLASS.cmd is deliberately thin: it finds a Node and runs this. Every
 * decision lives here, in JavaScript, where it can be written carefully and
 * read later.
 *
 * WHAT THIS IS FOR
 *
 * A teacher who is handed this folder must be able to double-click one thing
 * and teach. Not install a runtime, not read a README, not open a terminal,
 * not answer a question they have no way to answer. Everything below exists
 * because one of those was about to be required of them.
 *
 * THE ORDER, AND WHY
 *
 *   1. already running?   Double-clicking twice is the single most likely
 *                         mistake. Starting a SECOND server on a second port
 *                         is the worst possible response: half the class ends
 *                         up in a different room. So we detect our own server
 *                         and just open the desk again.
 *   2. update            Never blocking, never fatal, never mid-lesson.
 *   3. preflight         The existing checks, unchanged.
 *   4. port              8099, or the next free one — a busy port is not a
 *                        reason to cancel a lesson.
 *   5. the server        Spawned, with its output passed straight through so
 *                        the banner still reads the way it was written.
 *   6. the desk          Opened AFTER the server answers, so the teacher key
 *                        is read from disk rather than guessed. The old
 *                        launcher hardcoded `?key=devkey`; on any machine
 *                        where that file did not exist, the server generated a
 *                        random key and the teacher was locked out of their
 *                        own console on the first run.
 *   7. a crash           Captured, scrubbed, and turned into something one
 *                        click can send.
 *
 * Nothing here may ever stop a lesson because of a network, a filter, or a
 * missing optional file. Read every catch block in that light. */

import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BASE_PORT = Number(process.env.PORT || 8099);

const say = (s) => console.log(s === undefined ? '' : '  ' + s);
const rule = () => console.log('  ' + '-'.repeat(62));

/* The .cmd sets code page 65001 before it gets here, which is what keeps the
 * em dashes and middle dots in the banner from turning into mojibake in a
 * Windows console. There is nothing to do at this level. */

/* ------------------------------------------------------------------ version */
function version() {
  try { return fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim() || '0.0.0'; }
  catch (e) { return '0.0.0'; }
}

/* ------------------------------------------------------- is a port answering */
function portFree(port) {
  return new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.once('listening', () => s.close(() => res(true)));
    s.listen(port, '0.0.0.0');
  });
}

/* Is the thing on that port OUR server, or something else entirely? A school
 * machine may well have something on a high port. We only recognise ourselves
 * by a field only we serve. */
async function oursOn(port) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1500);
    const r = await fetch('http://127.0.0.1:' + port + '/api/hello',
      { signal: ac.signal, cache: 'no-store' });
    clearTimeout(t);
    if (!r.ok) return false;
    const j = await r.json();
    return !!(j && j.classCode && j.title);
  } catch (e) { return false; }
}

async function choosePort() {
  if (await portFree(BASE_PORT)) return { port: BASE_PORT, already: false };
  if (await oursOn(BASE_PORT)) return { port: BASE_PORT, already: true };
  for (let p = BASE_PORT + 1; p <= BASE_PORT + 10; p += 1) {
    if (await portFree(p)) return { port: p, already: false, moved: true };
  }
  return { port: BASE_PORT, already: false, stuck: true };
}

/* --------------------------------------------------------------- the browser */
function openInBrowser(url) {
  try {
    if (process.platform === 'win32') {
      /* `start` is a cmd builtin, and the empty "" is the window title —
       * without it, a quoted URL is taken AS the title and nothing opens. */
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
    return true;
  } catch (e) { return false; }
}

/* The key is read, never assumed. If the server could not write the file (a
 * read-only folder, a locked-down share) we fall back to the join screen,
 * which needs no key, and the console URL is still in the banner. */
function teacherKey() {
  try {
    const k = fs.readFileSync(path.join(ROOT, '.teacher-key'), 'utf8').trim();
    return k || null;
  } catch (e) { return null; }
}

async function waitForServer(port, ms) {
  const until = Date.now() + ms;
  for (;;) {
    if (await oursOn(port)) return true;
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 300));
  }
}

/* ---------------------------------------------------------------- the update
 * Time-boxed, optional, and silent when it cannot run. A district that blocks
 * GitHub must produce a lesson that starts anyway. */
async function maybeUpdate() {
  if (process.env.NO_UPDATE === '1') return;
  if (fs.existsSync(path.join(ROOT, 'NO-UPDATE.txt'))) {
    say('updates are switched off (delete NO-UPDATE.txt to turn them back on)');
    return;
  }
  let mod;
  try { mod = await import('./update.mjs'); }
  catch (e) { return; }                    // updater absent: not an error
  try {
    const r = await mod.checkAndApply({ root: ROOT, log: say });
    if (r && r.applied) {
      say('');
      say('Updated to ' + r.to + '. Starting the new version.');
      rule();
    }
  } catch (e) {
    /* This is the important catch in the file. An update must never be the
     * reason a class does not happen. */
    say('could not check for updates — carrying on with what is here');
  }
}

/* ------------------------------------------------------------------ preflight */
function preflight(nodeExe) {
  const r = spawnSync(nodeExe, [path.join(HERE, 'preflight.mjs')], {
    cwd: ROOT, stdio: 'inherit', env: process.env,
  });
  return r.status === 0;
}

function pause(msg) {
  console.log('');
  say(msg || 'Press Enter to close this window.');
  try {
    /* Read one line from the console. On a double-clicked .cmd this is the
     * only thing standing between an error message and a window that vanishes
     * before it can be read. */
    const buf = Buffer.alloc(1024);
    fs.readSync(0, buf, 0, 1024, null);
  } catch (e) { /* no console: nothing to wait for */ }
}

/* ===========================================================================
 * main
 * ========================================================================= */
const NODE = process.execPath;
const V = version();

console.log('');
console.log('  PAST & PERIL');
console.log('  version ' + V + '   ·   Node ' + process.versions.node);
rule();

/* --- 1. is it already running? ------------------------------------------- */
const chosen = await choosePort();
if (chosen.already) {
  say('');
  say('This is already running. Opening your desk.');
  const k = teacherKey();
  const url = 'http://localhost:' + chosen.port + (k ? '/?key=' + k : '/join');
  openInBrowser(url);
  say('');
  say('  ' + url);
  say('');
  say('The server is in the OTHER black window. Leave that one open.');
  pause('Press Enter to close THIS window (the lesson keeps running).');
  process.exit(0);
}
if (chosen.stuck) {
  say('');
  say('Ports ' + BASE_PORT + ' to ' + (BASE_PORT + 10) + ' are all busy, which is unusual.');
  say('Restarting the computer will clear it.');
  pause();
  process.exit(1);
}
if (chosen.moved) {
  say('Port ' + BASE_PORT + ' was busy, so this lesson is on ' + chosen.port + ' instead.');
  say('That is fine — every address printed below already says ' + chosen.port + '.');
  say('');
}

/* --- 2. updates ---------------------------------------------------------- */
await maybeUpdate();

/* --- 3. the machine ------------------------------------------------------ */
say('Checking the machine...');
console.log('');
if (!preflight(NODE)) {
  console.log('');
  rule();
  say('Something above needs fixing first, so nothing has been started.');
  say('Anything marked STOP has the fix printed under it.');
  pause();
  process.exit(1);
}

/* --- 4. the server ------------------------------------------------------- */
console.log('');
rule();

const logDir = path.join(ROOT, 'logs');
try { fs.mkdirSync(logDir, { recursive: true }); } catch (e) {}

/* Everything the server prints is passed straight through AND kept, for two
 * separate reasons. A crash needs its stack trace. And a problem that did NOT
 * crash — "the map went blank when I pressed START" — needs the last hundred
 * lines of context, because the teacher reporting it cannot be expected to
 * have been watching this window.
 *
 * So both streams are piped rather than inherited, and forwarded immediately,
 * which keeps the banner arriving as it was written. */
const tail = [];
let logStream = null;
try { logStream = fs.createWriteStream(path.join(logDir, 'last-run.txt'), { flags: 'w' }); }
catch (e) { /* a read-only folder loses the log, not the lesson */ }

const keep = (chunk) => {
  const s = String(chunk);
  try { if (logStream) logStream.write(s); } catch (e) {}
  s.split(/\r?\n/).forEach((l) => { if (l.trim()) tail.push(l); });
  while (tail.length > 300) tail.shift();
};

const child = spawn(NODE, [path.join(ROOT, 'server', 'serve.js')], {
  cwd: ROOT,
  env: Object.assign({}, process.env, { PORT: String(chosen.port) }),
  stdio: ['inherit', 'pipe', 'pipe'],
});
child.stdout.on('data', (d) => { keep(d); process.stdout.write(d); });
child.stderr.on('data', (d) => { keep(d); process.stderr.write(d); });

/* --- 5. the desk, once it is actually up --------------------------------- */
(async () => {
  const up = await waitForServer(chosen.port, 12000);
  if (!up) return;                                 // the banner will say why
  const k = teacherKey();
  if (k) {
    openInBrowser('http://localhost:' + chosen.port + '/?key=' + k);
  } else {
    openInBrowser('http://localhost:' + chosen.port + '/join');
    console.log('');
    say('Your own console URL is the one marked YOU in the list above.');
  }
})();

/* --- 6. a crash ---------------------------------------------------------- */
child.on('exit', async (code, signal) => {
  console.log('');
  rule();
  if (code === 0 || signal === 'SIGINT' || signal === 'SIGTERM') {
    say('The server has stopped. The period is saved.');
    say('Double-click START-CLASS again to pick up where you left off.');
    pause();
    process.exit(0);
  }

  say('The server stopped unexpectedly.');
  say('');
  let where = null;
  try {
    const mod = await import('./report.mjs');
    where = mod.write({ root: ROOT, version: V, tail, port: chosen.port, code, signal });
  } catch (e) { /* reporting is a nicety, not a requirement */ }

  if (where) {
    say('A report has been saved. It has no student information in it:');
    say('  ' + path.relative(ROOT, where.file));
    if (where.issueUrl) {
      say('');
      say('Opening a page to send it. Look it over, then press Submit.');
      openInBrowser(where.issueUrl);
    }
  }
  say('');
  say('The lesson itself is saved. Double-click START-CLASS to try again.');
  pause();
  process.exit(code || 1);
});

/* Ctrl-C in this window should stop the server too, not orphan it. */
const bye = () => { try { child.kill(); } catch (e) {} };
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
