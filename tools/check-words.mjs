/* check-words.mjs — nothing over fifty words.
 *
 *     node tools\check-words.mjs
 *     node tools\check-words.mjs --worst      the ten longest, whatever they are
 *
 * THE RULE, set by the teacher after a real class played this:
 *
 *     No single piece of authored student-facing text may run over 50 words
 *     without an explicit exception.
 *
 * The class said there was far too much text, too much frontloaded, and that it
 * felt like a textbook with a game around it. Measured at the time: 2,323 words
 * before a student's first real decision, in a 45-minute period. The design
 * rule that came out of it is "game first, history second", and this is the
 * mechanical half of it.
 *
 * WHAT IT GOVERNS
 *
 * Authored text: action labels and details, scene prose, outcome narration,
 * tutorial steps, fact statements, UI copy. Things somebody wrote to be read on
 * a student's screen.
 *
 * WHAT IT DOES NOT GOVERN, and why that is not a loophole
 *
 * Primary sources. The Turtle Bayou Resolutions are 1,663 words because that is
 * how long they are, and shortening a historical document to fit a rule about
 * game copy would be a worse offence than the rule prevents. They are listed
 * below as EXPLICIT exceptions rather than quietly skipped, so the list is
 * auditable and short. Add to it only when the teacher says so.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIMIT = 50;
const WORST = process.argv.includes('--worst');

/* Granted by the teacher, with the reason. Nothing gets on this list by being
 * inconvenient to fix. */
const EXCEPTIONS = [
  { match: /^handouts\//,
    why: 'primary sources — a historical document is as long as it is' },
  { match: /^player-materials\//,
    why: 'the research deck: biography, and behind a tap on the creation screen' },
];

const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const say = (s) => console.log(s === undefined ? '' : '  ' + s);

/* Every authored string a student can be shown, with where it came from. */
const found = [];
function take(where, what, text) {
  const n = words(text);
  if (!n) return;
  found.push({ where, what, n, text: String(text) });
}

/* ---- the content files ------------------------------------------------- */
const CONTENT = path.join(ROOT, 'app', 'content');
const FIELDS = ['label', 'detail', 'blurb', 'narrate', 'statement', 'text',
                'title', 'subtitle', 'teacherNote', 'note', 'say', 'hint',
                'short', 'prompt', 'question', 'body', 'eyebrow'];

function walk(node, file, trail) {
  if (node == null) return;
  if (Array.isArray(node)) { node.forEach((v, i) => walk(v, file, trail + '[' + i + ']')); return; }
  if (typeof node !== 'object') return;
  Object.keys(node).forEach((k) => {
    const v = node[k];
    if (typeof v === 'string' && FIELDS.indexOf(k) !== -1) {
      take(file, (node.id ? node.id + '.' : '') + k, v);
    } else {
      walk(v, file, trail + '.' + k);
    }
  });
}

fs.readdirSync(CONTENT).filter((f) => f.endsWith('.json')).forEach((f) => {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(CONTENT, f), 'utf8')); } catch (e) { return; }
  walk(j, 'app/content/' + f, '');
});

/* ---- authored strings in the client ------------------------------------ */
[['app/js/tutorial.js', /(?:say|hint|text|title|label|detail|narrate):\s*'((?:[^'\\]|\\.){12,})'/g],
 ['app/js/play.js', /textContent\s*=\s*'((?:[^'\\]|\\.){40,})'/g],
 ['app/js/console.js', /textContent\s*=\s*'((?:[^'\\]|\\.){40,})'/g],
].forEach(([rel, re]) => {
  let src = '';
  try { src = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (e) { return; }
  let m;
  while ((m = re.exec(src))) take(rel, 'line ' + (src.slice(0, m.index).split('\n').length), m[1]);
});

/* ---- what a page says before any script runs --------------------------- */
['app/play.html', 'app/index.html', 'app/join.html', 'app/stage.html'].forEach((rel) => {
  let src = '';
  try { src = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (e) { return; }
  src = src.replace(/<script[\s\S]*?<\/script>/gi, ' ')
           .replace(/<style[\s\S]*?<\/style>/gi, ' ')
           .replace(/<!--[\s\S]*?-->/g, ' ');
  /* each visible text node on its own, because the rule is about one thing a
   * student reads at once, not about a whole page */
  const chunks = src.split(/<[^>]+>/).map((s) => s.replace(/&[a-z]+;/gi, ' ').trim());
  chunks.forEach((c, i) => { if (words(c) > 8) take(rel, 'text node ' + i, c); });
});

/* ---- report ------------------------------------------------------------ */
function excepted(where) {
  return EXCEPTIONS.filter((e) => e.match.test(where))[0] || null;
}

const over = found.filter((f) => f.n > LIMIT && !excepted(f.where));
found.sort((a, b) => b.n - a.n);

console.log('');
say(found.length + ' authored pieces of student-facing text');
say('the rule: nothing over ' + LIMIT + ' words');
console.log('');

if (WORST) {
  say('THE TEN LONGEST');
  console.log('');
  found.slice(0, 10).forEach((f) => {
    console.log('  ' + String(f.n).padStart(4) + '  ' + f.where + '  ' + f.what);
    console.log('        ' + f.text.replace(/\s+/g, ' ').slice(0, 96) + '…');
  });
  console.log('');
}

if (!over.length) {
  say('nothing is over ' + LIMIT + ' words.');
  const longest = found.filter((f) => !excepted(f.where))[0];
  if (longest) say('the longest is ' + longest.n + ' — ' + longest.where + ' ' + longest.what);
} else {
  say(over.length + ' OVER THE LIMIT:');
  console.log('');
  over.slice(0, 25).forEach((f) => {
    console.log('  ' + String(f.n).padStart(4) + '  ' + f.where + '  ' + f.what);
    console.log('        ' + f.text.replace(/\s+/g, ' ').slice(0, 92) + '…');
  });
  if (over.length > 25) say('… and ' + (over.length - 25) + ' more');
}

console.log('');
say('exceptions granted:');
EXCEPTIONS.forEach((e) => say('  ' + String(e.match).replace(/[/^]/g, '') + ' — ' + e.why));
console.log('');
process.exitCode = over.length ? 1 : 0;
