/* rollback.mjs — undo the last update.
 *
 * Run by ROLLBACK.cmd. tools/update.mjs copies everything it is about to
 * replace into .backup/ first, precisely so this can exist.
 *
 * An automatic update with no way back is a bad bargain for a teacher with a
 * class arriving. This is the way back, and it has to be as simple as the
 * thing that broke them: double-click, read one sentence, done.
 *
 * It restores CODE AND CONTENT ONLY. Saved periods, the console key and the
 * bundled runtime were never backed up because they are never replaced — see
 * PROTECTED in update.mjs. So rolling back cannot cost a class its progress,
 * which is the property that makes it safe to offer to someone in a hurry. */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKUP = path.join(ROOT, '.backup');
const say = (s) => console.log(s === undefined ? '' : '  ' + s);

say();
if (!fs.existsSync(BACKUP)) {
  say('There is no previous version saved, so there is nothing to roll back to.');
  say('That means no update has ever been applied to this copy.');
  say();
  process.exit(0);
}

let from = 'an earlier version';
try { from = fs.readFileSync(path.join(BACKUP, 'FROM-VERSION.txt'), 'utf8').trim() || from; }
catch (e) {}

let now = 'unknown';
try { now = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim(); } catch (e) {}

say('Rolling back:  ' + now + '  ->  ' + from);
say();

const items = fs.readdirSync(BACKUP).filter((n) => n !== 'FROM-VERSION.txt');
let done = 0;
const stuck = [];

items.forEach((name) => {
  const to = path.join(ROOT, name);
  try {
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(path.join(BACKUP, name), to, { recursive: true });
    done += 1;
  } catch (e) {
    stuck.push(name);
  }
});

try { fs.writeFileSync(path.join(ROOT, 'VERSION'), from + '\n'); } catch (e) {}

/* The backup is left in place. If the first rollback half-failed because a
 * file was open, closing that program and running this again has to work — and
 * it cannot if the only copy of the old version was just consumed. */
say(done + ' of ' + items.length + ' item(s) restored.');
if (stuck.length) {
  say();
  say('These could not be replaced, probably because something has them open:');
  stuck.forEach((n) => say('  ' + n));
  say();
  say('Close any editor or Explorer window looking at this folder, then run');
  say('ROLLBACK again. Nothing has been thrown away.');
} else {
  say();
  say('Done. Start the lesson as usual.');
  say();
  say('This copy will try to update again next time it starts. To stop that');
  say('until the problem is fixed, make an empty file called NO-UPDATE.txt');
  say('next to START-CLASS.cmd.');
}
say();
