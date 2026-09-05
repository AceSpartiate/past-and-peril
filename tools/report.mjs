/* report.mjs — turn a bad afternoon into something one click can send.
 *
 * Two ways in:
 *   · automatically, when tools/start.mjs sees the server exit badly
 *   · by hand, when something was wrong but nothing crashed:
 *         node tools\report.mjs "the map went blank when I pressed START"
 *     which is what REPORT-A-PROBLEM.cmd runs.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not send anything on its own.
 *
 * This is a classroom tool in a public school district, and quietly shipping
 * diagnostics off the machine is the kind of thing that gets software banned
 * by a technology director who was never asked. So the flow is: write a file,
 * scrub it, and open a page with it already filled in. The teacher reads what
 * is about to be sent and presses the button. That is not a compromise on
 * usefulness — a report that arrives with "this happened when I pressed START"
 * typed on top of it is worth three that arrive silently.
 *
 * There IS an opt-in for true automatic sending: put a "reportTo" URL in
 * update.json. It is absent by default, and it should stay absent unless the
 * district has said yes.
 *
 * WHAT IS IN A REPORT
 *
 * The good news is that this app knows almost nothing worth protecting. A
 * student is a random id in their own browser's localStorage plus the name of
 * a person who died in 1836 — there is no student name, no email, no login, no
 * grade, nothing a child typed. So the only identifying data that can end up
 * in a crash trace is the TEACHER'S: their Windows username inside a file
 * path, the machine name, the LAN addresses, and the console key. SCRUB
 * handles all four. See the header of the generated file, which says the same
 * thing to the person about to press Submit.
 * ------------------------------------------------------------------------- */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

/* --------------------------------------------------------------- scrubbing */
function scrubber(root) {
  const rules = [];
  const add = (needle, mask) => {
    if (!needle || String(needle).length < 3) return;
    rules.push([String(needle), mask]);
  };
  try { add(os.userInfo().username, '<teacher>'); } catch (e) {}
  try { add(os.hostname(), '<machine>'); } catch (e) {}
  add(os.homedir(), '<home>');
  try { add(fs.readFileSync(path.join(root, '.teacher-key'), 'utf8').trim(), '<console-key>'); } catch (e) {}

  /* Longest first, so C:\Users\jsmith is masked before jsmith is. */
  rules.sort((a, b) => b[0].length - a[0].length);

  return (s) => {
    let out = String(s == null ? '' : s);
    rules.forEach(([needle, mask]) => { out = out.split(needle).join(mask); });
    /* Four octets, so this cannot eat a version number like 24.20.0. */
    out = out.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>');
    return out;
  };
}

/* ------------------------------------------------------------------ facts */
function machineFacts() {
  const bits = [];
  bits.push('node        ' + process.versions.node);
  bits.push('platform    ' + process.platform + ' ' + process.arch);
  try { bits.push('os          ' + os.version() + ' (' + os.release() + ')'); }
  catch (e) { bits.push('os          ' + os.release()); }
  bits.push('cpus        ' + (os.cpus() || []).length);
  bits.push('memory      ' + Math.round(os.totalmem() / 1073741824) + ' GB');
  return bits.join('\n');
}

function contentFacts(root) {
  const out = [];
  const c = path.join(root, 'app', 'content');
  try {
    const f = fs.readdirSync(c);
    out.push('content     ' + f.filter((x) => /^map-/.test(x)).length + ' maps, ' +
             f.filter((x) => /^session-/.test(x)).length + ' sessions');
  } catch (e) { out.push('content     UNREADABLE — this is probably the problem'); }
  try {
    const a = fs.readdirSync(path.join(root, 'app', 'audio')).filter((x) => x.endsWith('.mp3'));
    out.push('audio       ' + a.length + ' lines');
  } catch (e) { out.push('audio       none'); }
  try {
    const d = fs.readdirSync(path.join(root, 'data')).filter((x) => x.endsWith('.json'));
    out.push('saved       ' + d.length + ' period(s)');
  } catch (e) { out.push('saved       none'); }
  return out.join('\n');
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
}

/* =========================================================================
 * write — build the file, and the URL that carries it
 * ======================================================================= */
export function write(opts) {
  const root = opts.root;
  const scrub = scrubber(root);
  const version = opts.version || 'unknown';
  const note = opts.note || '';

  const body = [
    'PAST & PERIL — problem report',
    'version ' + version + '   ' + new Date().toISOString(),
    '',
    'This file was written on the teacher\'s machine and scrubbed before it was',
    'shown to you. There is no student information in it — this app never asks a',
    'student for a name, an email or a login. The teacher\'s Windows username,',
    'machine name, network addresses and console key have been replaced with',
    'placeholders. Read it before you send it; that is what it is for.',
    '',
    '='.repeat(64),
    '',
    note ? 'WHAT THE TEACHER SAID\n\n  ' + note + '\n' : '',
    opts.code !== undefined || opts.signal
      ? 'HOW IT ENDED\n\n  exit code ' + String(opts.code) +
        (opts.signal ? '  signal ' + opts.signal : '') +
        (opts.port ? '\n  port ' + opts.port : '') + '\n'
      : '',
    'MACHINE',
    '',
    machineFacts().split('\n').map((l) => '  ' + l).join('\n'),
    '',
    'THIS INSTALL',
    '',
    contentFacts(root).split('\n').map((l) => '  ' + l).join('\n'),
    '  runtime     ' + (fs.existsSync(path.join(root, 'runtime', 'node.exe'))
      ? 'bundled' : 'system Node'),
    '',
    'LAST OUTPUT',
    '',
    (opts.tail && opts.tail.length
      ? opts.tail.map((l) => '  ' + l).join('\n')
      : '  (nothing was captured)'),
    '',
    /* null means "this section does not apply here". An empty string means "a
     * blank line goes here" — and dropping those alongside the nulls is what
     * turned the first generated report into an unreadable wall of headings. */
  ].filter((s) => s !== null && s !== undefined).join('\n');

  const clean = scrub(body);

  const dir = path.join(root, 'reports');
  let file = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'report-' + stamp() + '.txt');
    fs.writeFileSync(file, clean.replace(/\n/g, '\r\n'), 'utf8');
  } catch (e) { /* a read-only folder should not swallow the report entirely */ }

  /* --- the prefilled page ---------------------------------------------- */
  let issueUrl = null;
  let repo = '';
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'update.json'), 'utf8'));
    repo = typeof cfg.repo === 'string' ? cfg.repo.trim() : '';
    if (cfg.reportTo) postQuietly(cfg.reportTo, clean);
  } catch (e) {}

  if (repo && /^[\w.-]+\/[\w.-]+$/.test(repo) && !/YOUR|EXAMPLE/i.test(repo)) {
    /* A URL cannot carry an unbounded body. The file on disk is complete; this
     * is the readable summary, trimmed from the FRONT of the tail because the
     * last lines of a crash are the ones that matter. */
    const short = clean.length > 5500
      ? clean.slice(0, 1200) + '\n\n...trimmed; the full file is attached...\n\n' + clean.slice(-4000)
      : clean;
    const title = 'v' + version + ' — ' + (note ? note.slice(0, 60) : 'crash on start');
    issueUrl = 'https://github.com/' + repo + '/issues/new' +
      '?labels=' + encodeURIComponent('from-a-classroom') +
      '&title=' + encodeURIComponent(title) +
      '&body=' + encodeURIComponent(
        (note ? '' : 'The server stopped unexpectedly.\n\n') +
        '```\n' + short + '\n```\n');
  }

  return { file, issueUrl, text: clean };
}

/* Opt-in only, and it may never delay or break anything. */
function postQuietly(url, text) {
  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 4000);
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: text,
      signal: ac.signal,
    }).catch(() => {});
  } catch (e) {}
}

/* ------------------------------------------------------------ run by hand
 * REPORT-A-PROBLEM.cmd calls this with whatever the teacher typed. Nothing
 * crashed, so there is no stderr to capture — the last-run log is used
 * instead, which is why start.mjs keeps one. */
const isMain = process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const note = process.argv.slice(2).join(' ').trim();
  let tail = [];
  try {
    tail = fs.readFileSync(path.join(root, 'logs', 'last-run.txt'), 'utf8')
      .split(/\r?\n/).filter(Boolean).slice(-120);
  } catch (e) {}
  let version = 'unknown';
  try { version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim(); } catch (e) {}

  const r = write({ root, version, note, tail });
  console.log('');
  console.log('  Saved: ' + (r.file ? path.relative(root, r.file) : '(could not write a file)'));
  if (r.issueUrl) {
    console.log('');
    console.log('  Opening a page with it already filled in. Read it, then press Submit.');
    const { spawn } = await import('child_process');
    try {
      if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '', r.issueUrl], { detached: true, stdio: 'ignore' }).unref();
      }
    } catch (e) {}
  } else {
    console.log('');
    console.log('  No repository is configured in update.json, so there is nowhere to');
    console.log('  send it automatically. Email that file to whoever gave you this.');
  }
  console.log('');
}
