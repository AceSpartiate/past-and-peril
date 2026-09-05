/* people.js — the person cards, on the screen instead of on card stock.
 *
 * player-materials/person-cards-gonzales.md is a research deck: sixty-two real
 * people of Gonzales in autumn 1835, each with what the historical record says
 * about them and — the part that matters most in a history classroom — what it
 * does not.
 *
 * A student playing Almeron Dickinson should be able to read that he moved to
 * Texas in early 1831, after the Law of April 6 1830, which makes his land
 * title legally shaky. And they should be able to read that what he thought
 * about his own uncertain claim is not recorded. The second sentence teaches
 * something the first cannot.
 *
 * ---------------------------------------------------------------------------
 * THE TEACHER-ONLY SECTIONS ARE NOT OPTIONAL TO EXCLUDE
 *
 * The deck opens with three sections headed with a warning sign, one of which
 * says, in the file itself:
 *
 *     ## ⚠ TWO NOTES FOR THE TEACHER ONLY — do not put these on cards
 *
 * That is an instruction from the person who wrote it, about their own
 * material, and it is obeyed here rather than interpreted. Everything from a
 * `## ⚠` heading until the next `##` is dropped before anything is served, and
 * a card that somehow appears inside such a section is dropped with it.
 * tools/check-people.mjs asserts none of that text can reach a student.
 *
 * ---------------------------------------------------------------------------
 * MATCHING CARDS TO CHARACTERS
 *
 * Sixty-two cards, thirty playable characters, and the names do not agree
 * exactly — the deck says "John Newton Sowell, Sr." where the roster says
 * "John N. Sowell". Matching is on first name plus last name, with accents,
 * punctuation and generational suffixes normalised away.
 *
 * That is a heuristic, so it reports what it could not match rather than
 * failing quietly. Five characters currently have no card; they get the app's
 * own description and no research panel, which is honest.
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('./markdown.js');

const FILES = [
  path.join(__dirname, '..', 'player-materials', 'person-cards-gonzales.md'),
  path.join(__dirname, '..', 'player-materials', 'person-cards-latecomers.md'),
];

/* first + last, accent- and suffix-insensitive */
function nameKey(s) {
  const n = String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z ]/g, ' ')
    .replace(/\b(sr|jr|ii|iii|iv)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = n.split(' ').filter(Boolean);
  if (!parts.length) return '';
  return parts[0] + ' ' + parts[parts.length - 1];
}

/* Drop every `## ⚠ …` section, from its heading to the next `##` at the same
 * level or above. Done on the raw text before parsing, so no teacher-only line
 * ever becomes a block that something downstream might forget to filter. */
function stripTeacherOnly(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let skipping = false;
  lines.forEach((line) => {
    if (/^##\s*⚠/.test(line)) { skipping = true; return; }
    /* ANY heading ends the warning section, including a `### Name` card.
     *
     * This was `^#{1,2}\s` and it ate six cards. The last warning section is
     * followed directly by Company 1's six people with no `##` in between, so
     * skipping ran straight through Dickinson, Lockhart, Kerr, Williams and
     * both Sowells — and the match rate quietly dropped from 25 to 21 with no
     * error anywhere.
     *
     * Verified safe rather than assumed: the three warning sections contain no
     * `###` headings of their own, so nothing inside one can end it early.
     * tools/check-people.mjs re-checks that every time it runs. */
    if (skipping && /^#{1,6}\s/.test(line)) skipping = false;
    if (!skipping) out.push(line);
  });
  return out.join('\n');
}

/* DROP THE CARD'S OWN METADATA LINE.
 *
 * Every card opens with a run-on header: "Age in 1835: ~24 · Company: 3 ·
 * Role: The Farrier · Calling: Householder — OPEN · Origin: …".
 *
 * The app already shows role, calling and company, from the roster, in the
 * panel directly above this one. And for six characters the two DISAGREE —
 * tools/check-content.mjs has reported that for a while and it is a content
 * decision nobody has made yet. Putting the deck's version on screen beside
 * the app's turns an open question into a student reading two different
 * answers and asking which is right.
 *
 * So each source does what it is good at. The roster is authoritative for who
 * you are IN THE GAME. The deck is authoritative for the BIOGRAPHY — what the
 * record says and what it does not — which is the half that exists nowhere
 * else, and the whole reason to put these on a screen.
 *
 * This is a display decision, not a fix. The disagreement is still there and
 * check-content.mjs still reports it. */
function isBiography(b) {
  if (b.type !== 'p') return true;
  const flat = (b.runs || []).map((r) => r.t).join('').trim();
  return !/^(Age in \d{4}|Company|Role|Calling|Origin)\s*:/i.test(flat);
}

let cache = null;

function load() {
  if (cache) return cache;
  cache = { byKey: {}, count: 0, dropped: 0 };

  FILES.forEach((file) => {
    let md = '';
    try { md = fs.readFileSync(file, 'utf8'); } catch (e) { return; }

    const before = (md.match(/^### /gm) || []).length;
    const clean = stripTeacherOnly(md);
    const after = (clean.match(/^### /gm) || []).length;
    cache.dropped += before - after;

    /* Split on `### Name`, which is one card each. */
    const chunks = clean.split(/^### /m).slice(1);
    chunks.forEach((chunk) => {
      const nl = chunk.indexOf('\n');
      const name = (nl === -1 ? chunk : chunk.slice(0, nl)).trim();
      if (!name) return;
      /* a card runs to the horizontal rule that separates it from the next */
      const body = (nl === -1 ? '' : chunk.slice(nl + 1)).replace(/\n-{3,}\s*$/, '');
      const blocks = parse(body).filter(isBiography);
      const key = nameKey(name);
      if (!key || cache.byKey[key]) return;         // first card wins
      cache.byKey[key] = { name: name, blocks: blocks };
      cache.count += 1;
    });
  });
  return cache;
}

/* THE BAKED CARDS.
 *
 * player-materials/ is deliberately absent from the repository and from the
 * release — it carries each character's own secret, and publishing it would let
 * every student read every other student's. So on any machine but this one the
 * markdown above is simply not there, and this file was silently serving zero
 * cards with nothing to indicate it.
 *
 * app/content/person-cards.json is the student-safe half, baked out by
 * tools/build-person-cards.mjs at release time — already stripped of the
 * teacher-only sections and of the metadata header that contradicts the roster.
 * The markdown wins when it is present, so editing the deck on the authoring
 * machine still takes effect immediately. */
let baked = null;
function bakedCards() {
  if (baked !== null) return baked;
  try {
    const p = path.join(__dirname, '..', 'app', 'content', 'person-cards.json');
    baked = JSON.parse(fs.readFileSync(p, 'utf8')).cards || {};
  } catch (e) { baked = {}; }
  return baked;
}

module.exports = {
  /* The card for a roster character. `id` lets the baked file be used, which is
   * keyed by roster id; `name` drives the name matching against the markdown.
   * null when there is none — five characters are in that position, and the
   * client shows the app's own description instead. */
  forName(name, id) {
    const c = load();
    const k = nameKey(name);
    const fromDeck = (k && c.byKey[k]) || null;
    if (fromDeck) return fromDeck;
    return (id && bakedCards()[id]) || null;
  },

  /* for tools/check-people.mjs */
  _stats() { const c = load(); return { cards: c.count, droppedFromTeacherSections: c.dropped }; },
  _keys() { return Object.keys(load().byKey); },
  _nameKey: nameKey,
  _strip: stripTeacherOnly,
};
