/* check-maps.mjs — the map validator design/11-map-data.md asked for.
 *
 *     node tools/check-maps.mjs
 *
 * A map is eleven lines of ASCII, which is the whole point — a teacher can
 * redraw the town in a text editor. The cost of that is that a map can be
 * wrong in ways no type system will catch: a row one character short, a
 * landmark on a hex that is solid rock, a door into a place that does not
 * exist, a room nobody can walk to.
 *
 * The last one is the reason this file is not optional. An interior whose
 * hearth is walled off looks perfectly fine in the JSON and perfectly fine on
 * screen, and a student discovers it by walking at a wall for four minutes. */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTENT = path.join(HERE, '..', 'app', 'content');
const HexMap = (await import('../app/js/hexmap.js')).default ||
               (await import('../app/js/hexmap.js'));

const terrain = JSON.parse(fs.readFileSync(path.join(CONTENT, 'terrain.json'), 'utf8'));
const files = fs.readdirSync(CONTENT).filter((f) => /^map-.*\.json$/.test(f)).sort();
const docs = files.map((f) => JSON.parse(fs.readFileSync(path.join(CONTENT, f), 'utf8')));
const byId = {};
docs.forEach((d) => { byId[d.id] = d; });

let errors = 0, warns = 0;
const err = (m) => { console.log('  ERROR  ' + m); errors++; };
const warn = (m) => { console.log('  warn   ' + m); warns++; };

console.log('\nMAPS — ' + files.length + ' places\n');

docs.forEach((doc, di) => {
  const file = files[di];
  const map = HexMap.make(HexMap.hydrate(doc, terrain));
  const L = HexMap.LETTERS;
  console.log(String(doc.cols).padStart(3) + ' x ' + String(doc.rows).padEnd(3) +
    ' ' + (doc.indoors ? 'in  ' : 'out ') + doc.id.padEnd(18) + file);

  /* ---- 1. the grid is the shape it claims to be */
  if (doc.grid.length !== doc.rows) err(doc.id + ': ' + doc.grid.length + ' rows, declares ' + doc.rows);
  doc.grid.forEach((row, r) => {
    if (row.length !== doc.cols) {
      err(doc.id + ' row ' + (r + 1) + ': ' + row.length + ' chars, declares ' + doc.cols + '  |' + row + '|');
    }
  });
  if (doc.cols > L.length) err(doc.id + ': ' + doc.cols + ' columns but only ' + L.length + ' column letters exist');

  /* ---- 2. every glyph is in the legend */
  const unknown = {};
  for (let r = 0; r < doc.rows; r++) {
    for (let c = 0; c < doc.cols; c++) {
      const g = map.glyph(c, r);
      if (g !== null && !map.legend[g]) unknown[g] = (unknown[g] || 0) + 1;
    }
  }
  Object.keys(unknown).forEach((g) => err(doc.id + ': glyph "' + g + '" is not in the legend (' + unknown[g] + ' hexes)'));

  /* ---- 3. landmarks and features stand somewhere real */
  const check = (what, hex, extra) => {
    const h = map.parse(hex);
    if (!h) return err(doc.id + ': ' + what + ' on "' + hex + '", which is not a hex label');
    if (h.c >= doc.cols || h.r >= doc.rows) return err(doc.id + ': ' + what + ' on ' + hex + ', off the grid');
    const t = map.terrain(h.c, h.r);
    if (!t) return err(doc.id + ': ' + what + ' on ' + hex + ', which has no terrain');
    if (t.cost === null && !extra) warn(doc.id + ': ' + what + ' on ' + hex + ' (' + t.name + ') — nobody can stand there');
    return t;
  };
  (doc.landmarks || []).forEach((l) => check('landmark "' + l.label + '"', l.hex));
  (doc.features || []).forEach((f) => {
    check('feature ' + f.id, f.hex);
    if (f.to) {
      if (!byId[f.to.place]) err(doc.id + ': ' + f.id + ' opens onto place "' + f.to.place + '", which does not exist');
      else {
        const dest = HexMap.make(HexMap.hydrate(byId[f.to.place], terrain));
        const dh = dest.parse(f.to.hex);
        if (!dh || !dest.terrain(dh.c, dh.r)) {
          err(doc.id + ': ' + f.id + ' lands on ' + f.to.hex + ' of ' + f.to.place + ', which is not standable');
        }
        /* A way in with no way back is a trap. */
        const back = (byId[f.to.place].features || [])
          .some((g) => g.to && g.to.place === doc.id);
        if (!back) err(doc.id + ': ' + f.id + ' leads into ' + f.to.place + ' and NOTHING LEADS BACK OUT');
      }
    }
    (f.contents || []).forEach((it) => {
      const found = docs.some((d) => (d.items || []).some((i) => i.id === it));
      if (!found) err(doc.id + ': ' + f.id + ' contains "' + it + '", which no map defines');
    });
  });

  /* ---- 4. CAN YOU ACTUALLY GET THERE?
   * Flood-fill from the entry (or from the first standable hex outdoors) and
   * report anything standable that the fill never reaches. */
  const start = doc.entry ? map.parse(doc.entry) : (() => {
    for (let r = 0; r < doc.rows; r++) for (let c = 0; c < doc.cols; c++) {
      const t = map.terrain(c, r);
      if (t && t.cost !== null) return { c, r };
    }
    return null;
  })();
  if (doc.indoors && !doc.entry) warn(doc.id + ': an interior with no "entry" hex');
  if (start) {
    const seen = new Set([start.c + ',' + start.r]);
    const q = [start];
    while (q.length) {
      const cur = q.pop();
      map.neighbours(cur.c, cur.r).forEach((n) => {
        const t = map.terrain(n.c, n.r);
        if (!t || t.cost === null) return;
        const k = n.c + ',' + n.r;
        if (seen.has(k)) return;
        seen.add(k);
        q.push(n);
      });
    }
    let stranded = [];
    for (let r = 0; r < doc.rows; r++) for (let c = 0; c < doc.cols; c++) {
      const t = map.terrain(c, r);
      if (t && t.cost !== null && !seen.has(c + ',' + r)) stranded.push(map.label(c, r));
    }
    if (stranded.length) {
      err(doc.id + ': ' + stranded.length + ' hex(es) nobody can walk to from ' +
          map.label(start.c, start.r) + ' — ' + stranded.slice(0, 12).join(' ') +
          (stranded.length > 12 ? ' …' : ''));
    }
  }

  /* ---- 5. is the key readable? */
  const used = map.legendUsed();
  const noAbout = used.filter((t) => !t.about);
  if (noAbout.length) warn(doc.id + ': no plain-words description for ' + noAbout.map((t) => t.name).join(', '));
  if (used.length > 14) warn(doc.id + ': ' + used.length + ' terrain types on one map — the key gets long');
});

/* ---- 6. every place a scene names must exist */
const scenes = fs.readdirSync(CONTENT).filter((f) => /^scene-/.test(f))
  .map((f) => ({ f, d: JSON.parse(fs.readFileSync(path.join(CONTENT, f), 'utf8')) }));
console.log('');
scenes.forEach(({ f, d }) => {
  if (!d.map) warn(f + ': scene ' + d.id + ' names no map');
  else if (!byId[d.map]) err(f + ': scene ' + d.id + ' is set on "' + d.map + '", which does not exist');
  if (!d.time) warn(f + ': scene ' + d.id + ' has no time of day — the map will render at MIDDAY');
  else if (!terrain.light[d.time]) err(f + ': scene ' + d.id + ' time "' + d.time + '" is not in terrain.json');
  if (d.weather && !terrain.weather[d.weather]) err(f + ': weather "' + d.weather + '" is not in terrain.json');
  (d.npcs || []).forEach((n) => {
    const place = n.place || d.map;
    const doc = byId[place];
    if (!doc) return;
    const m = HexMap.make(HexMap.hydrate(doc, terrain));
    const h = m.parse(n.hex);
    if (!h || !m.terrain(h.c, h.r)) err(f + ': ' + n.id + ' stands on ' + n.hex + ' of ' + place + ', which is not a hex');
    else if (m.terrain(h.c, h.r).cost === null) err(f + ': ' + n.id + ' stands inside a wall at ' + n.hex);
  });
});

console.log('\n  ' + errors + ' error(s), ' + warns + ' warning(s)\n');
process.exitCode = errors ? 1 : 0;
