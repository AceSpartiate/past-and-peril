/* check-content.mjs — the checks that keep the roster and the action pool
 * honest about each other.
 *
 *     node tools/check-content.mjs
 *
 * tools/check-maps.mjs validates the WORLD. This validates the PEOPLE and the
 * gates that point at them, which is a different class of mistake and one that
 * never throws an error at runtime — it just quietly makes content unreachable
 * or makes the same person exist twice.
 *
 * The rule this exists to enforce, first:
 *
 *   A PERSON IS EITHER SOMEBODY THE CLASS PLAYS OR SOMEBODY THE CLASS TALKS
 *   TO. NEVER BOTH.
 *
 * Andrew Ponton was on the roster as a playable CLERK *and* standing in the
 * square as the alcalde every student was walking over to petition. Nothing
 * broke. It was just two of him. */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTENT = path.join(HERE, '..', 'app', 'content');
const HexMap = (await import('../app/js/hexmap.js')).default ||
               (await import('../app/js/hexmap.js'));

const read = (f) => JSON.parse(fs.readFileSync(path.join(CONTENT, f), 'utf8'));
const terrain = read('terrain.json');
const roster = read('roster-s1.json');
const scenes = fs.readdirSync(CONTENT).filter((f) => /^scene-/.test(f)).map((f) => ({ f, d: read(f) }));
const common = read('actions-common.json');
const maps = {};
fs.readdirSync(CONTENT).filter((f) => /^map-.*\.json$/.test(f))
  .forEach((f) => { const d = read(f); maps[d.id] = HexMap.make(HexMap.hydrate(d, terrain)); });

let errors = 0, warns = 0;
const err = (m) => { console.log('  ERROR  ' + m); errors++; };
const warn = (m) => { console.log('  warn   ' + m); warns++; };

const people = roster.roster || [];
console.log('\nCONTENT — ' + people.length + ' playable people, ' + scenes.length + ' scenes\n');

/* ---- 1. NOBODY IS BOTH PLAYABLE AND AN NPC -------------------------- */
const npcs = {};
scenes.forEach(({ d }) => (d.npcs || []).forEach((n) => {
  (npcs[n.id] = npcs[n.id] || { name: n.name, scenes: [] }).scenes.push(d.id);
}));

const words = (s) => String(s).toLowerCase().replace(/[^a-z ]/g, '').split(' ').filter((w) => w.length > 2);
people.forEach((p) => {
  const pw = words(p.name);
  const surname = pw[pw.length - 1];
  if (!surname) return;
  Object.keys(npcs).forEach((id) => {
    if (words(npcs[id].name).indexOf(surname) === -1) return;
    err('DOUBLE DIP: "' + p.name + '" (' + p.id + ', playable) is also ' + id +
        ' "' + npcs[id].name + '" in ' + npcs[id].scenes.join(' ') +
        ' — pick one. A person the class plays cannot also be a person the class walks over to.');
  });
});

/* ---- 2. every gate points at something that exists ------------------ */
const CALLINGS = {}, ORIGINS = {}, MARKS = {}, ROLES = {};
people.forEach((p) => {
  CALLINGS[p.calling] = (CALLINGS[p.calling] || 0) + 1;
  ORIGINS[p.origin] = (ORIGINS[p.origin] || 0) + 1;
  MARKS[p.mark] = (MARKS[p.mark] || 0) + 1;
  ROLES[p.role] = (ROLES[p.role] || 0) + 1;
});

const allActions = scenes.map(({ f, d }) => ({ where: d.id, file: f, map: d.map, npcs: d.npcs || [], list: d.actions || [] }))
  .concat([{ where: 'COMMON', file: 'actions-common.json', map: null, npcs: null, list: common.actions || [] }]);

allActions.forEach(({ where, list, map, npcs: sceneNpcs }) => {
  list.forEach((a) => {
    const r = a.requires || {};

    if (r.adjacent_npc) {
      if (!sceneNpcs) {
        warn(where + ' ' + a.id + ': adjacent_npc in a shared action — it cannot know which NPCs a scene has');
      } else if (!sceneNpcs.some((n) => n.id === r.adjacent_npc)) {
        err(where + ' ' + a.id + ': needs ' + r.adjacent_npc + ', who is NOT in this scene. The action can never be offered.');
      }
    }

    if (r.adjacent_calling) {
      const n = r.adjacent_calling.reduce((s, c) => s + (CALLINGS[c] || 0), 0);
      if (!n) err(where + ' ' + a.id + ': needs a neighbour whose Calling is ' +
                  r.adjacent_calling.join('/') + ', and NOBODY on the roster has it.');
      else if (n < 2) warn(where + ' ' + a.id + ': only ' + n + ' person on the roster is ' +
                  r.adjacent_calling.join('/') + ' — if they are absent this action is dead');
    }

    if (r.adjacent_hex && map && maps[map]) {
      const m = maps[map];
      const h = m.parse(r.adjacent_hex);
      if (!h || !m.terrain(h.c, h.r)) {
        err(where + ' ' + a.id + ': adjacent_hex ' + r.adjacent_hex + ' is not a hex on ' + map);
      }
    }

    if (r.hex_in && map && maps[map]) {
      const m = maps[map];
      const bad = r.hex_in.filter((hx) => {
        const h = m.parse(hx);
        const t = h && m.terrain(h.c, h.r);
        return !t || t.cost === null;
      });
      if (bad.length === r.hex_in.length) {
        err(where + ' ' + a.id + ': EVERY hex in hex_in is unstandable on ' + map + ' — ' + bad.join(' '));
      } else if (bad.length) {
        warn(where + ' ' + a.id + ': hex_in lists ' + bad.length + ' hex(es) nobody can stand on — ' + bad.join(' '));
      }
    }

    ['calling', 'origin', 'mark', 'role'].forEach((k) => {
      if (!r[k]) return;
      const table = { calling: CALLINGS, origin: ORIGINS, mark: MARKS, role: ROLES }[k];
      const n = r[k].reduce((s, v) => s + (table[v] || 0), 0);
      if (!n) err(where + ' ' + a.id + ': requires ' + k + ' ' + r[k].join('/') +
                  ', and nobody on the roster is that. Dead content.');
      else if (n === 1) warn(where + ' ' + a.id + ': only one person qualifies (' + k + ' ' + r[k].join('/') + ')');
    });
  });
});

/* ---- 3. every NPC is standing somewhere, and is used ---------------- */
Object.keys(npcs).forEach((id) => {
  const used = allActions.some(({ list }) => list.some((a) => (a.requires || {}).adjacent_npc === id));
  if (!used) warn(id + ' (' + npcs[id].name + ') is drawn on the map but no action needs them — that is fine if they are scenery');
});

/* ---- 4. one person, one slot --------------------------------------- */
const seenId = {}, seenName = {}, seenHex = {};
people.forEach((p) => {
  if (seenId[p.id]) err('two roster entries share the id ' + p.id);
  seenId[p.id] = true;
  if (seenName[p.name]) err('two roster entries are both named "' + p.name + '"');
  seenName[p.name] = true;
  (seenHex[p.startHex] = seenHex[p.startHex] || []).push(p.id);
});
Object.keys(seenHex).forEach((hx) => {
  if (seenHex[hx].length > 1) {
    warn(seenHex[hx].length + ' people start on ' + hx + ' (' + seenHex[hx].join(' ') +
         ') — they will stack until somebody moves');
  }
});

/* ---- 4b. THE APP ROSTER AND THE PAPER DECK MUST AGREE --------------- */
const deckPath = path.join(HERE, '..', 'player-materials', 'person-cards-gonzales.md');
if (fs.existsSync(deckPath)) {
  const md = fs.readFileSync(deckPath, 'utf8');
  const deck = {};
  const re = /^### (.+)$/gm;
  let m;
  while ((m = re.exec(md))) {
    const name = m[1].trim();
    const card = md.slice(m.index, m.index + 500);
    const line = (card.match(/\*\*Calling:\*\*([^\n]*)/) || [])[1] || '';
    const cal = (line.match(/\s*([A-Za-z]+)/) || [])[1];
    if (deck[name]) err('the paper deck has TWO cards for "' + name + '" — pick one');
    deck[name] = cal
      ? { calling: cal.toUpperCase(), fixed: /FIXED/.test(line), note: line.trim() }
      : null;
  }
  const noCard = [], contradicts = [], chosen = [];
  people.forEach((p) => {
    if (!deck.hasOwnProperty(p.name)) { noCard.push(p.name); return; }
    const d = deck[p.name];
    if (!d || d.calling === p.calling) return;
    (d.fixed ? contradicts : chosen).push(
      p.name + ': app ' + p.calling + ' vs card ' + d.note);
  });
  console.log('  cross-checked ' + people.length + ' app characters against ' +
              Object.keys(deck).length + ' paper cards');
  /* the ones that matter: the card calls it FIXED and the app disagrees */
  if (contradicts.length) {
    err(contradicts.length + ' character(s) CONTRADICT a Calling their card marks FIXED. ' +
        'The card carries the research, so the app is asserting something the research does ' +
        'not support:');
    contradicts.forEach((d) => console.log('           ' + d));
  }
  /* the ones that do not: the card says OPEN and invites a choice */
  if (chosen.length) {
    console.log('  note   ' + chosen.length + ' character(s) differ from a Calling their card ' +
                'marks OPEN — that is the card inviting a choice, and the app has made one:');
    chosen.forEach((d) => console.log('           ' + d));
  }
  if (noCard.length) {
    warn(noCard.length + ' playable character(s) have NO paper card, so a student gets a ' +
         'name with no sheet: ' + noCard.join(', '));
  }
}

/* ---- 4b. LOOT: the rules that have to be code, not a promise -------- */
{
  /* HORIZONTAL PROGRESSION ONLY. effect.stat is the one thing that reached
   * the dice, and it is the reason this check exists at all rather than a
   * sentence in a design document. */
  /* read the raw JSON, not the hydrated HexMap — items live on the document */
  const items = [];
  fs.readdirSync(CONTENT).filter((f) => /^map-.*.json$/.test(f)).forEach((f) => {
    (read(f).items || []).forEach((it) => items.push({ map: f, it }));
  });
  const withStat = items.filter(({ it }) => it.effect && it.effect.stat);
  if (withStat.length) {
    err(withStat.length + ' item(s) declare effect.stat, which reaches 2d6 and collapses the ' +
        'three tiers by session five: ' + withStat.map(({ it }) => it.id).join(', '));
  }
  const bigMove = items.filter(({ it }) => it.effect && (it.effect.move || 0) > 2);
  if (bigMove.length) err('effect.move is capped at +2: ' + bigMove.map(({ it }) => it.id).join(', '));
  const movers = items.filter(({ it }) => it.effect && it.effect.move);
  if (movers.length > 2) {
    warn(movers.length + ' items carry effect.move; the design allows two: ' +
         movers.map(({ it }) => it.id).join(', '));
  }

  /* AN ITEM-GATED ACTION THAT ONLY AUTHORS `strong` SILENTLY DOES NOTHING on
   * the other two tiers — resolve() returns outs[tier] || outs.all || {} — and
   * the student has burned their once-per-scene use. A drop that fails 58% of
   * the time teaches a twelve-year-old that the loot is fake. */
  const known = {};
  items.forEach(({ it }) => { known[it.id] = true; });
  let gated = 0;
  allActions.forEach(({ where, list }) => list.forEach((a) => {
    const need = (a.requires || {}).item;
    if (!need) return;
    gated++;
    need.forEach((id) => { if (!known[id]) err(where + ' ' + a.id + ' requires unknown item ' + id); });
    const o = a.outcomes || {};
    const ok = o.all || (o.strong && o.partial && o.weak);
    if (!ok) {
      err(where + ' ' + a.id + ' is item-gated but authors neither outcomes.all nor all ' +
          'three tiers, so it does nothing on the tiers it skipped and the student ' +
          'has spent their use');
    }
  }));
  console.log('  ' + items.length + ' items, ' + gated + ' item-gated action(s); no item touches a die roll');
}

/* ---- 5. the Callings that Calling-gated actions assume -------------- */
const gatedCallings = {};
allActions.forEach(({ list }) => list.forEach((a) => {
  ((a.requires || {}).calling || []).forEach((c) => { gatedCallings[c] = (gatedCallings[c] || 0) + 1; });
}));
console.log('  Callings on the roster: ' +
  Object.keys(CALLINGS).sort().map((c) => c + ' ' + CALLINGS[c]).join(' · '));
const unused = Object.keys(CALLINGS).filter((c) => !gatedCallings[c]);
if (unused.length) warn('no action is gated to ' + unused.join(', ') + ' — those students have no moment of their own');

console.log('\n  ' + errors + ' error(s), ' + warns + ' warning(s)\n');
process.exitCode = errors ? 1 : 0;
