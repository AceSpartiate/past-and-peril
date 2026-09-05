/* reading-first-ten.mjs — how many words before a student plays?
 *
 *     node tools\reading-first-ten.mjs
 *
 * A real class played this and the first complaint was that there was far too
 * much text at the start, too much frontloaded, and that the tutorial did not
 * teach them to play. "It shouldn't feel like a textbook with a gamey
 * exterior."
 *
 * Too much is not a number, so this counts one. It walks the actual opening —
 * every screen a student sees between opening the link and their first real
 * decision — and reports the words on each, with the time each costs at the
 * measured bottom-quartile reading speed of 110 words a minute (and at 90, the
 * struggling reader tools/reading-load.js was built around).
 *
 * It counts what a student MUST read to proceed, plus what is put in front of
 * them unasked. A document they can open is not counted; a document that opens
 * itself is.
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const require = createRequire(import.meta.url);

const WPM_SLOW = 90;
const WPM_BOTTOM_QUARTILE = 110;

const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const say = (s) => console.log(s === undefined ? '' : '  ' + s);

/* Strip tags and script/style bodies from a served page, so what is counted is
 * what a student's eye lands on. */
function visibleWords(html, opts) {
  opts = opts || {};
  let s = String(html);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  /* elements marked hidden are not on screen at that moment */
  if (opts.dropHidden) s = s.replace(/<(\w+)[^>]*\shidden[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&[a-z]+;/gi, ' ');
  return words(s);
}

const rows = [];
function step(name, n, note) {
  rows.push({ name, n, note });
}

/* ---- 1. the screens, as served ---------------------------------------- */
const play = fs.readFileSync(path.join(ROOT, 'app', 'play.html'), 'utf8');
step('the pick screen', visibleWords(
  play.slice(play.indexOf('<div class="pick"'), play.indexOf('<!-- ============ MAKE'))),
  'before they have chosen anybody');

step('the creation screen', visibleWords(
  play.slice(play.indexOf('<div class="make"'), play.indexOf('<!-- ============ PLAY'))),
  'plus the person card, counted below');

/* the person card is put in front of them without being asked for */
try {
  const people = require(path.join(ROOT, 'server', 'people.js'));
  const roster = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'app', 'content', 'roster-s1.json'), 'utf8')).roster;
  const withCards = roster.map((p) => people.forName(p.name, p.id)).filter(Boolean);
  const avg = withCards.length
    ? Math.round(withCards.reduce((a, c) => a + words(JSON.stringify(c.blocks).replace(/"[a-z]+":/g, ' ').replace(/[{}\[\]",]/g, ' ')), 0) / withCards.length)
    : 0;
  /* Same question as the document: is it in front of them, or behind a tap?
   * The markup answers it — a collapsed body is not reading load. */
  const html = fs.readFileSync(path.join(ROOT, 'app', 'play.html'), 'utf8');
  const collapsed = /id="make-card-body"[^>]*\shidden/.test(html);
  if (collapsed) {
    step('the person card', 4, 'behind a tap — ' + avg + ' words if they open it');
  } else {
    step('the person card', avg, 'OPEN on the creation screen, average of 25 cards');
  }
} catch (e) { step('the person card', 0, 'could not read'); }

/* ---- 2. the tutorial --------------------------------------------------- */
try {
  const tut = fs.readFileSync(path.join(ROOT, 'app', 'js', 'tutorial.js'), 'utf8');
  /* every authored string a student is shown: say, hint, point text, next */
  const strings = [];
  const grab = (re) => { let m; while ((m = re.exec(tut))) strings.push(m[1]); };
  grab(/say:\s*'([^']{4,})'/g);
  grab(/hint:\s*'([^']{4,})'/g);
  grab(/text:\s*'([^']{4,})'/g);
  grab(/title:\s*'([^']{4,})'/g);
  grab(/return\s*'([^']{12,})'/g);
  const n = strings.reduce((a, s) => a + words(s), 0);
  const steps = (tut.match(/^      id: '/gm) || []).length;
  step('the tutorial', n, strings.length + ' authored lines across ' + steps + ' steps');
} catch (e) { step('the tutorial', 0, 'could not read'); }

/* ---- 3. the cold open -------------------------------------------------- */
const session = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'app', 'content', 'session-1.json'), 'utf8'));
const cold = (session.timeline || []).filter((g) => g.id === 'cold_open')[0] || {};
const coldWords = words(JSON.stringify(cold).replace(/"[a-zA-Z_]+":/g, ' ').replace(/[{}\[\]",]/g, ' '));
step('the cold open script', coldWords, (cold.seconds || 0) + ' seconds, read aloud from the front');

/* THE DOCUMENT: imposed, or merely offered?
 *
 * This is the measurement that matters, and it is why the tool exists. A
 * primary source a student can open is not reading load; one that opens itself
 * over their screen is. The difference is one line in play.js, so look at that
 * line rather than at the content. */
try {
  const handouts = require(path.join(ROOT, 'server', 'handouts.js'));
  const h = cold.handout ? handouts.get(cold.handout) : null;
  if (h) {
    const playjs = fs.readFileSync(path.join(ROOT, 'app', 'js', 'play.js'), 'utf8');
    const maybe = playjs.slice(playjs.indexOf('function maybeDocs'),
                               playjs.indexOf('function renderDocsBtn'));
    const imposed = /Docs\.open\(/.test(maybe);
    const n = words(JSON.stringify(h.blocks).replace(/"[a-z]+":/g, ' ').replace(/[{}\[\]",]/g, ' '));
    if (imposed) {
      step('the document, OPENED OVER THEIR SCREEN', n, h.title + ' — unasked');
    } else {
      /* the arrival line, and nothing else, unless they choose to read it */
      const toast = fs.readFileSync(path.join(ROOT, 'app', 'play.html'), 'utf8');
      const bit = toast.slice(toast.indexOf('class="doc-toast"'), toast.indexOf('</button>', toast.indexOf('class="doc-toast"')));
      step('a document arrives', visibleWords(bit) + words(h.title),
           h.title + ' — offered, ' + n + ' words if they open it');
    }
  }
} catch (e) {}

/* ---- 4. the first turn ------------------------------------------------- */
try {
  const scene = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'app', 'content', 'scene-s1-1.json'), 'utf8'));
  const acts = (scene.actions || []).slice(0, 7);
  const n = acts.reduce((a, x) => a + words(x.label) + words(x.blurb || x.detail || ''), 0);
  step('the first turn\'s choices', n, acts.length + ' action cards');
} catch (e) {}

/* ---- report ------------------------------------------------------------ */
console.log('');
console.log('  WORDS BEFORE A STUDENT PLAYS');
console.log('  ' + '='.repeat(64));
console.log('');
console.log('  ' + 'screen'.padEnd(34) + 'words'.padStart(7) + '   at 90 wpm');
console.log('  ' + '-'.repeat(64));
let total = 0;
rows.forEach((r) => {
  total += r.n;
  const mins = r.n / WPM_SLOW;
  console.log('  ' + r.name.padEnd(34) + String(r.n).padStart(7) +
    '   ' + (mins < 1 ? Math.round(mins * 60) + 's' : mins.toFixed(1) + ' min').padStart(8));
  if (r.note) console.log('  ' + ' '.repeat(34) + r.note);
});
console.log('  ' + '-'.repeat(64));
console.log('  ' + 'TOTAL'.padEnd(34) + String(total).padStart(7) +
  '   ' + (total / WPM_SLOW).toFixed(1) + ' min');
console.log('');
say('At ' + WPM_BOTTOM_QUARTILE + ' wpm (measured bottom quartile): ' +
    (total / WPM_BOTTOM_QUARTILE).toFixed(1) + ' minutes.');
say('At ' + WPM_SLOW + ' wpm (a struggling reader): ' +
    (total / WPM_SLOW).toFixed(1) + ' minutes.');
console.log('');
say('A 45-minute period. Everything above happens before the first real');
say('decision of the lesson.');
console.log('');
