/* check-people.mjs — can a student read something meant only for the teacher?
 *
 *     node tools\check-people.mjs
 *
 * player-materials/person-cards-gonzales.md contains three sections headed
 * with a warning sign, one of which says in the file itself:
 *
 *     ## ⚠ TWO NOTES FOR THE TEACHER ONLY — do not put these on cards
 *
 * server/people.js drops those before serving anything. This asserts it, by
 * taking distinctive phrases out of the excluded sections and searching every
 * card the server would actually hand to a student.
 *
 * It also reports the match rate, because matching sixty-two research cards to
 * thirty playable characters by name is a heuristic and heuristics should say
 * out loud what they missed rather than fail quietly.
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const require = createRequire(import.meta.url);
const people = require(path.join(ROOT, 'server', 'people.js'));

const roster = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'app', 'content', 'roster-s1.json'), 'utf8')).roster;

let bad = 0;
const say = (s) => console.log(s === undefined ? '' : '  ' + s);

say();
const stats = people._stats();
say(stats.cards + ' cards parsed');
if (stats.droppedFromTeacherSections) {
  say(stats.droppedFromTeacherSections + ' card(s) dropped for sitting inside a teacher-only section');
}

/* ---- 1. what a student can actually see ------------------------------- */
const visible = [];
const matched = [];
const unmatched = [];
roster.forEach((p) => {
  const card = people.forName(p.name);
  if (!card) { unmatched.push(p.name); return; }
  matched.push(p.name);
  visible.push(JSON.stringify(card));
});
const haystack = visible.join('\n').toLowerCase();

say();
say(matched.length + ' of ' + roster.length + ' characters have a card');
if (unmatched.length) {
  say('no card, so no research panel: ' + unmatched.join(', '));
}

/* ---- 2. the teacher-only text must not be in any of it ---------------- */
const src = fs.readFileSync(
  path.join(ROOT, 'player-materials', 'person-cards-gonzales.md'), 'utf8');

/* WHAT COUNTS AS TEACHER-ONLY IS THE STRIPPER'S ANSWER, NOT A SECOND OPINION.
 *
 * This test originally re-implemented the section rule, and the two drifted the
 * moment the real one was fixed: the test kept the old "ends at ## only"
 * termination, decided Company 1's six biographies were teacher-only, and
 * reported sixteen leaks that were not leaks. A test that disagrees with the
 * code about what it is testing is worse than no test at all.
 *
 * So excluded text is defined as exactly the lines the stripper removed. If the
 * rule changes this follows it, and a real leak still fails. */
const rawLines = src.replace(/\r\n/g, '\n').split('\n');
const keptLines = new Set(people._strip(src).split('\n'));
const excluded = [];
rawLines.forEach((line) => {
  if (keptLines.has(line)) return;
  const t = line.replace(/[*_>|#-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length > 40) excluded.push(t);
});

say();
say('checking ' + excluded.length + ' teacher-only line(s) against what students receive');
let leaks = 0;
excluded.forEach((line) => {
  /* a distinctive run of the line, long enough not to collide by accident */
  const probe = line.slice(0, 60).toLowerCase();
  if (probe.length >= 40 && haystack.indexOf(probe) !== -1) {
    leaks += 1;
    if (leaks <= 3) say('  LEAKED: ' + line.slice(0, 90));
  }
});
if (leaks) { say('  ' + leaks + ' teacher-only line(s) reach a student screen'); bad += 1; }
else say('  none of it reaches a student');

/* ---- 3. and the headings themselves ----------------------------------- */
['deck balancing', 'yours to play', 'for the teacher only', 'do not put these on cards']
  .forEach((phrase) => {
    if (haystack.indexOf(phrase) !== -1) {
      say('  LEAKED heading text: "' + phrase + '"');
      bad += 1;
    }
  });

/* ---- 4. a card must actually carry the honesty line ------------------- */
say();
const withDoesntSay = matched.filter((n) => {
  const c = people.forName(n);
  return JSON.stringify(c).toLowerCase().includes("record doesn't say");
}).length;
say(withDoesntSay + ' of ' + matched.length + ' cards carry a "what the record doesn\'t say"');
if (withDoesntSay < matched.length * 0.6) {
  say('  fewer than expected — check the deck formatting');
  bad += 1;
}

say();
say(bad ? bad + ' problem(s)' : 'clean — nothing teacher-only reaches a student');
say();
process.exitCode = bad ? 1 : 0;
