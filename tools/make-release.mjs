/* make-release.mjs — build the two zips a release needs.
 *
 *     node tools\make-release.mjs
 *
 * Writes into dist/:
 *
 *   past-and-peril-<version>.zip  ~110 MB  WHAT YOU GIVE A TEACHER.
 *                                      Everything, including the bundled Node
 *                                      runtime, so it runs on a machine where
 *                                      nothing can be installed.
 *
 *   update-<version>.zip      ~20 MB   WHAT AUTO-UPDATE PULLS.
 *                                      The same thing without the 90 MB of
 *                                      node.exe, because a running install
 *                                      already has one and tools/update.mjs
 *                                      would only throw it away.
 *
 * Attach BOTH to the GitHub release. update.mjs prefers the small one by name;
 * a teacher downloading by hand wants the big one.
 *
 * EXCLUDED FROM BOTH, deliberately:
 *   data/          a class's saved progress. Shipping yours to another
 *                  teacher would hand them your students' half-played lesson.
 *   .teacher-key   your console key.
 *   voices/        364 MB of speech models. The rendered audio in app/audio is
 *                  what actually gets played; the models only exist to make it.
 *   logs/ reports/ .backup/   local mess.
 *
 * Uses the tar.exe that ships with Windows 10 and 11, which reads and writes
 * zip. No dependency, nothing to install. */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { zip } from './zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const say = (s) => console.log(s === undefined ? '' : '  ' + s);

/* Never shipped, in either zip.
 *
 * THIS LIST MUST MATCH .gitignore. Both zips are attached to a PUBLIC GitHub
 * release, so anything here that is missing from that list gets published by
 * the release even though it was kept out of the repository — which would
 * quietly defeat the whole point of scoping the repo.
 *
 * Two groups, for two different reasons:
 *
 *   PRIVATE — a decision about what a student who finds the release is
 *   allowed to read. gm-materials/ holds the run sheets for sessions the
 *   class has not played; player-materials/ holds each character's own
 *   secret; assessment/ is the rubric and the live scorecard.
 *
 *   LOCAL — this machine's own state and things that are built rather than
 *   authored. data/ is a class's actual progress and shipping yours to
 *   another teacher would hand them your students' half-played lesson. */
const NEVER = new Set([
  // private
  'gm-materials', 'assessment', 'player-materials',
  'research', 'design', 'design-canvas', 'design-canvas-student',
  'overview.html', '.claude',
  // local
  'data', '.teacher-key', 'voices', 'logs', 'reports', '.backup',
  'dist', '.git', '.gitattributes', 'node_modules', 'NO-UPDATE.txt',
]);
/* In the teacher zip only. */
const RUNTIME_ONLY = new Set(['runtime']);

const version = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();

function stage(name, includeRuntime) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gonzales-stage-'));
  const top = path.join(tmp, 'past-and-peril');
  fs.mkdirSync(top, { recursive: true });

  let n = 0;
  fs.readdirSync(ROOT).forEach((item) => {
    if (NEVER.has(item)) return;
    if (RUNTIME_ONLY.has(item) && !includeRuntime) return;
    fs.cpSync(path.join(ROOT, item), path.join(top, item), { recursive: true });
    n += 1;
  });

  /* A teacher's copy must not arrive pointing at somebody else's repo config
   * by accident, but it MUST arrive with update.json present — an absent file
   * means no updates and no way to report a problem. So it ships as it is,
   * and the placeholder check in update.mjs is what makes an unconfigured
   * copy harmless. */

  const out = path.join(DIST, name);
  fs.mkdirSync(DIST, { recursive: true });
  try { fs.rmSync(out, { force: true }); } catch (e) {}

  const r = zip(out, tmp, 'past-and-peril');
  fs.rmSync(tmp, { recursive: true, force: true });

  if (!r.ok) {
    say('FAILED to build ' + name);
    (r.errors || []).forEach((e) => say('  ' + e));
    return null;
  }
  const mb = (fs.statSync(out).size / 1048576).toFixed(1);
  say(name.padEnd(30) + mb.padStart(7) + ' MB   (' + n + ' top-level items)');
  return out;
}

say();
say('Building release ' + version);
say();

const big = stage('past-and-peril-' + version + '.zip', true);
const small = stage('update-' + version + '.zip', false);

say();
if (!big || !small) {
  say('Something did not build. Nothing has been published.');
  process.exit(1);
}

say('Both are in dist/. To publish:');
say();
say('  1. Commit and push.');
say('  2. Make a GitHub release tagged  v' + version);
say('  3. Attach BOTH zips to it.');
say();
say('Every running copy will pick it up the next time it starts, as long as');
say('its update.json points at your repository and VERSION is lower than ' + version + '.');
say();
say('Bump VERSION before building, or nothing will update — the comparison is');
say('strictly greater, on purpose, so a copy can never flap between versions.');
say();
