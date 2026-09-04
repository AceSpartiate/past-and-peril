/* preflight.mjs — check the machine before a lesson, not during one.
 *
 *     node tools/preflight.mjs
 *
 * Run by START-CLASS.cmd automatically. Everything it looks at is something
 * that has actually gone wrong on a real machine and would otherwise go wrong
 * in front of thirty children:
 *
 *   · Node too old for the syntax the server uses
 *   · the port already held by a server left running from last period
 *   · content files missing or unparseable after an edit
 *   · the audio not committed, so narration silently falls back
 *   · no LAN address, so no student can ever reach it
 *   · the firewall, which is the single most likely reason another machine
 *     cannot connect and gives no error at all — it just hangs
 *
 * It exits non-zero ONLY for things that mean the lesson cannot run. Anything
 * that merely makes it worse is a warning and the lesson goes ahead. */

import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const APP = path.join(ROOT, 'app');
const PORT = Number(process.env.PORT || 8099);

let stop = 0, warn = 0;
const ok = (m) => console.log('  ok     ' + m);
const bad = (m, fix) => { console.log('  STOP   ' + m); if (fix) console.log('         ' + fix); stop++; };
const nag = (m, fix) => { console.log('  warn   ' + m); if (fix) console.log('         ' + fix); warn++; };

/* ---- 1. Node ---------------------------------------------------------- */
const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  bad('Node ' + process.versions.node + ' is too old.',
      'Install the LTS from https://nodejs.org and run this again.');
} else {
  ok('Node ' + process.versions.node);
}

/* ---- 2. is the port free? -------------------------------------------- */
const portFree = await new Promise((res) => {
  const s = net.createServer();
  s.once('error', () => res(false));
  s.once('listening', () => s.close(() => res(true)));
  s.listen(PORT, '0.0.0.0');
});
if (portFree) ok('port ' + PORT + ' is free');
else {
  /* NOT fatal. This used to cancel the lesson, which is the wrong answer to
   * the commonest mistake there is — double-clicking the launcher twice — and
   * the remedy it printed (`npx kill-port`) needs a terminal, npm on PATH and
   * an internet connection, none of which are things this design assumes.
   * tools/start.mjs recognises our own server and reopens the desk, and
   * otherwise moves to the next free port. Either way a class happens. */
  nag('port ' + PORT + ' is already in use.',
      'If you started this twice, that is all it is — the launcher handles it.');
}

/* ---- 3. content ------------------------------------------------------- */
const CONTENT = path.join(APP, 'content');
const need = ['terrain.json', 'roster-s1.json', 'facts-s1.json', 'actions-common.json',
              'session-1.json', 'session-2.json', 'map-gonzales.json'];
let contentOk = true;
need.forEach((f) => {
  const p = path.join(CONTENT, f);
  if (!fs.existsSync(p)) { bad('missing ' + f); contentOk = false; return; }
  try { JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { bad(f + ' is not valid JSON — ' + e.message, 'An edit broke it. Fix or restore that file.'); contentOk = false; }
});
const maps = fs.readdirSync(CONTENT).filter((f) => /^map-.*\.json$/.test(f));
const scenes = fs.readdirSync(CONTENT).filter((f) => /^scene-.*\.json$/.test(f));
if (contentOk) ok(maps.length + ' places, ' + scenes.length + ' scenes, 30 characters');

/* ---- 4. audio -------------------------------------------------------- */
const AUDIO = path.join(APP, 'audio');
if (!fs.existsSync(AUDIO)) {
  nag('no app/audio folder — every line will fall back to the browser voice.',
      'That works, it just sounds worse. See VOICE_LICENSES.md.');
} else {
  const mp3s = fs.readdirSync(AUDIO).filter((f) => f.endsWith('.mp3'));
  let idx = null;
  try { idx = JSON.parse(fs.readFileSync(path.join(AUDIO, 'index.json'), 'utf8')); } catch (e) {}
  const mb = (mp3s.reduce((a, f) => a + fs.statSync(path.join(AUDIO, f)).size, 0) / 1048576).toFixed(1);
  if (!mp3s.length) nag('app/audio is empty — narration falls back to the browser voice.');
  else if (idx && idx.of && mp3s.length < idx.of) {
    nag(mp3s.length + ' of ' + idx.of + ' lines are recorded; the rest use the browser voice.',
        'node tools/render-voices.mjs');
  } else ok(mp3s.length + ' narration lines recorded (' + mb + ' MB)');
}

/* ---- 5. can a student reach this machine at all? --------------------- */
/* THE SAME ranking the server uses, from the same file.
 *
 * This function used to be preflight's own copy — same two filters, same raw
 * enumeration order — so a teacher could get a correct address in the server
 * banner and their VPN recommended here, in the check that exists to catch
 * exactly that. See server/addresses.js. */
const { createRequire } = await import('module');
const requireCjs = createRequire(import.meta.url);
let ips = [];
let ranked = [];
try {
  ranked = requireCjs('../server/addresses.js').ranked(null);
  ips = ranked.map((r) => ({ ip: r.ip, name: r.name, why: r.why }));
} catch (e) {
  ips = [];
}
if (!ips.length) {
  bad('this machine has no network address, so no student can reach it.',
      'Connect to the wifi. A cable to a switch works too — it does not need the internet.');
} else {
  ok(ips.length === 1 ? 'one address: ' + ips[0].ip
     : ips.length + ' addresses, best first');
  ips.forEach((i, n) => {
    console.log('           ' + (n === 0 ? '-> ' : '   ') +
      'http://' + i.ip + ':' + PORT + '/p' +
      (i.name ? '   (' + i.name + ')' : ''));
    /* Only the demotions are worth printing. "Carries the default route" is
     * reassuring but not actionable; "no hardware address — a VPN tunnel" is
     * the line that tells a teacher why the address they expected is second. */
    (i.why || []).filter((w) => /VPN|virtual/i.test(w))
      .forEach((w) => console.log('               ' + w));
  });
  if (ips.length > 1) {
    console.log('         The first is the best guess. The projector screen corrects');
    console.log('         itself as soon as one student actually connects.');
  }
}

/* ---- 6. the firewall, which is the usual culprit -------------------- */
let ruleFound = null;
try {
  /* Two things had to be got right here, and both cost a while.
   *
   * execFileSync, not execSync: the latter goes through cmd.exe, which mangled
   * the nested quotes and made the check look impossible when the query was
   * fine.
   *
   * And PORT FILTERS FIRST. Starting from Get-NetFirewallRule and piping each
   * rule into Get-NetFirewallPortFilter walks every rule on the machine and
   * TIMED OUT past twenty-five seconds. Going the other way — a handful of TCP
   * port filters, then their rules — answers in about half a second. */
  const script =
    /* Without this, "Preparing modules for first use" goes to stderr as CLIXML
     * and powershell EXITS 1 — so the answer arrives correctly on stdout and
     * gets thrown away as a failure. That is the whole reason this check kept
     * reporting that it was impossible. */
    "$ProgressPreference = 'SilentlyContinue'; " +
    'Get-NetFirewallPortFilter -Protocol TCP -ErrorAction SilentlyContinue | ' +
    'Where-Object { $_.LocalPort -eq ' + PORT + ' } | ' +
    'Get-NetFirewallRule -ErrorAction SilentlyContinue | ' +
    "Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' } | " +
    'Measure-Object | ForEach-Object { $_.Count }';
  /* -EncodedCommand, and not -Command.
   *
   * Node quotes spawn arguments by Windows rules and PowerShell then RE-PARSES
   * its own command line, so a one-argument script full of pipes and braces
   * arrives mangled however carefully it was built — the string was provably
   * correct and powershell still refused it. Base64 UTF-16LE goes through
   * untouched, which is exactly what the switch is for. */
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  /* spawnSync, so a non-zero exit does not throw away a stdout that is
   * perfectly good. PowerShell's exit code is not trustworthy here. */
  const r = spawnSync('powershell', ['-NoProfile', '-EncodedCommand', b64],
    { encoding: 'utf8', timeout: 15000 });
  const n = Number(String(r.stdout || '').trim());
  ruleFound = Number.isFinite(n) ? n > 0 : null;
} catch (e) { ruleFound = null; }

if (ruleFound === true) {
  ok('a firewall rule already allows inbound ' + PORT);
} else if (ruleFound === false) {
  nag('NO firewall rule for port ' + PORT + '. This machine will serve itself fine, ' +
      'but another machine will just hang with no error.');
  console.log('');
  console.log('         Run this ONCE, in an Administrator PowerShell:');
  console.log('');
  console.log('           New-NetFirewallRule -DisplayName "Gonzales Company" `');
  console.log('             -Direction Inbound -Protocol TCP -LocalPort ' + PORT + ' -Action Allow');
  console.log('');
  console.log('         Or, the first time you start the server, Windows may pop up');
  console.log('         a box asking. Tick BOTH private and public and allow it.');
} else {
  nag('could not check the firewall (that needs PowerShell).',
      'If another machine cannot connect, the firewall is the first thing to suspect.');
}

/* ---- 7. is there a period already saved? ---------------------------- */
const DATA = path.join(ROOT, 'data');
if (fs.existsSync(DATA)) {
  const saved = fs.readdirSync(DATA).filter((f) => f.endsWith('.json'));
  if (saved.length) {
    ok(saved.length + ' saved period(s): ' + saved.map((f) => f.replace('.json', '')).join(', '));
    console.log('         A restored period always comes back PAUSED. Press RESUME when ready.');
  }
}

/* ---- verdict --------------------------------------------------------- */
console.log('');
if (stop) {
  console.log('  ' + stop + ' thing(s) must be fixed before the lesson can run.');
} else if (warn) {
  console.log('  Good to go. ' + warn + ' warning(s) above — the lesson will run either way.');
} else {
  console.log('  Everything checks out.');
}
process.exitCode = stop ? 1 : 0;
