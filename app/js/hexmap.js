/* hexmap.js — the world, shared by the Stage and the student client.
 *
 * Implements design/11-map-data.md: pointy-top hexes, odd-r offset for the
 * labels a human types (G6), axial coordinates for the maths. One module so the
 * projector's omniscient view and a student's fogged view can never disagree
 * about where anything is.
 *
 * TWO THINGS THIS FILE IS CAREFUL ABOUT
 *
 * 1. A HEX GRID IS NOT A MAP. A coloured tile tells a twelve-year-old nothing.
 *    So terrain is DRAWN — grass has blades, a ploughed field has furrows, a
 *    road is one continuous rutted ribbon rather than eleven brown lozenges,
 *    timber has canopies that cast shadows. The scatter is hashed from the hex
 *    coordinate (see rnd), so it is pixel-identical on thirty Chromebooks and
 *    does not crawl when the canvas redraws four times a second.
 *
 * 2. PLACES ARE INDEPENDENT. A map is a PLACE — the town, a house, a forge,
 *    Béxar. Every student stands in exactly one, and two students in different
 *    places see different worlds on their own screens at the same instant. The
 *    renderer does not know or care which; it is handed one map and draws it.
 */

const HexMap = (function () {
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  /* ------------------------------------------------------------------ data */

  /* Maps are authored as ASCII grids against the MASTER legend in
   * content/terrain.json, so a new map is eleven lines of text and not a
   * colour scheme. A map may override a single glyph locally; it almost never
   * needs to. */
  function hydrate(doc, terrain) {
    const legend = {};
    if (terrain && terrain.legend) {
      Object.keys(terrain.legend).forEach((k) => { legend[k] = terrain.legend[k]; });
    }
    Object.keys(doc.legend || {}).forEach((k) => {
      legend[k] = Object.assign({}, legend[k] || {}, doc.legend[k]);
    });
    const out = Object.assign({}, doc, { legend: legend });
    out.lightTable = (terrain && terrain.light) || {};
    out.weatherTable = (terrain && terrain.weather) || {};
    return out;
  }

  function make(data) {
    const cols = data.cols, rows = data.rows;
    const legend = data.legend;

    function glyph(c, r) {
      if (c < 0 || r < 0 || c >= cols || r >= rows) return null;
      const row = data.grid[r];
      if (row === undefined || c >= row.length) return null;
      return row[c];
    }
    function terrain(c, r) {
      const g = glyph(c, r);
      return g === null ? null : (legend[g] || null);
    }
    function label(c, r) { return LETTERS[c] + (r + 1); }
    function parse(lab) {
      if (!lab) return null;
      const c = LETTERS.indexOf(String(lab)[0].toUpperCase());
      const r = parseInt(String(lab).slice(1), 10) - 1;
      if (c < 0 || isNaN(r)) return null;
      return { c: c, r: r };
    }

    /* odd-r offset neighbours. The row parity shifts which diagonals you get,
     * and getting this wrong is the classic hex bug. */
    function neighbours(c, r) {
      const odd = (r % 2) === 1;
      const d = odd
        ? [[+1, 0], [0, -1], [-1, 0], [0, +1], [+1, -1], [+1, +1]]
        : [[+1, 0], [-1, -1], [-1, 0], [-1, +1], [0, -1], [0, +1]];
      const out = [];
      d.forEach(function (o) {
        const nc = c + o[0], nr = r + o[1];
        if (nc >= 0 && nr >= 0 && nc < cols && nr < rows) out.push({ c: nc, r: nr });
      });
      return out;
    }

    /* Features sit ON the ground: a door that can open, a chest that can be
     * emptied, the cannon, the way into a building. Looked up by hex, and they
     * change during play. */
    const featureIndex = {};
    (data.features || []).forEach((f) => { (featureIndex[f.hex] = featureIndex[f.hex] || []).push(f); });
    function featuresAt(lab) { return featureIndex[lab] || []; }
    function feature(id) { return (data.features || []).filter((f) => f.id === id)[0] || null; }
    function itemsById(id) { return (data.items || []).filter((i) => i.id === id)[0] || null; }

    /* A shut door stops you. An open one does not. Checked on the hex you are
     * trying to ENTER, so a closed door makes the room behind it genuinely
     * unreachable rather than merely expensive. */
    function passable(lab) {
      const doors = featuresAt(lab).filter((f) => f.kind === 'door');
      if (doors.length && doors.some((d) => !d.open)) return false;
      return true;
    }

    /* A PORTAL is a door that goes somewhere else — into a house, back out to
     * the street. Standing on one is what lets a student change place. */
    function portalAt(lab) {
      return featuresAt(lab).filter((f) => f.to && f.to.place)[0] || null;
    }

    /* Dijkstra out to a movement budget, with occupancy and doors.
     *
     *   · you may not END on a hex somebody is standing on
     *   · you may not PASS THROUGH one either — so a doorway held by two
     *     people is genuinely held, and a route has to be clear, not merely
     *     short. That is the difference between a map and a menu of hexes. */
    /* One Dijkstra, two questions.
     *
     * `reachable` answers "where may I go", which is what the server enforces.
     * `pathTo` answers "and by which route", which is what the SCREEN needs —
     * a teacher playing this reported that students could "teleport all over
     * the map", and the cause was not the rule (measured: every out-of-range
     * hex is refused) but the presentation. Tapping a hex three steps away
     * moved the token there instantly with no route shown, so a legal walk
     * looked like a teleport. You cannot draw a route you did not record, so
     * the predecessor map now comes out of the search. */
    function _search(from, points, opts) {
      opts = opts || {};
      const start = typeof from === 'string' ? parse(from) : from;
      if (!start) return { dist: {}, prev: {}, start: null };
      const blocked = {};
      (opts.occupied || []).forEach((h) => { blocked[h] = true; });
      const key = function (p) { return p.c + ',' + p.r; };
      const dist = {};
      const prev = {};
      dist[key(start)] = 0;
      const queue = [{ c: start.c, r: start.r, d: 0 }];
      while (queue.length) {
        queue.sort(function (a, b) { return a.d - b.d; });
        const cur = queue.shift();
        if (cur.d > (dist[key(cur)] === undefined ? Infinity : dist[key(cur)])) continue;
        neighbours(cur.c, cur.r).forEach(function (n) {
          const t = terrain(n.c, n.r);
          if (!t || t.cost === null || t.cost === undefined) return;
          const lab = label(n.c, n.r);
          if (blocked[lab]) return;                 // somebody is standing there
          if (!passable(lab)) return;               // the door is shut
          let cost = t.cost;
          if (opts.cheapTerrain && opts.cheapTerrain.indexOf(t.name) !== -1) cost = 1;
          const nd = cur.d + cost;
          if (nd > points) return;
          const k = key(n);
          if (dist[k] === undefined || nd < dist[k]) {
            dist[k] = nd;
            prev[k] = key(cur);
            queue.push({ c: n.c, r: n.r, d: nd });
          }
        });
      }
      return { dist: dist, prev: prev, start: key(start) };
    }

    function reachable(from, points, opts) {
      const s = _search(from, points, opts);
      const dist = s.dist;
      /* The hex you are standing on is not somewhere you can "go", and every
       * caller treats a key in here as a legal destination. */
      if (s.start) delete dist[s.start];
      return dist;
    }

    /* The cheapest walk from `from` to `to`, as hex labels INCLUDING the hex
     * you start on, so a caller can draw a line from under the player's feet.
     * null when it cannot be reached inside the budget. */
    function pathTo(from, to, points, opts) {
      const s = _search(from, points, opts);
      const t = typeof to === 'string' ? parse(to) : to;
      if (!t || !s.start) return null;
      let k = t.c + ',' + t.r;
      if (s.dist[k] === undefined) return null;
      const out = [];
      let guard = 0;
      while (k !== undefined && guard < 500) {
        const bits = k.split(',');
        out.unshift(label(Number(bits[0]), Number(bits[1])));
        if (k === s.start) break;
        k = s.prev[k];
        guard += 1;
      }
      return out;
    }

    function landmarkAt(lab) {
      return (data.landmarks || []).filter(function (l) { return l.hex === lab; })[0] || null;
    }

    /* THE MAP KEY, computed rather than written.
     *
     * A key that lists twenty-eight terrain types when this map has nine is
     * worse than no key. So the panel is built from the glyphs THIS map
     * actually contains, in the order a student meets them. */
    function legendUsed() {
      const seen = {};
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const g = glyph(c, r);
          if (g !== null && legend[g]) seen[g] = (seen[g] || 0) + 1;
        }
      }
      return Object.keys(seen).map(function (g) {
        return Object.assign({ glyph: g, hexes: seen[g] }, legend[g]);
      }).sort(function (a, b) {
        const ac = a.cost === null ? 99 : a.cost, bc = b.cost === null ? 99 : b.cost;
        return ac - bc || b.hexes - a.hexes || a.name.localeCompare(b.name);
      });
    }
    function featureKinds() {
      const seen = {};
      (data.features || []).forEach((f) => { seen[f.kind] = true; });
      return Object.keys(seen);
    }

    return {
      data: data, id: data.id, title: data.title,
      indoors: !!data.indoors, parent: data.parent || null,
      cols: cols, rows: rows, legend: legend,
      glyph: glyph, terrain: terrain, label: label, parse: parse,
      neighbours: neighbours, reachable: reachable, pathTo: pathTo, landmarkAt: landmarkAt,
      landmarks: data.landmarks || [],
      features: data.features || [], items: data.items || [],
      featuresAt: featuresAt, feature: feature, item: itemsById,
      passable: passable, portalAt: portalAt,
      legendUsed: legendUsed, featureKinds: featureKinds,
    };
  }

  /* ---------------------------------------------------------------- render */

  /* ------------------------------------------------------------ FIGURINES
   *
   * A student's token used to be a filled circle in their COMPANY's colour.
   * All five members of a company share that colour, so a full class put four
   * identical dots on the board for each of six colours. A teacher playing it
   * said students could not see where other players were; the tokens were
   * perfectly visible, and there was no way to tell whose was whose.
   *
   * So a token is now a standing figure, and it carries three separate
   * channels of identity:
   *
   *   SHAPE   the silhouette differs by Calling — this is the channel that
   *           survives colour blindness and greyscale
   *   COLOUR  the tint the student picked during creation, theirs alone
   *   NAME    drawn above when the hex radius allows it
   *
   * Everything is drawn from a unit box and scaled, so one definition works
   * from a 22px town hex up to a 74px room hex.
   *
   * Honest about the limit: at fourteen pixels these eight silhouettes are
   * distinguishable by overall mass — tall, skirted, hatted, laden — and not
   * by fine detail. That is why the shapes differ in OUTLINE and not in
   * ornament, and why the chosen tint carries the real weight. */
function figurine(ctx, cx, cy, size, calling, fill, rim, hollow) {
  const u = size;                       // half-height of the whole figure
  ctx.save();
  ctx.translate(cx, cy);

  const body = new Path2D();
  const kind = String(calling || '').toUpperCase();

  /* the head, common to all — a person is a person */
  const headR = u * 0.30;
  const headY = -u * 0.52;

  /* the trunk, which is where the Calling shows */
  if (kind === 'HOUSEHOLDER' || kind === 'HEALER') {
    /* skirted: a wide triangular base, the widest silhouette on the board */
    body.moveTo(-u * 0.62, u * 0.86);
    body.lineTo(-u * 0.20, -u * 0.16);
    body.lineTo(u * 0.20, -u * 0.16);
    body.lineTo(u * 0.62, u * 0.86);
    body.closePath();
  } else if (kind === 'RIDER' || kind === 'RANCHERO') {
    /* hatted: a hard horizontal brim, which reads at any size */
    body.moveTo(-u * 0.34, u * 0.86);
    body.lineTo(-u * 0.24, -u * 0.10);
    body.lineTo(u * 0.24, -u * 0.10);
    body.lineTo(u * 0.34, u * 0.86);
    body.closePath();
  } else if (kind === 'TRADER') {
    /* laden: a pack humped off the back shoulder */
    body.moveTo(-u * 0.30, u * 0.86);
    body.lineTo(-u * 0.22, -u * 0.12);
    body.lineTo(u * 0.16, -u * 0.12);
    body.lineTo(u * 0.62, u * 0.10);
    body.lineTo(u * 0.50, u * 0.52);
    body.lineTo(u * 0.30, u * 0.86);
    body.closePath();
  } else if (kind === 'CLERK') {
    /* narrow and upright, with a squared-off hem — a coat, not a skirt */
    body.moveTo(-u * 0.26, u * 0.86);
    body.lineTo(-u * 0.26, -u * 0.12);
    body.lineTo(u * 0.26, -u * 0.12);
    body.lineTo(u * 0.26, u * 0.86);
    body.closePath();
  } else {
    /* RIFLEMAN, SMITH and anything unrecognised: a plain tapered body.
     * Their distinguishing mark is drawn after, in the rim colour. */
    body.moveTo(-u * 0.36, u * 0.86);
    body.lineTo(-u * 0.22, -u * 0.14);
    body.lineTo(u * 0.22, -u * 0.14);
    body.lineTo(u * 0.36, u * 0.86);
    body.closePath();
  }

  /* a shadow on the ground, so a figure stands rather than floats */
  if (!hollow) {
    ctx.save();
    ctx.translate(u * 0.10, u * 0.14);
    ctx.fillStyle = 'rgba(27,42,51,.22)';
    ctx.fill(body);
    ctx.beginPath();
    ctx.arc(0, headY, headR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  ctx.fillStyle = hollow ? 'rgba(242,243,238,.90)' : fill;
  ctx.strokeStyle = rim;
  ctx.lineWidth = Math.max(1.2, u * 0.13);
  ctx.fill(body);
  ctx.stroke(body);
  ctx.beginPath();
  ctx.arc(0, headY, headR, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  /* THE MARKS. One bold stroke each, in the rim colour so it reads against
   * any tint a student picks. */
  ctx.lineWidth = Math.max(1.4, u * 0.16);
  ctx.lineCap = 'round';
  ctx.beginPath();
  if (kind === 'RIFLEMAN') {
    /* a long barrel over the shoulder */
    ctx.moveTo(u * 0.42, u * 0.72);
    ctx.lineTo(-u * 0.18, -u * 0.86);
  } else if (kind === 'SMITH') {
    /* a hammer: short handle, heavy head */
    ctx.moveTo(u * 0.40, u * 0.52);
    ctx.lineTo(u * 0.40, -u * 0.34);
    ctx.stroke();
    ctx.beginPath();
    ctx.lineWidth = Math.max(2, u * 0.30);
    ctx.moveTo(u * 0.18, -u * 0.44);
    ctx.lineTo(u * 0.62, -u * 0.44);
  } else if (kind === 'RIDER' || kind === 'RANCHERO') {
    /* the brim, wide for a ranchero and narrower for a rider */
    const bw = kind === 'RANCHERO' ? 0.78 : 0.60;
    ctx.moveTo(-u * bw, headY - headR * 0.55);
    ctx.lineTo(u * bw, headY - headR * 0.55);
  } else if (kind === 'HEALER') {
    /* a bundle carried in front */
    ctx.lineWidth = Math.max(1.6, u * 0.22);
    ctx.moveTo(-u * 0.30, u * 0.20);
    ctx.lineTo(u * 0.06, u * 0.20);
  } else if (kind === 'CLERK') {
    /* a page held up */
    ctx.lineWidth = Math.max(1.4, u * 0.14);
    ctx.moveTo(-u * 0.34, u * 0.06);
    ctx.lineTo(u * 0.34, u * 0.06);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-u * 0.34, u * 0.30);
    ctx.lineTo(u * 0.12, u * 0.30);
  }
  ctx.stroke();
  ctx.lineCap = 'butt';
  ctx.restore();
  }


  function Renderer(canvas, map) {
    const ctx = canvas.getContext('2d');
    let R = 26, ox = 0, oy = 0, dpr = 1;

    /* Every scattered blade of grass is a function of WHERE it is, never of
     * when it was drawn. Thirty screens agree, and nothing shimmers. */
    function rnd(c, r, i) {
      let h = (c * 73856093) ^ (r * 19349663) ^ ((i | 0) * 83492791);
      h = (h ^ (h >>> 13)) >>> 0;
      h = (Math.imul(h, 1274126177)) >>> 0;
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    }

    function layout() {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(200, Math.round(rect.width * dpr));
      canvas.height = Math.max(160, Math.round(rect.height * dpr));

      /* Fit the whole place, then centre it. A student should never have to
       * scroll or pinch to see where they are. An interior is small, so it is
       * capped rather than blown up to absurd hexes. */
      const padPx = Math.min(16 * dpr, canvas.width * 0.055);
      const availW = canvas.width - padPx * 2;
      const availH = canvas.height - padPx * 2;
      const byW = availW / ((map.cols + 0.5) * Math.sqrt(3));
      const byH = availH / (2 + 1.5 * (map.rows - 1));
      R = Math.max(8, Math.min(byW, byH, 74 * dpr));
      const gridW = (map.cols + 0.5) * Math.sqrt(3) * R;
      const gridH = (2 + 1.5 * (map.rows - 1)) * R;
      ox = (canvas.width - gridW) / 2;
      oy = (canvas.height - gridH) / 2;
    }

    function centre(c, r) {
      const w = Math.sqrt(3) * R;
      return [ox + w / 2 + c * w + (r % 2 ? w / 2 : 0), oy + R + r * 1.5 * R];
    }
    function pts(cx, cy) {
      const a = [];
      for (let i = 0; i < 6; i++) {
        const t = Math.PI / 180 * (60 * i + 30);
        a.push([cx + R * Math.cos(t), cy + R * Math.sin(t)]);
      }
      return a;
    }
    function path(cx, cy) {
      const p = pts(cx, cy);
      ctx.beginPath();
      ctx.moveTo(p[0][0], p[0][1]);
      for (let i = 1; i < 6; i++) ctx.lineTo(p[i][0], p[i][1]);
      ctx.closePath();
    }
    function clipHex(cx, cy, fn) {
      ctx.save();
      path(cx, cy);
      ctx.clip();
      fn();
      ctx.restore();
    }
    /* The edge two hexes share, as two screen points. Used for fences and for
     * the darker line where water meets bank. */
    function sharedEdge(p, q) {
      const dx = q[0] - p[0], dy = q[1] - p[1];
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const ap = R * Math.sqrt(3) / 2;                 // apothem
      const mx = p[0] + ux * ap, my = p[1] + uy * ap;
      const hx = -uy * (R / 2), hy = ux * (R / 2);
      return [[mx - hx, my - hy], [mx + hx, my + hy]];
    }

    /* Screen point → hex. Nearest-centre is exact enough at this radius and is
     * far more forgiving on a trackpad than true cube rounding. */
    function hitTest(px, py) {
      const x = px * dpr, y = py * dpr;
      let best = null, bestD = Infinity;
      for (let r = 0; r < map.rows; r++) {
        for (let c = 0; c < map.cols; c++) {
          const p = centre(c, r);
          const d = (p[0] - x) * (p[0] - x) + (p[1] - y) * (p[1] - y);
          if (d < bestD) { bestD = d; best = { c: c, r: r }; }
        }
      }
      return bestD <= (R * R * 1.05) ? best : null;
    }

    /* ------------------------------------------------------------- terrain
     *
     * One function per `detail` value in content/terrain.json. Each draws
     * INSIDE one hex, clipped, using only rnd(c,r,·) for variation. Nothing
     * here reads the clock, so nothing here moves. */
    const DECOR = {
      grass: function (c, r, p, t) {
        const n = Math.round(9 + 9 * (t.density || 1));
        ctx.strokeStyle = 'rgba(104,124,84,.46)';
        ctx.lineWidth = Math.max(0.8, R * 0.035);
        ctx.lineCap = 'round';
        for (let i = 0; i < n; i++) {
          const a = rnd(c, r, i) * Math.PI * 2;
          const d = Math.sqrt(rnd(c, r, i + 40)) * R * 0.82;
          const x = p[0] + Math.cos(a) * d, y = p[1] + Math.sin(a) * d;
          const h = R * (0.13 + rnd(c, r, i + 80) * 0.13);
          const lean = (rnd(c, r, i + 120) - 0.5) * R * 0.16;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.quadraticCurveTo(x + lean * 0.5, y - h * 0.6, x + lean, y - h);
          ctx.stroke();
        }
      },

      furrow: function (c, r, p) {
        /* Ploughed rows run the same way across a whole field, so the angle is
         * hashed from the FIELD, not the hex — otherwise the country looks
         * like a quilt. */
        const a = Math.PI * 0.16;
        ctx.strokeStyle = 'rgba(150,142,108,.50)';
        ctx.lineWidth = Math.max(0.8, R * 0.045);
        const step = R * 0.28;
        for (let k = -3; k <= 3; k++) {
          const off = k * step;
          ctx.beginPath();
          ctx.moveTo(p[0] - Math.cos(a) * R - Math.sin(a) * off, p[1] - Math.sin(a) * R + Math.cos(a) * off);
          ctx.lineTo(p[0] + Math.cos(a) * R - Math.sin(a) * off, p[1] + Math.sin(a) * R + Math.cos(a) * off);
          ctx.stroke();
        }
      },

      stubble: function (c, r, p) {
        ctx.strokeStyle = 'rgba(150,138,92,.55)';
        ctx.lineWidth = Math.max(0.8, R * 0.04);
        const a = Math.PI * 0.16, step = R * 0.34;
        for (let k = -2; k <= 2; k++) {
          for (let j = -2; j <= 2; j++) {
            const u = j * step + (rnd(c, r, k * 7 + j) - 0.5) * R * 0.1;
            const v = k * step;
            const x = p[0] + Math.cos(a) * u - Math.sin(a) * v;
            const y = p[1] + Math.sin(a) * u + Math.cos(a) * v;
            if (Math.hypot(x - p[0], y - p[1]) > R * 0.8) continue;
            ctx.beginPath();
            ctx.moveTo(x, y + R * 0.09);
            ctx.lineTo(x, y - R * 0.09);
            ctx.stroke();
          }
        }
      },

      orchard: function (c, r, p) {
        /* Planted in rows, which is the whole visual difference between an
         * orchard and a wood. The peach orchard is where the cannon went. */
        const step = R * 0.52;
        for (let k = -1; k <= 1; k++) {
          for (let j = -1; j <= 1; j++) {
            const x = p[0] + j * step + (k % 2 ? step * 0.5 : 0);
            const y = p[1] + k * step * 0.92;
            if (Math.hypot(x - p[0], y - p[1]) > R * 0.78) continue;
            const rad = R * 0.15;
            ctx.beginPath();
            ctx.arc(x + R * 0.05, y + R * 0.06, rad, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(60,74,48,.16)';
            ctx.fill();
            ctx.beginPath();
            ctx.arc(x, y, rad, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(126,152,102,.85)';
            ctx.fill();
          }
        }
      },

      scrub: function (c, r, p, t) {
        const n = Math.round(4 + 4 * (t.density || 1));
        for (let i = 0; i < n; i++) {
          const a = rnd(c, r, i) * Math.PI * 2;
          const d = Math.sqrt(rnd(c, r, i + 30)) * R * 0.7;
          const x = p[0] + Math.cos(a) * d, y = p[1] + Math.sin(a) * d;
          const rad = R * (0.11 + rnd(c, r, i + 60) * 0.09);
          ctx.beginPath();
          for (let k = 0; k < 7; k++) {
            const ta = (k / 7) * Math.PI * 2;
            const rr = rad * (0.68 + rnd(c, r, i * 11 + k) * 0.55);
            const px = x + Math.cos(ta) * rr, py = y + Math.sin(ta) * rr;
            if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.fillStyle = 'rgba(122,138,100,.55)';
          ctx.fill();
        }
      },

      canopy: function (c, r, p, t, L) {
        const n = (t.density || 1) >= 0.9 ? 3 : 2;
        const sh = L ? L.shadow : 1.6, sa = L ? L.shadowAngle : 2.4;
        for (let i = 0; i < n; i++) {
          const a = rnd(c, r, i) * Math.PI * 2;
          const d = (n === 1 ? 0 : Math.sqrt(rnd(c, r, i + 20)) * R * 0.42);
          const x = p[0] + Math.cos(a) * d, y = p[1] + Math.sin(a) * d;
          const rad = R * (0.28 + rnd(c, r, i + 50) * 0.13);
          if (sh > 0) {
            ctx.beginPath();
            ctx.arc(x + Math.cos(sa) * rad * sh * 0.32, y + Math.sin(sa) * rad * sh * 0.32, rad * 0.92, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(48,60,40,.20)';
            ctx.fill();
          }
          ctx.beginPath();                       // a lobed crown, not a circle
          for (let k = 0; k < 9; k++) {
            const ta = (k / 9) * Math.PI * 2;
            const rr = rad * (0.82 + rnd(c, r, i * 17 + k) * 0.34);
            const px = x + Math.cos(ta) * rr, py = y + Math.sin(ta) * rr;
            if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.fillStyle = 'rgba(108,130,88,.88)';
          ctx.fill();
          ctx.strokeStyle = 'rgba(72,90,60,.55)';
          ctx.lineWidth = Math.max(0.7, R * 0.022);
          ctx.stroke();
        }
      },

      cane: function (c, r, p) {
        ctx.strokeStyle = 'rgba(118,142,104,.62)';
        ctx.lineWidth = Math.max(0.8, R * 0.03);
        for (let i = 0; i < 22; i++) {
          const a = rnd(c, r, i) * Math.PI * 2;
          const d = Math.sqrt(rnd(c, r, i + 25)) * R * 0.85;
          const x = p[0] + Math.cos(a) * d, y = p[1] + Math.sin(a) * d;
          const h = R * (0.3 + rnd(c, r, i + 55) * 0.2);
          const lean = (rnd(c, r, i + 95) - 0.5) * R * 0.2;
          ctx.beginPath();
          ctx.moveTo(x, y + h * 0.3);
          ctx.lineTo(x + lean, y - h);
          ctx.stroke();
        }
      },

      hachure: function (c, r, p) {
        /* Contour ticks, the way a nineteenth-century surveyor drew high
         * ground. Reads as "this is above you" without a legend. */
        ctx.strokeStyle = 'rgba(140,132,104,.62)';
        ctx.lineWidth = Math.max(0.8, R * 0.04);
        [0.42, 0.68].forEach(function (ring, ri) {
          const n = ri ? 16 : 11;
          for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2 + ri * 0.2;
            const x = p[0] + Math.cos(a) * R * ring;
            const y = p[1] + Math.sin(a) * R * ring;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + Math.cos(a) * R * 0.13, y + Math.sin(a) * R * 0.13);
            ctx.stroke();
          }
        });
      },

      water: function (c, r, p, t) {
        /* Current, drawn as broken lines running with the channel. Dense in
         * the river, sparse at a ford so the ford reads as shallow. */
        const n = (t.density || 1) >= 0.9 ? 4 : 2;
        ctx.strokeStyle = 'rgba(112,152,162,.55)';
        ctx.lineWidth = Math.max(0.9, R * 0.045);
        ctx.lineCap = 'round';
        for (let i = 0; i < n; i++) {
          const y = p[1] + (i - (n - 1) / 2) * R * 0.42 + (rnd(c, r, i) - 0.5) * R * 0.12;
          const w = R * (0.34 + rnd(c, r, i + 7) * 0.36);
          const x = p[0] + (rnd(c, r, i + 14) - 0.5) * R * 0.5;
          ctx.beginPath();
          ctx.moveTo(x - w, y);
          ctx.quadraticCurveTo(x, y - R * 0.09, x + w, y);
          ctx.stroke();
        }
      },

      ditch: function (c, r, p) {
        ctx.strokeStyle = 'rgba(108,146,148,.7)';
        ctx.lineWidth = Math.max(1, R * 0.09);
        ctx.beginPath();
        ctx.moveTo(p[0] - R * 0.9, p[1] + R * 0.1);
        ctx.quadraticCurveTo(p[0], p[1] - R * 0.16, p[0] + R * 0.9, p[1] + R * 0.1);
        ctx.stroke();
      },

      sand: function (c, r, p) {
        ctx.fillStyle = 'rgba(160,148,116,.42)';
        for (let i = 0; i < 26; i++) {
          const a = rnd(c, r, i) * Math.PI * 2;
          const d = Math.sqrt(rnd(c, r, i + 33)) * R * 0.85;
          ctx.beginPath();
          ctx.arc(p[0] + Math.cos(a) * d, p[1] + Math.sin(a) * d, R * 0.022, 0, Math.PI * 2);
          ctx.fill();
        }
      },

      packed: function (c, r, p, t) {
        const n = Math.round(6 + 22 * (t.density || 0.3));
        ctx.fillStyle = 'rgba(128,122,104,.26)';
        for (let i = 0; i < n; i++) {
          const a = rnd(c, r, i) * Math.PI * 2;
          const d = Math.sqrt(rnd(c, r, i + 12)) * R * 0.82;
          ctx.beginPath();
          ctx.arc(p[0] + Math.cos(a) * d, p[1] + Math.sin(a) * d, R * 0.02, 0, Math.PI * 2);
          ctx.fill();
        }
      },

      rubble: function (c, r, p) {
        for (let i = 0; i < 7; i++) {
          const a = rnd(c, r, i) * Math.PI * 2;
          const d = Math.sqrt(rnd(c, r, i + 15)) * R * 0.66;
          const x = p[0] + Math.cos(a) * d, y = p[1] + Math.sin(a) * d;
          const s = R * (0.09 + rnd(c, r, i + 45) * 0.08);
          ctx.beginPath();
          ctx.moveTo(x - s, y + s * 0.6);
          ctx.lineTo(x - s * 0.3, y - s);
          ctx.lineTo(x + s, y - s * 0.2);
          ctx.lineTo(x + s * 0.4, y + s * 0.8);
          ctx.closePath();
          ctx.fillStyle = 'rgba(150,146,132,.75)';
          ctx.fill();
          ctx.strokeStyle = 'rgba(110,106,94,.6)';
          ctx.lineWidth = Math.max(0.6, R * 0.02);
          ctx.stroke();
        }
      },

      boards: function (c, r, p) {
        ctx.strokeStyle = 'rgba(150,138,112,.42)';
        ctx.lineWidth = Math.max(0.7, R * 0.03);
        for (let k = -3; k <= 3; k++) {
          const y = p[1] + k * R * 0.29;
          ctx.beginPath();
          ctx.moveTo(p[0] - R * 0.9, y);
          ctx.lineTo(p[0] + R * 0.9, y);
          ctx.stroke();
        }
      },

      planks: function (c, r, p) {
        ctx.strokeStyle = 'rgba(130,116,92,.55)';
        ctx.lineWidth = Math.max(0.8, R * 0.05);
        for (let k = -2; k <= 2; k++) {
          const x = p[0] + k * R * 0.35;
          ctx.beginPath();
          ctx.moveTo(x, p[1] - R * 0.8);
          ctx.lineTo(x, p[1] + R * 0.8);
          ctx.stroke();
        }
      },

      goods: function (c, r, p) {
        /* Barrels, crates, a counter. Enough to say "there is stuff here". */
        for (let i = 0; i < 4; i++) {
          const x = p[0] + (rnd(c, r, i) - 0.5) * R * 1.1;
          const y = p[1] + (rnd(c, r, i + 9) - 0.5) * R * 1.0;
          const s = R * 0.19;
          ctx.fillStyle = 'rgba(150,132,100,.75)';
          ctx.strokeStyle = 'rgba(110,94,68,.75)';
          ctx.lineWidth = Math.max(0.7, R * 0.022);
          if (rnd(c, r, i + 21) > 0.5) {
            ctx.beginPath(); ctx.arc(x, y, s * 0.8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            ctx.beginPath(); ctx.arc(x, y, s * 0.4, 0, Math.PI * 2); ctx.stroke();
          } else {
            ctx.beginPath(); ctx.rect(x - s, y - s * 0.72, s * 2, s * 1.44); ctx.fill(); ctx.stroke();
          }
        }
      },

      fire: function (c, r, p) {
        ctx.beginPath();
        ctx.arc(p[0], p[1], R * 0.44, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(196,110,52,.30)';
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(p[0] - R * 0.2, p[1] + R * 0.24);
        ctx.quadraticCurveTo(p[0] - R * 0.06, p[1] - R * 0.06, p[0], p[1] - R * 0.34);
        ctx.quadraticCurveTo(p[0] + R * 0.09, p[1] - R * 0.04, p[0] + R * 0.2, p[1] + R * 0.24);
        ctx.closePath();
        ctx.fillStyle = 'rgba(214,120,48,.86)';
        ctx.fill();
      },

      threshold: function (c, r, p) {
        ctx.strokeStyle = 'rgba(122,112,90,.7)';
        ctx.lineWidth = Math.max(1, R * 0.07);
        ctx.beginPath();
        ctx.moveTo(p[0] - R * 0.5, p[1] + R * 0.3);
        ctx.lineTo(p[0] + R * 0.5, p[1] + R * 0.3);
        ctx.stroke();
      },

      ladder: function (c, r, p) {
        ctx.strokeStyle = 'rgba(128,112,84,.8)';
        ctx.lineWidth = Math.max(0.9, R * 0.05);
        ctx.beginPath(); ctx.moveTo(p[0] - R * 0.22, p[1] - R * 0.5); ctx.lineTo(p[0] - R * 0.22, p[1] + R * 0.5); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(p[0] + R * 0.22, p[1] - R * 0.5); ctx.lineTo(p[0] + R * 0.22, p[1] + R * 0.5); ctx.stroke();
        for (let k = -2; k <= 2; k++) {
          const y = p[1] + k * R * 0.24;
          ctx.beginPath(); ctx.moveTo(p[0] - R * 0.22, y); ctx.lineTo(p[0] + R * 0.22, y); ctx.stroke();
        }
      },
    };

    /* ---------------------------------------------------------- ribbons
     * A road is one continuous thing. Drawing it hex-by-hex gives you eleven
     * brown lozenges; drawing centre-to-centre through every neighbour of the
     * same kind gives you a road. */
    function ribbon(match, width, colour, dash) {
      ctx.save();
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (dash) ctx.setLineDash(dash);
      for (let r = 0; r < map.rows; r++) {
        for (let c = 0; c < map.cols; c++) {
          if (!match(c, r)) continue;
          const p = centre(c, r);
          let joined = false;
          map.neighbours(c, r).forEach((n) => {
            if (!match(n.c, n.r)) return;
            if (n.r < r || (n.r === r && n.c < c)) return;   // draw each link once
            joined = true;
            const q = centre(n.c, n.r);
            ctx.beginPath();
            ctx.moveTo(p[0], p[1]);
            ctx.lineTo(q[0], q[1]);
            ctx.stroke();
          });
          if (!joined) {                                     // a lone hex still shows
            ctx.beginPath();
            ctx.arc(p[0], p[1], width * 0.42, 0, Math.PI * 2);
            ctx.fillStyle = colour;
            ctx.fill();
          }
        }
      }
      ctx.restore();
    }

    function isName(c, r, name) {
      const t = map.terrain(c, r);
      return !!t && t.name === name;
    }

    /* ------------------------------------------------------------- icons
     * Drawn, not typed. A door has to read as open or shut at a glance from a
     * Chromebook, so these are shapes rather than glyphs. */
    function icon(kind, cx, cy, size, open) {
      const S = size;
      ctx.save();
      ctx.lineWidth = Math.max(1, S * 0.13);
      ctx.lineJoin = 'round';
      if (kind === 'door') {
        ctx.strokeStyle = open ? '#39646B' : '#9E3729';
        ctx.fillStyle = open ? 'rgba(57,100,107,.14)' : 'rgba(158,55,41,.20)';
        ctx.beginPath();
        ctx.rect(cx - S * 0.45, cy - S * 0.6, S * 0.9, S * 1.2);
        ctx.fill(); ctx.stroke();
        if (open) {                       // the leaf, swung back
          ctx.beginPath();
          ctx.moveTo(cx + S * 0.45, cy - S * 0.6);
          ctx.lineTo(cx + S * 1.0, cy - S * 0.15);
          ctx.stroke();
        } else {                          // a bar across it
          ctx.beginPath();
          ctx.moveTo(cx - S * 0.45, cy);
          ctx.lineTo(cx + S * 0.45, cy);
          ctx.stroke();
        }
      } else if (kind === 'stair') {      // a portal: this door goes somewhere
        ctx.strokeStyle = '#39646B';
        ctx.fillStyle = 'rgba(57,100,107,.16)';
        ctx.beginPath();
        ctx.moveTo(cx - S * 0.55, cy + S * 0.55);
        ctx.lineTo(cx - S * 0.55, cy - S * 0.1);
        ctx.lineTo(cx + S * 0.05, cy - S * 0.1);
        ctx.lineTo(cx + S * 0.05, cy - S * 0.62);
        ctx.lineTo(cx + S * 0.6, cy - S * 0.62);
        ctx.lineTo(cx + S * 0.6, cy + S * 0.55);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
      } else if (kind === 'chest') {
        ctx.strokeStyle = '#8A6534';
        ctx.fillStyle = 'rgba(138,101,52,.28)';
        ctx.beginPath();
        ctx.rect(cx - S * 0.6, cy - S * 0.4, S * 1.2, S * 0.85);
        ctx.fill(); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx - S * 0.6, cy - S * 0.1);
        ctx.lineTo(cx + S * 0.6, cy - S * 0.1);
        ctx.stroke();
      } else if (kind === 'chest-done') {
        ctx.strokeStyle = '#A9B2A8';
        ctx.setLineDash([S * 0.25, S * 0.2]);
        ctx.beginPath();
        ctx.rect(cx - S * 0.6, cy - S * 0.4, S * 1.2, S * 0.85);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (kind === 'body') {
        ctx.strokeStyle = '#7A5C7E';
        ctx.fillStyle = 'rgba(122,92,126,.26)';
        ctx.beginPath();
        ctx.ellipse(cx, cy + S * 0.1, S * 0.62, S * 0.3, 0, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx - S * 0.5, cy - S * 0.12, S * 0.2, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      } else if (kind === 'cannon') {
        ctx.strokeStyle = '#9E3729';
        ctx.fillStyle = 'rgba(158,55,41,.30)';
        ctx.beginPath();
        ctx.moveTo(cx - S * 0.75, cy - S * 0.22);
        ctx.lineTo(cx + S * 0.5, cy - S * 0.32);
        ctx.lineTo(cx + S * 0.5, cy + S * 0.08);
        ctx.lineTo(cx - S * 0.75, cy + S * 0.18);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx - S * 0.55, cy + S * 0.45, S * 0.32, 0, Math.PI * 2);
        ctx.stroke();
      } else if (kind === 'well') {
        ctx.strokeStyle = '#55666E';
        ctx.fillStyle = 'rgba(85,102,110,.22)';
        ctx.beginPath(); ctx.arc(cx, cy, S * 0.5, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.arc(cx, cy, S * 0.24, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
    }

    /* ---------------------------------------------------------------- draw
     *
     * state = { you, tokens[], npcs[], reach{}, hover, features[], occupied[],
     *           light: {phase, weather}, showLabels }
     */
    function draw(state) {
      state = state || {};
      layout();
      const S = dpr;
      const LT = (map.data.lightTable || {});
      const WT = (map.data.weatherTable || {});
      const lightKey = (state.light && state.light.phase) || 'MIDDAY';
      const L = LT[lightKey] || LT.MIDDAY || { alpha: 0, shadow: 1, shadowAngle: 1.57 };
      const W = WT[(state.light && state.light.weather) || 'CLEAR'] || null;
      /* Indoors it is always the same dimness — a lamp does not care that it is
       * overcast outside — but night still reaches through the door. */
      const indoorL = map.indoors ? Object.assign({}, L, { alpha: L.alpha * 0.45, shadow: 0.9 }) : L;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = map.indoors ? '#DED9C9' : '#E9EBE4';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const reach = state.reach || {};
      const you = state.you ? map.parse(state.you) : null;

      /* ---- 1. THE GROUND, as ground. Fills with no strokes, so terrain reads
       * as continuous country rather than N separate tiles. */
      for (let r = 0; r < map.rows; r++) {
        for (let c = 0; c < map.cols; c++) {
          const t = map.terrain(c, r);
          if (!t) continue;
          const p = centre(c, r);
          path(p[0], p[1]);
          ctx.fillStyle = t.fill || '#E9EBE4';
          ctx.fill();
        }
      }

      /* ---- 2. WHAT GROWS ON IT. The decoration pass — grass, furrows,
       * canopies, hachures. This is the whole difference between a grid and a
       * place. Buildings and walls are skipped; they get their own pass. */
      for (let r = 0; r < map.rows; r++) {
        for (let c = 0; c < map.cols; c++) {
          const t = map.terrain(c, r);
          if (!t || !t.detail) continue;
          const fn = DECOR[t.detail];
          if (!fn) continue;
          const p = centre(c, r);
          clipHex(p[0], p[1], function () { fn(c, r, p, t, indoorL); });
        }
      }

      /* ---- 3. WATER, as water: flow lines down the channel, a firm bank. */
      const water = function (c, r) { const t = map.terrain(c, r); return !!t && (t.name === 'river' || t.name === 'ford'); };
      ctx.save();
      ctx.strokeStyle = 'rgba(90,130,140,.55)';
      ctx.lineWidth = 2.2 * S;
      for (let r = 0; r < map.rows; r++) {
        for (let c = 0; c < map.cols; c++) {
          if (!water(c, r)) continue;
          const p = centre(c, r);
          map.neighbours(c, r).forEach((n) => {
            if (water(n.c, n.r)) return;
            const e = sharedEdge(p, centre(n.c, n.r));
            ctx.beginPath();
            ctx.moveTo(e[0][0], e[0][1]);
            ctx.lineTo(e[1][0], e[1][1]);
            ctx.stroke();
          });
        }
      }
      ctx.restore();

      /* ---- 4. ROADS AND PATHS, as continuous ways. Verge, then metal, then
       * the two ruts a wagon actually leaves. */
      const road = function (c, r) { return isName(c, r, 'road') || isName(c, r, 'bridge'); };
      ribbon(road, R * 1.02, 'rgba(178,168,142,.42)');
      ribbon(road, R * 0.78, '#D9D0BD');
      ribbon(road, R * 0.10, 'rgba(150,136,106,.55)');
      ribbon(function (c, r) { return isName(c, r, 'path'); }, R * 0.20,
             'rgba(160,148,120,.60)', [R * 0.26, R * 0.20]);

      /* ---- 5. FENCES. Drawn on the EDGE between a pen and whatever is not a
       * pen, because a fence is a boundary and not a square of ground. */
      ctx.save();
      ctx.strokeStyle = 'rgba(128,112,82,.85)';
      ctx.lineWidth = Math.max(1, R * 0.055);
      for (let r = 0; r < map.rows; r++) {
        for (let c = 0; c < map.cols; c++) {
          if (!isName(c, r, 'pen')) continue;
          const p = centre(c, r);
          map.neighbours(c, r).forEach((n) => {
            if (isName(n.c, n.r, 'pen')) return;
            const e = sharedEdge(p, centre(n.c, n.r));
            ctx.beginPath();
            ctx.moveTo(e[0][0], e[0][1]);
            ctx.lineTo(e[1][0], e[1][1]);
            ctx.stroke();
            for (let k = 1; k <= 2; k++) {          // posts
              const px = e[0][0] + (e[1][0] - e[0][0]) * (k / 3);
              const py = e[0][1] + (e[1][1] - e[0][1]) * (k / 3);
              ctx.beginPath();
              ctx.arc(px, py, R * 0.035, 0, Math.PI * 2);
              ctx.fillStyle = 'rgba(110,94,66,.9)';
              ctx.fill();
            }
          });
        }
      }
      ctx.restore();

      /* ---- 6. STRUCTURE. A footprint with a shadow reads as a building; a
       * coloured hexagon reads as a colour. Walls are a different animal and
       * are drawn as mass, not as a house. */
      const lamps = [];                        // where light comes from after dark
      for (let r = 0; r < map.rows; r++) {
        for (let c = 0; c < map.cols; c++) {
          const t = map.terrain(c, r);
          if (!t) continue;
          const p = centre(c, r);
          if (t.detail === 'stone') {
            path(p[0], p[1]);
            ctx.fillStyle = t.fill;
            ctx.fill();
            ctx.strokeStyle = t.line || '#868C7C';
            ctx.lineWidth = Math.max(1.4, R * 0.09);
            ctx.stroke();
            clipHex(p[0], p[1], function () {   // coursed stone
              ctx.strokeStyle = 'rgba(96,102,92,.45)';
              ctx.lineWidth = Math.max(0.7, R * 0.025);
              for (let k = -2; k <= 2; k++) {
                const y = p[1] + k * R * 0.36;
                ctx.beginPath(); ctx.moveTo(p[0] - R, y); ctx.lineTo(p[0] + R, y); ctx.stroke();
              }
            });
            continue;
          }
          if (t.detail !== 'roof' && t.detail !== 'thatch') continue;

          const w = R * 1.02, h = R * 0.90;
          const sh = indoorL.shadow, sa = indoorL.shadowAngle;
          ctx.save();
          if (sh > 0) {
            ctx.fillStyle = 'rgba(27,42,51,.17)';
            ctx.fillRect(p[0] - w / 2 + Math.cos(sa) * sh * S * 1.4,
                         p[1] - h / 2 + Math.sin(sa) * sh * S * 1.4, w, h);
          }
          ctx.fillStyle = t.fill;
          ctx.strokeStyle = t.line || '#7C8B90';
          ctx.lineWidth = 1.3 * S;
          ctx.fillRect(p[0] - w / 2, p[1] - h / 2, w, h);
          /* the sunward slope, lighter — this is what makes it read as a roof */
          ctx.fillStyle = 'rgba(255,255,255,.30)';
          ctx.beginPath();
          ctx.moveTo(p[0] - w / 2, p[1] - h / 2);
          ctx.lineTo(p[0] + w / 2, p[1] - h / 2);
          ctx.lineTo(p[0] + w / 2, p[1] - h / 6);
          ctx.lineTo(p[0] - w / 2, p[1] - h / 6);
          ctx.closePath();
          ctx.fill();
          ctx.strokeRect(p[0] - w / 2, p[1] - h / 2, w, h);
          if (t.detail === 'thatch') {
            ctx.strokeStyle = 'rgba(150,132,92,.6)';
            ctx.lineWidth = Math.max(0.7, R * 0.024);
            for (let k = -3; k <= 3; k++) {
              ctx.beginPath();
              ctx.moveTo(p[0] - w / 2, p[1] + k * h * 0.16);
              ctx.lineTo(p[0] + w / 2, p[1] + k * h * 0.16);
              ctx.stroke();
            }
          } else {
            ctx.beginPath();                     // roof ridge
            ctx.moveTo(p[0] - w / 2, p[1] - h / 6);
            ctx.lineTo(p[0] + w / 2, p[1] - h / 6);
            ctx.stroke();
            ctx.fillStyle = 'rgba(90,100,96,.8)';   // and a chimney
            const cw = R * 0.14;
            ctx.fillRect(p[0] + w / 2 - cw * 2.1, p[1] - h / 2 - cw * 0.9, cw, cw * 1.5);
          }
          ctx.restore();
          if (L.windows) lamps.push([p[0], p[1], R * 1.5, 'window']);
        }
      }
      /* A fire is a light source as well as a decoration. */
      for (let r = 0; r < map.rows; r++) {
        for (let c = 0; c < map.cols; c++) {
          const t = map.terrain(c, r);
          if (t && t.detail === 'fire') { const p = centre(c, r); lamps.push([p[0], p[1], R * 2.1, 'fire']); }
        }
      }

      /* ---- 7. the grid, light enough to be a guide and not a cage */
      ctx.save();
      ctx.strokeStyle = map.indoors ? 'rgba(27,42,51,.10)' : 'rgba(27,42,51,.11)';
      ctx.lineWidth = 1 * S;
      for (let r = 0; r < map.rows; r++) {
        for (let c = 0; c < map.cols; c++) {
          if (!map.terrain(c, r)) continue;
          const p = centre(c, r);
          path(p[0], p[1]);
          ctx.stroke();
        }
      }
      ctx.restore();

      /* ---- 8. THE LIGHT. Everything above is daylight; this is what time it
       * actually is. A wash over the ground, then warm pools where there is a
       * fire or a lit window, then weather on top of both. Tokens and the reach
       * overlay are drawn AFTER, because a student must be able to read their
       * own options at midnight. */
      if (indoorL.alpha > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = hexA(indoorL.wash, indoorL.alpha);
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
      }
      if (indoorL.warmAlpha > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'overlay';
        ctx.fillStyle = hexA(indoorL.warm, indoorL.warmAlpha);
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
      }
      if (lamps.length && indoorL.alpha > 0.12) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        lamps.forEach(function (lp) {
          const g = ctx.createRadialGradient(lp[0], lp[1], 0, lp[0], lp[1], lp[2]);
          const warm = lp[3] === 'fire' ? '214,126,58' : '224,182,110';
          g.addColorStop(0, 'rgba(' + warm + ',' + (lp[3] === 'fire' ? 0.5 : 0.34) + ')');
          g.addColorStop(1, 'rgba(' + warm + ',0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(lp[0], lp[1], lp[2], 0, Math.PI * 2);
          ctx.fill();
        });
        ctx.restore();
        /* and the lit pane itself, so you can see WHICH house is awake */
        lamps.forEach(function (lp) {
          if (lp[3] !== 'window') return;
          ctx.fillStyle = 'rgba(238,206,140,.92)';
          ctx.fillRect(lp[0] - R * 0.30, lp[1] + R * 0.02, R * 0.20, R * 0.16);
          ctx.fillRect(lp[0] + R * 0.10, lp[1] + R * 0.02, R * 0.20, R * 0.16);
        });
      }
      if (W && W.veilAlpha > 0) {
        ctx.save();
        ctx.fillStyle = hexA(W.veil, W.veilAlpha);
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (W.drift) {                    // fog lies in the low ground by the water
          for (let r = 0; r < map.rows; r++) {
            for (let c = 0; c < map.cols; c++) {
              if (!water(c, r) && !isName(c, r, 'riverbank')) continue;
              const p = centre(c, r);
              const g = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], R * 2.4);
              g.addColorStop(0, hexA(W.veil, 0.5));
              g.addColorStop(1, hexA(W.veil, 0));
              ctx.fillStyle = g;
              ctx.beginPath();
              ctx.arc(p[0], p[1], R * 2.4, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
        if (W.streaks) {
          ctx.strokeStyle = 'rgba(255,255,255,.16)';
          ctx.lineWidth = 1 * S;
          for (let i = 0; i < 200; i++) {
            const x = rnd(i, 3, 1) * canvas.width, y = rnd(i, 9, 2) * canvas.height;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + 3 * S, y + 13 * S);
            ctx.stroke();
          }
        }
        ctx.restore();
      }

      /* ---- 9. HOW FAR YOU MAY WALK.
       *
       * This used to be a 19%-alpha teal wash with a dashed outline on each
       * reachable hex. It was there and it was invisible: nineteen faint tiles
       * on a map already carrying grass hatching, furrows, tree canopy and
       * roof lines. A teacher played a real period and reported that students
       * "effectively get to move infinitely" and could "teleport all over the
       * map at will".
       *
       * Both halves of that report were about drawing, not rules. The budget is
       * enforced — tools/probe-movement.js walks a real Room and every hex
       * outside the budget comes back refused — but nothing on screen said
       * where the edge was.
       *
       * So it is inverted. Rather than tint the nineteen hexes you CAN reach,
       * darken the two hundred and eighty you cannot, and draw one hard line
       * around the border between them. Two things fall out of that for free:
       *
       *   · the shape of where you may go is a single readable region, not a
       *     scatter of tiles
       *   · when your movement is spent the reach set is empty, the veil lifts,
       *     and the whole map going bright again IS the message
       *
       * Tokens, doors and features are drawn after this, so a dimmed hex still
       * shows you plainly who is standing in it. */
      const hasReach = Object.keys(reach).length > 0;
      const inReach = function (c, r) {
        return reach[c + ',' + r] !== undefined || (you && you.c === c && you.r === r);
      };

      if (hasReach) {
        /* (a) the veil over everywhere you cannot get to */
        for (let r = 0; r < map.rows; r++) {
          for (let c = 0; c < map.cols; c++) {
            if (!map.terrain(c, r) || inReach(c, r)) continue;
            const p = centre(c, r);
            path(p[0], p[1]);
            ctx.fillStyle = 'rgba(24,33,38,.42)';
            ctx.fill();
          }
        }

        /* (b) a light lift on the hexes you can, so the region reads as lit
         * rather than merely un-dimmed */
        for (let r = 0; r < map.rows; r++) {
          for (let c = 0; c < map.cols; c++) {
            if (reach[c + ',' + r] === undefined) continue;
            const p = centre(c, r);
            path(p[0], p[1]);
            ctx.fillStyle = 'rgba(214,229,225,.16)';
            ctx.fill();
          }
        }

        /* (c) ONE line around the whole region. Every edge whose far side is
         * out of reach gets stroked, which traces the border exactly once and
         * leaves the interior clean. */
        ctx.strokeStyle = '#2F5A62';
        ctx.lineWidth = 2.6 * S;
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (let r = 0; r < map.rows; r++) {
          for (let c = 0; c < map.cols; c++) {
            if (!inReach(c, r)) continue;
            const p = centre(c, r);
            /* map.neighbours, not neighbours: the renderer is its own closure
             * and the grid helpers live on the map object. */
            map.neighbours(c, r).forEach(function (n) {
              if (inReach(n.c, n.r)) return;
              const e = sharedEdge(p, centre(n.c, n.r));
              ctx.moveTo(e[0][0], e[0][1]);
              ctx.lineTo(e[1][0], e[1][1]);
            });
          }
        }
        ctx.stroke();
        ctx.lineCap = 'butt';

        /* (d) what each step costs, for the ones that cost more than one —
         * a "1" on every hex is noise, a "3" on the hill is information */
        if (R > 15) {
          ctx.font = '600 ' + (R * 0.36).toFixed(0) + 'px "IBM Plex Mono", monospace';
          ctx.textAlign = 'center';
          for (let r = 0; r < map.rows; r++) {
            for (let c = 0; c < map.cols; c++) {
              const cost = reach[c + ',' + r];
              if (cost === undefined || cost < 2) continue;
              const p = centre(c, r);
              ctx.fillStyle = 'rgba(31,60,66,.92)';
              ctx.fillText(cost, p[0], p[1] + R * 0.66);
            }
          }
        }
      }

      /* ---- 9b. THE ROUTE YOU WOULD WALK.
       *
       * The other half of the teleport complaint. A hex three steps away is a
       * legal walk, but tapping it and appearing there is indistinguishable
       * from teleporting unless the intervening steps are shown. state.route
       * is the hexes of the cheapest path, start included. */
      const route = state.route || null;
      if (route && route.length > 1) {
        const pts2 = route.map(function (h) {
          const q = map.parse(h);
          return q ? centre(q.c, q.r) : null;
        }).filter(Boolean);

        ctx.strokeStyle = 'rgba(47,90,98,.55)';
        ctx.lineWidth = R * 0.16;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(pts2[0][0], pts2[0][1]);
        for (let i = 1; i < pts2.length; i++) ctx.lineTo(pts2[i][0], pts2[i][1]);
        ctx.stroke();

        /* a footfall on each hex the walk passes through */
        for (let i = 1; i < pts2.length; i++) {
          ctx.beginPath();
          ctx.arc(pts2[i][0], pts2[i][1], R * (i === pts2.length - 1 ? 0.17 : 0.1), 0, Math.PI * 2);
          ctx.fillStyle = i === pts2.length - 1 ? '#2F5A62' : 'rgba(47,90,98,.75)';
          ctx.fill();
          if (i === pts2.length - 1) {
            ctx.strokeStyle = '#F2F3EE';
            ctx.lineWidth = 2 * S;
            ctx.stroke();
          }
        }
        ctx.lineCap = 'butt';
        ctx.lineJoin = 'miter';
      }

      /* ---- 10. features: doors, portals, chests, bodies, the cannon */
      (state.features || map.features || []).forEach((f) => {
        const h = map.parse(f.hex);
        if (!h) return;
        const p = centre(h.c, h.r);
        if (f.kind === 'door') {
          icon(f.to ? 'stair' : 'door', p[0], p[1], R * 0.42, f.open);
          /* its label is drawn in the decluttered pass below */
        } else if (f.kind === 'chest') icon(f.searched ? 'chest-done' : 'chest', p[0], p[1], R * 0.36);
        else if (f.kind === 'body') icon(f.searched ? 'chest-done' : 'body', p[0], p[1], R * 0.38);
        else if (f.kind === 'cannon') icon('cannon', p[0], p[1], R * 0.46);
        else if (f.kind === 'well') icon('well', p[0], p[1], R * 0.34);
      });

      if (state.hover) {
        const p = centre(state.hover.c, state.hover.r);
        path(p[0], p[1]);
        ctx.strokeStyle = '#9E3729';
        ctx.lineWidth = 2.6 * S;
        ctx.stroke();
      }

      /* where the tutorial is asking them to walk */
      const tgt = state.target ? map.parse(state.target) : null;
      if (tgt) {
        const p = centre(tgt.c, tgt.r);
        ctx.save();
        path(p[0], p[1]);
        ctx.fillStyle = 'rgba(158,55,41,.18)';
        ctx.fill();
        ctx.setLineDash([6 * S, 4 * S]);
        ctx.strokeStyle = '#9E3729';
        ctx.lineWidth = 3.4 * S;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }

      /* ---- 10b. THE WRITING ON THE MAP, decluttered. */
      const labels = [];
      if (state.target && map.parse(state.target)) {
        const th = map.parse(state.target);
        const tp = centre(th.c, th.r);
        labels.push({ text: 'GO HERE', x: tp[0], y: tp[1] - R * 0.58,
                      colour: 'rgba(158,55,41,.98)', rank: -1, size: 0.27 });
      }
      (state.features || map.features || []).forEach((f) => {
        if (!f.to || f.open === false) return;
        const hx = map.parse(f.hex);
        if (!hx) return;
        const p = centre(hx.c, hx.r);
        labels.push({ text: f.to.label || 'IN', x: p[0], y: p[1] - R * 0.58,
                      colour: 'rgba(47,86,92,.95)', rank: 0, size: 0.26 });
      });
      if (state.showLabels !== false) {
        map.landmarks.forEach((l) => {
          const hx = map.parse(l.hex);
          if (!hx) return;
          /* When the hexes are small there is only room for what matters. */
          if (R < 26 && !l.key) return;
          const p = centre(hx.c, hx.r);
          labels.push({ text: l.label, x: p[0], y: p[1] + R - 2 * S,
                        colour: l.key ? 'rgba(158,55,41,.95)' : 'rgba(52,66,72,.9)',
                        rank: l.key ? 1 : 2, size: 0.25 });
        });
      }
      if (labels.length && R > 11) {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        const taken = [];
        labels.sort((a, b) => a.rank - b.rank);
        labels.forEach((L) => {
          const px = Math.max(6, R * L.size);
          ctx.font = px.toFixed(0) + 'px "IBM Plex Mono", monospace';
          const w = ctx.measureText(L.text).width;
          const box = [L.x - w / 2 - 2 * S, L.y - px, L.x + w / 2 + 2 * S, L.y + px * 0.3];
          const clash = taken.some((t) =>
            box[0] < t[2] && box[2] > t[0] && box[1] < t[3] && box[3] > t[1]);
          if (clash) return;
          taken.push(box);
          ctx.lineWidth = 3.4 * S;
          ctx.strokeStyle = map.indoors ? 'rgba(222,217,201,.92)' : 'rgba(242,243,238,.92)';
          ctx.strokeText(L.text, L.x, L.y);
          ctx.fillStyle = L.colour;
          ctx.fillText(L.text, L.x, L.y);
        });
      }

      /* ---- 12. THE PEOPLE THE STORY IS ABOUT. NPCs are square, so they are
       * never confused with a classmate, and they are named. Ponton standing
       * on his own doorstep is the difference between a board and a town. */
      (state.npcs || []).forEach(function (n) {
        const h = map.parse(n.hex);
        if (!h) return;
        const p = centre(h.c, h.r);
        const s = R * 0.24;
        ctx.save();
        ctx.translate(p[0], p[1]);
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = 'rgba(27,42,51,.22)';
        ctx.fillRect(-s + 1.5 * S, -s + 1.5 * S, s * 2, s * 2);
        ctx.fillStyle = n.color || '#C39355';
        ctx.fillRect(-s, -s, s * 2, s * 2);
        ctx.strokeStyle = '#F2F3EE';
        ctx.lineWidth = 1.7 * S;
        ctx.strokeRect(-s, -s, s * 2, s * 2);
        ctx.restore();
        if (n.name && R > 16) {
          ctx.font = (R * 0.24).toFixed(0) + 'px "IBM Plex Sans", sans-serif';
          ctx.textAlign = 'center';
          ctx.lineWidth = 3 * S;
          ctx.strokeStyle = 'rgba(242,243,238,.85)';
          ctx.strokeText(n.name, p[0], p[1] - R * 0.44);
          ctx.fillStyle = 'rgba(90,72,42,.95)';
          ctx.fillText(n.name, p[0], p[1] - R * 0.44);
        }
      });

      /* ---- 13. everybody else, in their company's colour, with a name.
       * A hollow token means they are INSIDE this building and cannot see you
       * — the independent-map rule, made visible. */
      (state.tokens || []).forEach(function (tk) {
        const h = map.parse(tk.hex);
        if (!h) return;
        const p = centre(h.c, h.r);
        const rad = R * 0.27;
        const x = p[0] + (tk.dx || 0) * S, y = p[1] + (tk.dy || 0) * S;
        ctx.save();
        /* tint is the colour this student chose for themselves; color is their
         * company's, which five of them share. Prefer the one that identifies
         * a person over the one that identifies a group. */
        const mine = tk.tint || tk.color || '#55666E';
        /* A hollow figure is filled with paper, so a paper rim would erase it.
         * Outline it in their own colour instead — which also keeps the
         * doorstep readable as belonging to someone in particular. */
        figurine(ctx, x, y, R * 0.40, tk.calling, mine,
                 tk.elsewhere ? mine : '#F2F3EE', !!tk.elsewhere);
        if (tk.elsewhere) {
          /* INSIDE a building: hollow, and ringed in their own colour so you
           * can still tell whose doorstep it is. */
          ctx.strokeStyle = mine;
          ctx.lineWidth = 2.2 * S;
          ctx.setLineDash([2.5 * S, 2.5 * S]);
          ctx.beginPath();
          ctx.arc(x, y, rad * 1.5, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        if (tk.declared) {                    // already acted this turn
          ctx.beginPath();
          ctx.arc(x, y, rad * 1.62, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(57,100,107,.8)';
          ctx.lineWidth = 1.5 * S;
          ctx.stroke();
        }
        if (tk.name && R > 17) {
          ctx.font = (R * 0.26).toFixed(0) + 'px "IBM Plex Sans", sans-serif';
          ctx.textAlign = 'center';
          ctx.lineWidth = 3 * S;
          ctx.strokeStyle = 'rgba(242,243,238,.85)';
          ctx.strokeText(tk.name, x, y - rad - 3 * S);
          ctx.fillStyle = 'rgba(27,42,51,.86)';
          ctx.fillText(tk.name, x, y - rad - 3 * S);
        }
        ctx.restore();
      });

      /* ---- 14. you, unmistakably.
       *
       * state.walk = { route: [hex…], t: 0..1 } puts the token part-way along
       * a walk instead of at `you`. The server has already moved them — this
       * is purely so the eye sees a person cross three hexes rather than
       * vanish from one and appear in another. */
      if (you) {
        let p = centre(you.c, you.r);
        const w = state.walk;
        if (w && w.route && w.route.length > 1) {
          const legs = w.route.length - 1;
          const at = Math.max(0, Math.min(1, w.t)) * legs;
          const i = Math.min(legs - 1, Math.floor(at));
          const f = at - i;
          const a = map.parse(w.route[i]);
          const b = map.parse(w.route[i + 1]);
          if (a && b) {
            const pa = centre(a.c, a.r);
            const pb = centre(b.c, b.r);
            p = [pa[0] + (pb[0] - pa[0]) * f, pa[1] + (pb[1] - pa[1]) * f];
          }
        }
        /* The ring marks the hex you now OWN, which is where the server has
         * already put you; the dot is the body, which may still be walking
         * there. Ringing an interpolated position would outline the gap
         * between two hexes and look like a rendering fault. */
        const home = centre(you.c, you.r);
        path(home[0], home[1]);
        ctx.strokeStyle = '#1B2A33';
        ctx.lineWidth = 3 * S;
        ctx.stroke();

        /* YOUR OWN FIGURINE, in the colour you chose, because "which one is
         * me" must never be a question — the hex ring answers it, and the
         * figure answers "and what am I". It used to be a plain black dot,
         * which made your own token the one thing on the board that did not
         * look like your character. */
        figurine(ctx, p[0], p[1], R * 0.44, state.calling,
                 state.tint || '#1B2A33', '#F2F3EE', false);
      }
    }

    function hexA(hex, a) {
      const h = String(hex || '#000').replace('#', '');
      const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16);
      return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
    }

    return { draw: draw, hitTest: hitTest, layout: layout, get radius() { return R; } };
  }

  /* ------------------------------------------------------------- the key
   *
   * A legend that draws its own approximation of the map is a lie waiting to
   * happen — somebody changes the grass and the key still shows the old grass.
   * So a swatch is a REAL one-hex map put through the REAL renderer. If the key
   * and the map ever disagree it is because the code disagrees with itself. */
  function Swatch(canvas, spec, light) {
    const legend = {};
    const g = spec.glyph || 'z';
    legend[g] = spec.terrain || { name: '', cost: 1, fill: '#E9EBE4' };
    const fake = make({
      id: 'swatch', cols: 1, rows: 1, grid: [g], legend: legend,
      landmarks: [], items: [],
      lightTable: {}, weatherTable: {},
      features: spec.icon
        ? [{ id: 'S', kind: spec.icon, hex: 'A1', label: '',
             open: spec.open, searched: spec.searched, to: spec.to || null }]
        : [],
    });
    Renderer(canvas, fake).draw({ showLabels: false, light: light || null });
  }

  /* ONE figurine, drawn big, on a canvas of its own.
   *
   * Used by the creation screen so the preview a student picks their colour
   * against is produced by the same function that draws them on the board.
   * A hand-drawn preview would be a lie waiting to happen — somebody changes
   * the smith's hammer and the creation screen keeps the old one. */
  function Figurine(canvas, opts) {
    opts = opts || {};
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const w = canvas.clientWidth || canvas.width || 200;
    const h = canvas.clientHeight || canvas.height || 200;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const size = Math.min(canvas.width, canvas.height) * 0.36;
    figurine(ctx, canvas.width / 2, canvas.height / 2, size,
             opts.calling, opts.tint || '#4A5560', opts.rim || '#F2F3EE', false);
  }

  return { make: make, hydrate: hydrate, Renderer: Renderer, Swatch: Swatch, Figurine: Figurine, LETTERS: LETTERS };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = HexMap;
