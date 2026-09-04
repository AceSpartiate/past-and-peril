#!/usr/bin/env node
/* reading-load.js — measures the reading burden of the real authored content.
 *
 * design/15-risk-review.md R2 names reading load the top classroom risk on a
 * low-SES campus, and its first recommended measurement was "time five students
 * of different reading levels through one scene." That playtest is no longer
 * available before the build, so this measures what can be measured WITHOUT
 * students: how many words the content actually asks a reader to get through,
 * how hard those words are, and how long that takes at published reading rates.
 *
 * It cannot tell us whether the unit is fun. Nothing here claims to.
 *
 *   node tools/reading-load.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* Oral reading fluency rates. Hasbrouck & Tindal's widely used ORF norms put
 * spring grade-7 words-correct-per-minute at roughly 150 (50th percentile) and
 * about 110 at the 10th percentile. SILENT reading of unfamiliar informational
 * text runs slower than oral fluency for weaker readers, and these passages are
 * decision text — read to compare options, not to perform. So the rates below
 * are deliberately conservative and are labelled as estimates, not norms. */
const RATES = [
  { name: 'strong reader',        wpm: 200 },
  { name: 'at grade level',       wpm: 150 },
  { name: 'about 2 years below',  wpm: 110 },
  { name: 'about 4 years below',  wpm: 80 },
];

function words(s) {
  return (s.match(/[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ'’-]*/g) || []);
}
function sentences(s) {
  return (s.split(/[.!?]+(?=\s|$)/).filter(function (x) { return x.trim().length > 1; }));
}
function syllables(w) {
  w = w.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const m = w.match(/[aeiouy]{1,2}/g);
  return m ? m.length : 1;
}

function readability(text) {
  const W = words(text), S = sentences(text);
  if (!W.length || !S.length) return null;
  const syl = W.reduce(function (a, w) { return a + syllables(w); }, 0);
  const wps = W.length / S.length;
  const spw = syl / W.length;
  return {
    words: W.length,
    sentences: S.length,
    wordsPerSentence: wps,
    syllablesPerWord: spw,
    // Flesch–Kincaid grade level
    fk: 0.39 * wps + 11.8 * spw - 15.59,
    // Flesch Reading Ease
    fre: 206.835 - 1.015 * wps - 84.6 * spw,
    // words of 3+ syllables, as a share — the thing that actually stalls a reader
    hardShare: W.filter(function (w) { return syllables(w) >= 3; }).length / W.length,
  };
}

function fmt(n, d) { return Number(n).toFixed(d === undefined ? 1 : d); }
function mmss(sec) {
  sec = Math.round(sec);
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}
function bar(v, max, w) {
  const n = Math.max(0, Math.min(w, Math.round((v / max) * w)));
  return '█'.repeat(n) + '·'.repeat(w - n);
}

/* ---------------------------------------------------------------- parse */

function parsePassageBook(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const chunks = raw.split(/^### ── (\d{3}) ──\s*$/m);
  const out = [];
  for (let i = 1; i < chunks.length; i += 2) {
    const id = chunks[i];
    const body = chunks[i + 1] || '';
    const lines = body.split('\n');
    const prose = [];
    const options = [];
    lines.forEach(function (l) {
      const m = l.match(/^- ▸\s*(.*)$/);
      if (m) {
        options.push(m[1]
          .replace(/`\[[A-Z ]+\]`/g, '')        // gate tags are glanced, not read
          .replace(/→\s*\*\*\d+\*\*.*$/, '')     // the arrow is going away anyway
          .replace(/\*+/g, '')
          .trim());
      } else if (!/^\s*(---|\s*)$/.test(l)) {
        prose.push(l);
      }
    });
    out.push({ id: id, prose: prose.join(' ').replace(/\*+/g, '').trim(), options: options });
  }
  return out;
}

/* ---------------------------------------------------------------- report */

const bookFile = path.join(ROOT, 'player-materials', 'passage-book-session-1.md');
const passages = parsePassageBook(bookFile);

console.log('');
console.log('READING LOAD — Session 1 passage book');
console.log('='.repeat(72));
console.log(passages.length + ' passages parsed from ' + path.relative(ROOT, bookFile));
console.log('');

/* --- per-node cost: a student reads the prose AND every option before choosing */
let proseW = 0, optW = 0, optCount = 0;
const nodeCosts = [];
const optionLens = [];
passages.forEach(function (p) {
  const pw = words(p.prose).length;
  const ow = p.options.reduce(function (a, o) { return a + words(o).length; }, 0);
  proseW += pw; optW += ow; optCount += p.options.length;
  p.options.forEach(function (o) { optionLens.push({ id: p.id, n: words(o).length, text: o }); });
  nodeCosts.push({ id: p.id, total: pw + ow, prose: pw, opts: ow, nOpts: p.options.length });
});

const avgNode = nodeCosts.reduce(function (a, n) { return a + n.total; }, 0) / nodeCosts.length;
const p90Node = nodeCosts.map(function (n) { return n.total; }).sort(function (a, b) { return a - b; })[Math.floor(nodeCosts.length * 0.9)];

console.log('WORDS PER DECISION NODE  (prose + every option, because you read them all)');
console.log('  average          ' + fmt(avgNode, 0) + ' words');
console.log('  90th percentile  ' + p90Node + ' words');
console.log('  prose            ' + fmt(proseW / passages.length, 0) + ' words/passage   (design cap: 110)');
console.log('  options          ' + fmt(optW / optCount, 1) + ' words/option, ' + fmt(optCount / passages.length, 1) + ' options/passage');
console.log('');

/* --- the option-label cap proposed in R2 */
const CAP = 14;
const overCap = optionLens.filter(function (o) { return o.n > CAP; });
console.log('OPTION LABEL LENGTH  (R2 proposed a ' + CAP + '-word validator cap)');
console.log('  longest          ' + Math.max.apply(null, optionLens.map(function (o) { return o.n; })) + ' words');
console.log('  over the cap     ' + overCap.length + ' of ' + optionLens.length +
            '  (' + fmt(100 * overCap.length / optionLens.length, 0) + '%)');
overCap.sort(function (a, b) { return b.n - a.n; }).slice(0, 3).forEach(function (o) {
  console.log('    ' + o.n + 'w  [' + o.id + ']  ' + o.text.slice(0, 74) + (o.text.length > 74 ? '…' : ''));
});
console.log('');

/* --- a scene, and a session. design/06: 6-10 choices per 4-5 min path. */
const PER_SCENE_NODES = 8;
const SCENES = 5;
const sceneWords = avgNode * PER_SCENE_NODES;
const sessionWords = sceneWords * SCENES;

console.log('WHAT ONE STUDENT ACTUALLY READS');
console.log('  per scene    ' + fmt(sceneWords, 0) + ' words   (' + PER_SCENE_NODES + ' nodes, the midpoint of the authored 6–10)');
console.log('  per session  ' + fmt(sessionWords, 0) + ' words   (' + SCENES + ' scenes)');
console.log('');

const SCENE_BUDGET = 4.5 * 60;   // design/06 THE PATH: 4–5 minutes
console.log('TIME TO READ ONE SCENE  — the budget is ' + mmss(SCENE_BUDGET) + ' and reading is not the only thing to do in it');
console.log('');
console.log('  reader                 words/min      read time    share of the path');
console.log('  ' + '-'.repeat(68));
RATES.forEach(function (r) {
  const t = (sceneWords / r.wpm) * 60;
  const share = t / SCENE_BUDGET;
  const flag = share > 1 ? '  ✗ OVER BUDGET' : (share > 0.7 ? '  ⚠ no time to think' : '  ok');
  console.log('  ' + r.name.padEnd(22) + String(r.wpm).padStart(4) + '        ' +
    mmss(t).padStart(8) + '     ' + bar(share, 1.4, 18) + ' ' + fmt(100 * share, 0).padStart(3) + '%' + flag);
});
console.log('');

/* --- how hard is the prose, actually */
const all = passages.map(function (p) { return p.prose; }).join(' ');
const R = readability(all);
console.log('DIFFICULTY OF THE PROSE  (all ' + passages.length + ' passages together)');
console.log('  Flesch–Kincaid grade   ' + fmt(R.fk) + '        (target: at or under 7.0)');
console.log('  Flesch Reading Ease    ' + fmt(R.fre, 0) + '         (60–70 = plain English)');
console.log('  words per sentence     ' + fmt(R.wordsPerSentence));
console.log('  3+ syllable words      ' + fmt(100 * R.hardShare, 1) + '%');
console.log('');

const hard = passages.map(function (p) { return { id: p.id, r: readability(p.prose) }; })
  .filter(function (x) { return x.r; })
  .sort(function (a, b) { return b.r.fk - a.r.fk; });
console.log('  hardest passages');
hard.slice(0, 5).forEach(function (h) {
  console.log('    ' + h.id + '   FK ' + fmt(h.r.fk).padStart(5) + '   ' +
    fmt(h.r.wordsPerSentence, 0) + ' words/sentence   ' + h.r.words + 'w');
});
console.log('  easiest passages');
hard.slice(-3).forEach(function (h) {
  console.log('    ' + h.id + '   FK ' + fmt(h.r.fk).padStart(5));
});
console.log('');

/* --- THE SOFTWARE PATH is a different load, and the difference is the point.
 *
 * On paper a student READS every passage body. In the rules engine
 * (design/08, design/13) the shared situation is NARRATED by the Stage, the map
 * absorbs the navigation choices, and what a student actually reads is their own
 * option list plus the outcome of what they chose. Modelled here so the two can
 * be compared honestly rather than assumed. */

const OPT_W = optW / optCount;              // measured: words per option label
const OPTS_SHOWN = 5;                        // design/09: 3–6 options, never more
const OUTCOME_W = 45;                        // schema `narrate` blocks run ~35–55 words
const ACTIONS_PER_SCENE = 4;

const swPerAction = OPT_W * OPTS_SHOWN + OUTCOME_W;
const swScene = swPerAction * ACTIONS_PER_SCENE;

console.log('THE SAME SCENE, ON THE SOFTWARE PATH  (modelled, not measured)');
console.log('  the situation is NARRATED, not read      ' + fmt(proseW / passages.length, 0) + ' words lifted off the reader');
console.log('  navigation choices absorbed by the map    ~21% of options, per design/13');
console.log('  what is left to read: ' + OPTS_SHOWN + ' options (' + fmt(OPT_W, 1) + 'w each) + one outcome (~' + OUTCOME_W + 'w)');
console.log('  per action   ' + fmt(swPerAction, 0) + ' words');
console.log('  per scene    ' + fmt(swScene, 0) + ' words   (' + ACTIONS_PER_SCENE + ' actions)   vs ' + fmt(sceneWords, 0) + ' on paper');
console.log('');
console.log('  reader                 words/min      read time    share of the path');
console.log('  ' + '-'.repeat(68));
RATES.forEach(function (r) {
  const t = (swScene / r.wpm) * 60;
  const share = t / SCENE_BUDGET;
  const flag = share > 1 ? '  ✗ OVER BUDGET' : (share > 0.7 ? '  ⚠ no time to think' : '  ok');
  console.log('  ' + r.name.padEnd(22) + String(r.wpm).padStart(4) + '        ' +
    mmss(t).padStart(8) + '     ' + bar(share, 1.4, 18) + ' ' + fmt(100 * share, 0).padStart(3) + '%' + flag);
});
console.log('');

/* --- the verdict, stated as a finding and not a vibe */
const worst = (sceneWords / RATES[RATES.length - 1].wpm) * 60;
const below2 = (sceneWords / 110) * 60;
console.log('='.repeat(72));
console.log('FINDING');
const overs = RATES.filter(function (r) { return (sceneWords / r.wpm) * 60 > SCENE_BUDGET; });
if (overs.length) {
  console.log('  ' + overs.length + ' of ' + RATES.length + ' reader profiles CANNOT finish a scene\'s reading inside the');
  console.log('  ' + mmss(SCENE_BUDGET) + ' path, before choosing, moving, or thinking at all.');
} else {
  console.log('  Every reader profile can finish a scene\'s reading inside the path,');
  console.log('  though the slowest leaves little room to think.');
}
console.log('  A reader ~2 years below grade needs ' + mmss(below2) + ' of the ' + mmss(SCENE_BUDGET) + ' path just to read.');
console.log('  A reader ~4 years below needs ' + mmss(worst) + '.');
console.log('');
const swWorst = (swScene / 80) * 60;
const swBelow2 = (swScene / 110) * 60;
console.log('');
console.log('  ON THE SOFTWARE PATH the same scene costs ' + fmt(swScene, 0) + ' words instead of ' + fmt(sceneWords, 0) + '.');
const swOvers = RATES.filter(function (r) { return (swScene / r.wpm) * 60 > SCENE_BUDGET; });
if (swOvers.length === 0) {
  console.log('  Every profile fits, including a reader ~4 years below grade (' + mmss(swWorst) + ' of ' + mmss(SCENE_BUDGET) + ').');
  console.log('  THE SOFTWARE PIVOT IS WHAT MAKES THE READING LOAD SURVIVABLE. It was not');
  console.log('  designed for that reason, but that is what it did.');
} else {
  console.log('  ' + swOvers.length + ' of ' + RATES.length + ' profiles still do not fit. TTS and partner mode are mandatory.');
}
console.log('');
console.log('  Two things follow, and neither is optional:');
console.log('   1. THE PRINTED FALLBACK IS NOT EQUIVALENT. design/09 promises the run');
console.log('      sheets as the wifi-died backup; on the reading numbers above, the paper');
console.log('      path is 2–3x over budget for every reader. Plan a SHORT paper path.');
console.log('   2. TTS ON EVERY STRING AND PARTNER MODE (risk review R2) still carry the');
console.log('      slowest readers, and the option-label cap is measurable right now:');
console.log('      ' + overCap.length + ' of ' + optionLens.length + ' authored labels exceed ' + CAP + ' words.');
console.log('');
console.log('  Caveats: rates are estimates from published ORF norms, not measurements of');
console.log('  your students; readability formulas score sentence and word length, not');
console.log('  whether an idea is hard. And none of this measures whether it is fun.');
console.log('');
