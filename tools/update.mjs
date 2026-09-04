/* update.mjs — pull the latest release from GitHub, carefully.
 *
 * Called by tools/start.mjs before the server starts. Also runnable by hand:
 *
 *     node tools\update.mjs              check and apply
 *     node tools\update.mjs --check      say what it would do, change nothing
 *
 * CONFIGURATION lives in update.json at the project root:
 *
 *     { "repo": "yourname/gonzales-company" }
 *
 * No token, no account, no npm package. A public repo's releases are readable
 * by anyone, so there is no secret to leak and nothing for a teacher to set up.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR RULES THIS FILE OBEYS
 *
 * 1. AN UPDATE MAY NEVER STOP A LESSON.
 *    Every network call is time-boxed and every failure returns quietly. A
 *    district that blocks github.com must still get a class that starts. This
 *    is why nothing here throws upward except by accident, and why start.mjs
 *    wraps the call anyway.
 *
 * 2. THE TEACHER'S OWN THINGS ARE NEVER TOUCHED.
 *    Saved periods, the console key, logs, the bundled runtime. See PROTECTED.
 *    A teacher losing a class's progress to an update would be unforgivable,
 *    and it is the single most likely way for this file to do harm.
 *
 * 3. NOT IN THE MIDDLE OF A UNIT.
 *    If a period was saved in the last few hours, a lesson sequence is in
 *    progress and the code underneath it is left alone until tomorrow. Content
 *    ids are what a saved period points at; changing them mid-sequence is how
 *    you lose a class's work.
 *
 * 4. IT MUST BE UNDOABLE.
 *    The version being replaced is kept in .backup/, and ROLLBACK.cmd puts it
 *    back. An automatic update with no way back is a bad trade for someone who
 *    has thirty children arriving in four minutes.
 * ------------------------------------------------------------------------- */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { unzip } from './zip.mjs';

/* Never replaced by an update, for the reasons in rule 2. */
const PROTECTED = new Set([
  'data',            // saved periods — a class's actual progress
  'runtime',         // the bundled node.exe: 90 MB, and versioned separately
  'voices',          // 364 MB of models, never in a release
  'logs',
  'reports',
  '.backup',
  '.teacher-key',    // the console key the teacher has bookmarked
  'update.json',     // local configuration
  'NO-UPDATE.txt',
  '.git',
]);

const UA = { 'User-Agent': 'gonzales-company-launcher', Accept: 'application/vnd.github+json' };

/* Overridable so the swap-and-back-up logic below can be tested end to end
 * against a local stand-in for GitHub. Nothing a teacher ever sets. */
const API = process.env.GONZALES_UPDATE_API || 'https://api.github.com';

/* --------------------------------------------------------------- utilities */
function readJson(p, dflt) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return dflt; }
}

function semver(s) {
  const m = String(s || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function newer(a, b) {                     // is a strictly newer than b?
  const x = semver(a), y = semver(b);
  if (!x || !y) return false;              // unparseable: never update, never loop
  for (let i = 0; i < 3; i += 1) {
    if (x[i] > y[i]) return true;
    if (x[i] < y[i]) return false;
  }
  return false;
}

/* Returns null for every kind of failure — refused, filtered, timed out,
 * rate-limited, not JSON. A caller here has exactly one useful response to all
 * of them (carry on with what is installed), so distinguishing them would only
 * create a path that can throw. This was measured: pointed at a dead port,
 * an earlier version rejected out of checkAndApply. */
async function getJson(url, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { headers: UA, signal: ac.signal, cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  } finally { clearTimeout(t); }
}

async function download(url, dest, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA['User-Agent'] }, signal: ac.signal });
    if (!r.ok) return false;
    const buf = Buffer.from(await r.arrayBuffer());
    /* A real release is megabytes. Anything this small is a captive-portal
     * login page, a filter's block notice, or an error document served with a
     * 200 — all of which would otherwise be unzipped over a working install. */
    if (buf.length < 4096) return false;
    fs.writeFileSync(dest, buf);
    return true;
  } catch (e) {
    return false;
  } finally { clearTimeout(t); }
}

/* A GitHub zipball wraps everything in one folder named after the commit. A
 * hand-built release asset may or may not. Find the real root either way. */
function payloadRoot(dir) {
  const looksRight = (d) => fs.existsSync(path.join(d, 'server', 'serve.js')) &&
                            fs.existsSync(path.join(d, 'app'));
  if (looksRight(dir)) return dir;
  const kids = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
  if (kids.length === 1) {
    const one = path.join(dir, kids[0].name);
    if (looksRight(one)) return one;
  }
  return null;
}

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} }

/* Rule 3: is a lesson sequence in progress right now? */
function unitInProgress(root) {
  const data = path.join(root, 'data');
  if (!fs.existsSync(data)) return false;
  const cutoff = Date.now() - 6 * 3600 * 1000;
  return fs.readdirSync(data)
    .filter((f) => f.endsWith('.json'))
    .some((f) => {
      try { return fs.statSync(path.join(data, f)).mtimeMs > cutoff; }
      catch (e) { return false; }
    });
}

/* =========================================================================
 * the one exported thing
 * ======================================================================= */
export async function checkAndApply(opts) {
  const root = opts.root;
  const log = opts.log || (() => {});
  const dryRun = !!opts.dryRun;

  const cfg = readJson(path.join(root, 'update.json'), null);
  const repo = cfg && typeof cfg.repo === 'string' ? cfg.repo.trim() : '';
  /* No repo configured, or still the placeholder: this copy does not update,
   * and that is a perfectly good state to be in. */
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || /YOUR|EXAMPLE|owner\/repo/i.test(repo)) {
    return { applied: false, reason: 'not-configured' };
  }

  const have = (readFile(path.join(root, 'VERSION')) || '0.0.0').trim();

  const rel = await getJson(API + '/repos/' + repo + '/releases/latest', 6000);
  if (!rel || !rel.tag_name) return { applied: false, reason: 'no-release' };
  const want = String(rel.tag_name).replace(/^v/i, '');

  if (!newer(want, have)) return { applied: false, reason: 'current', have, want };

  log('');
  log('An update is available: ' + have + '  ->  ' + want);

  if (unitInProgress(root)) {
    log('A class is part-way through a lesson sequence, so this will wait');
    log('until tomorrow. Nothing has changed.');
    return { applied: false, reason: 'unit-in-progress', have, want };
  }
  if (dryRun) return { applied: false, reason: 'dry-run', have, want };

  /* --- fetch ------------------------------------------------------------ */
  /* A release carries two zips on purpose (see tools/make-release.mjs):
   *   update-x.y.z.zip     ~20 MB, code and content only
   *   gonzales-x.y.z.zip  ~110 MB, the same plus the bundled Node runtime,
   *                        which is what you hand to another teacher
   * Both work here, because `runtime` is PROTECTED either way — but pulling
   * 90 MB of node.exe over school wifi in order to discard it would be rude,
   * so the small one is preferred by name. */
  const assets = rel.assets || [];
  const asset = assets.find((a) => /^update[-_.]/i.test(a.name || '') && /\.zip$/i.test(a.name || ''))
             || assets.find((a) => /\.zip$/i.test(a.name || ''));
  const url = asset ? asset.browser_download_url : rel.zipball_url;
  if (asset) log('(' + asset.name + ', ' + Math.round((asset.size || 0) / 1048576) + ' MB)');
  if (!url) return { applied: false, reason: 'no-asset' };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gonzales-update-'));
  const zip = path.join(tmp, 'payload.zip');
  try {
    log('Downloading...');
    if (!await download(url, zip, 120000)) { rmrf(tmp); return { applied: false, reason: 'download-failed' }; }
    const x = unzip(zip, path.join(tmp, 'x'));
    if (!x.ok) {
      rmrf(tmp);
      /* Worth logging rather than swallowing: an install that can never
       * extract will otherwise report "no update" forever. */
      (x.errors || []).forEach((e) => log('  ' + e));
      return { applied: false, reason: 'unzip-failed' };
    }

    const src = payloadRoot(path.join(tmp, 'x'));
    /* If the payload does not contain a server and an app, it is not this
     * project, and copying it over a working install would be destructive. */
    if (!src) { rmrf(tmp); return { applied: false, reason: 'payload-not-recognised' }; }

    /* --- back up what we are about to replace (rule 4) ------------------- */
    const backup = path.join(root, '.backup');
    rmrf(backup);
    fs.mkdirSync(backup, { recursive: true });
    fs.writeFileSync(path.join(backup, 'FROM-VERSION.txt'), have + '\n');

    const incoming = fs.readdirSync(src);
    incoming.forEach((name) => {
      if (PROTECTED.has(name)) return;
      const cur = path.join(root, name);
      if (!fs.existsSync(cur)) return;
      try { fs.cpSync(cur, path.join(backup, name), { recursive: true }); } catch (e) {}
    });

    /* --- swap ------------------------------------------------------------ */
    let n = 0;
    incoming.forEach((name) => {
      if (PROTECTED.has(name)) return;
      const from = path.join(src, name);
      const to = path.join(root, name);
      try {
        rmrf(to);
        fs.cpSync(from, to, { recursive: true });
        n += 1;
      } catch (e) {
        log('could not replace ' + name + ' — it may be open in another program');
      }
    });

    fs.writeFileSync(path.join(root, 'VERSION'), want + '\n');
    log(n + ' item(s) updated. The previous version is in .backup, and');
    log('ROLLBACK.cmd puts it back if anything looks wrong.');
    return { applied: true, from: have, to: want };
  } finally {
    rmrf(tmp);
  }
}

function readFile(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } }

/* ------------------------------------------------------------ run by hand */
/* Windows makes the "am I the entry point" comparison genuinely awkward:
 * import.meta.url is a file:// URL with forward slashes and a drive letter,
 * argv[1] is a native path. Normalise both through the same two functions
 * rather than trying to match the strings by hand. */
const isMain = process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const r = await checkAndApply({
    root,
    log: (s) => console.log('  ' + s),
    dryRun: process.argv.includes('--check'),
  });
  console.log('');
  console.log('  ' + JSON.stringify(r));
  console.log('');
}
