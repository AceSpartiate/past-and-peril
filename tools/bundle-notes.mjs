/* bundle-notes.mjs — put the unpublished thinking in one file so it can travel.
 *
 *     node tools\bundle-notes.mjs
 *     node tools\bundle-notes.mjs "D:\stick\notes.zip"
 *
 * WHY THIS EXISTS
 *
 * design/, research/, gm-materials/, assessment/ and player-materials/ are in
 * .gitignore, because this repository is PUBLIC — auto-update reads GitHub's
 * API with no token. Publishing them would hand every student the run sheets,
 * the rubrics, and every other student's secret.
 *
 * The cost of that decision is that a fresh clone on another machine contains
 * the game and none of the reasoning behind it. Six sessions of design, the
 * sourcing, and every settled decision simply are not there. This makes one
 * zip you can carry.
 *
 * IT WRITES OUTSIDE THE REPOSITORY, DELIBERATELY.
 *
 * A zip of exactly the material we refuse to publish, sitting in the root of
 * the repository we publish, is a loaded gun. `*-notes.zip` is in .gitignore as
 * belt-and-braces, but the real protection is not putting it there in the first
 * place — so the default destination is the parent directory, and an explicit
 * path inside the repo is refused.
 *
 * WINDOWS TAR
 *
 * Git Bash's `tar` is GNU tar: it cannot make zips, and it reads `C:` as a
 * remote host name. %SystemRoot%\System32\tar.exe is bsdtar and does both. Name
 * it explicitly rather than trusting PATH — tools/zip.mjs learned this the hard
 * way.
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* Everything .gitignore keeps back that is WRITING rather than machine state.
 * data/, logs/, .teacher-key and the built runtimes are deliberately not here:
 * they are this machine's, not the project's, and one of them is a secret. */
const DIRS = ['design', 'research', 'gm-materials', 'assessment', 'player-materials'];

const say = (s) => console.log(s === undefined ? '' : '  ' + s);

const arg = process.argv[2];
const dest = path.resolve(arg || path.join(ROOT, '..', 'past-and-peril-notes.zip'));

/* Refuse to write inside the repo, whatever was asked for. */
const rel = path.relative(ROOT, dest);
if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
  console.error('');
  console.error('  REFUSED: ' + dest);
  console.error('  That is inside the repository, and this bundle contains the material');
  console.error('  the repository exists to keep back. Pick a path outside it.');
  console.error('');
  process.exit(1);
}

const present = DIRS.filter((d) => fs.existsSync(path.join(ROOT, d)));
const missing = DIRS.filter((d) => !fs.existsSync(path.join(ROOT, d)));

console.log('');
if (!present.length) {
  say('None of the private directories are here. Nothing to bundle.');
  say('That probably means this is a fresh clone — the notes live on the');
  say('machine the work was done on.');
  console.log('');
  process.exit(1);
}

const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const r = spawnSync(tar, ['-a', '-c', '-f', dest, ...present], { cwd: ROOT, encoding: 'utf8' });

if (r.status !== 0) {
  console.error('  tar failed: ' + (r.stderr || r.error || 'unknown'));
  console.error('');
  process.exit(1);
}

const kb = Math.round(fs.statSync(dest).size / 1024);
const count = spawnSync(tar, ['-tf', dest], { encoding: 'utf8' })
  .stdout.split('\n').filter((l) => l.trim() && !l.trim().endsWith('/')).length;

say('bundled ' + present.join(', '));
if (missing.length) say('not here, so not included: ' + missing.join(', '));
say('');
say(count + ' files · ' + kb + ' KB');
say(dest);
say('');
say('This contains run sheets, rubrics and per-student secrets.');
say('Do not put it anywhere a student can reach.');
console.log('');
