/* qr.js — a QR code, offline, in about three hundred lines.
 *
 * WHY THIS IS HERE AT ALL
 *
 * The student URL is `http://10.5.0.2:8099/p`. Thirty twelve-year-olds typing
 * an IP address get it wrong, and every one who gets it wrong needs the
 * teacher — which is the exact thing design/14-autopilot.md is trying to
 * prevent. A code on the projector is a camera away instead.
 *
 * It does NOT reach the internet. The whole promise of this app is that
 * nothing leaves the machine, and a QR service would break that for the sake
 * of a 25x25 grid of squares. So it is generated here.
 *
 * SCOPE, deliberately narrow: byte mode, error level M, versions 1 to 6
 * (up to 106 bytes). That covers every URL this server can ever print —
 * `http://255.255.255.255:8099/play.html` is 38 characters — and it stops
 * short of version 7, where the alignment-pattern grid and the version
 * information block both get complicated for no benefit here. */

const QR = (function () {

  /* ---------------------------------------------------------- GF(256)
   * Reed-Solomon needs log/antilog tables over the field the QR spec uses,
   * which is GF(256) with the primitive polynomial 0x11d. */
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const mul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

  /* the generator polynomial for `n` error-correction codewords */
  function generator(n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const next = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) {
        next[j] ^= g[j];
        next[j + 1] ^= mul(g[j], EXP[i]);
      }
      g = next;
    }
    return g;
  }

  function ecc(data, n) {
    const g = generator(n);
    const out = new Array(n).fill(0);
    data.forEach((byte) => {
      const factor = byte ^ out[0];
      out.shift();
      out.push(0);
      if (factor !== 0) {
        for (let i = 0; i < n; i++) out[i] ^= mul(g[i + 1], factor);
      }
    });
    return out;
  }

  /* ------------------------------------------------- version tables, level M
   * [ total codewords, blocks, data codewords per block ]
   * EC per block is (total/blocks) - dataPerBlock. */
  const V = {
    1: [26, 1, 16],
    2: [44, 1, 28],
    3: [70, 1, 44],
    4: [100, 2, 32],
    5: [134, 2, 43],
    6: [172, 4, 27],
  };
  /* how many raw bytes of payload each version holds, once the 4-bit mode
   * indicator and the 8-bit length are paid for */
  const CAP = { 1: 14, 2: 26, 3: 42, 4: 62, 5: 84, 6: 106 };

  function pickVersion(len) {
    for (let v = 1; v <= 6; v++) if (len <= CAP[v]) return v;
    return null;
  }

  /* ------------------------------------------------------------- bitstream */
  function bitstream(bytes, version) {
    const [total, blocks, perBlock] = V[version];
    const dataCodewords = blocks * perBlock;
    const bits = [];
    const push = (value, n) => { for (let i = n - 1; i >= 0; i--) bits.push((value >> i) & 1); };

    push(0b0100, 4);              // byte mode
    push(bytes.length, 8);        // versions 1-9 use an 8-bit length
    bytes.forEach((b) => push(b, 8));

    /* terminator, then round up to a whole codeword */
    const cap = dataCodewords * 8;
    for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);

    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
      data.push(byte);
    }
    /* the spec's pad bytes, alternating, until the block is full */
    const PAD = [0xec, 0x11];
    let k = 0;
    while (data.length < dataCodewords) data.push(PAD[k++ % 2]);

    /* split into blocks, error-correct each, then INTERLEAVE — the spec
     * interleaves so a scratch across the printed code damages one codeword in
     * each block rather than destroying one block entirely */
    const ecPerBlock = (total / blocks) - perBlock;
    const dataBlocks = [], ecBlocks = [];
    for (let b = 0; b < blocks; b++) {
      const chunk = data.slice(b * perBlock, (b + 1) * perBlock);
      dataBlocks.push(chunk);
      ecBlocks.push(ecc(chunk, ecPerBlock));
    }
    const out = [];
    for (let i = 0; i < perBlock; i++) dataBlocks.forEach((b) => out.push(b[i]));
    for (let i = 0; i < ecPerBlock; i++) ecBlocks.forEach((b) => out.push(b[i]));
    return out;
  }

  /* ----------------------------------------------------------- the matrix */
  function build(codewords, version, mask) {
    const size = 17 + version * 4;
    const m = [];                 // null = not yet written
    const fn = [];                // true = function pattern, data may not go here
    for (let i = 0; i < size; i++) {
      m.push(new Array(size).fill(null));
      fn.push(new Array(size).fill(false));
    }
    const set = (r, c, v, isFn) => {
      if (r < 0 || c < 0 || r >= size || c >= size) return;
      m[r][c] = v ? 1 : 0;
      if (isFn) fn[r][c] = true;
    };

    /* three finder patterns and their separators */
    const finder = (r0, c0) => {
      for (let r = -1; r <= 7; r++) {
        for (let c = -1; c <= 7; c++) {
          const rr = r0 + r, cc = c0 + c;
          if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
          const ring = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                       (c >= 0 && c <= 6 && (r === 0 || r === 6));
          const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          set(rr, cc, ring || core, true);
        }
      }
    };
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

    /* timing patterns, row and column 6 */
    for (let i = 8; i < size - 8; i++) {
      set(6, i, i % 2 === 0, true);
      set(i, 6, i % 2 === 0, true);
    }

    /* one alignment pattern, bottom right — true for versions 2 to 6 */
    if (version >= 2) {
      const a = size - 7;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const ring = Math.max(Math.abs(r), Math.abs(c));
          set(a + r, a + c, ring !== 1, true);
        }
      }
    }

    set(size - 8, 8, 1, true);          // the dark module, always

    /* Reserve the format information areas — SKIPPING index 6, which is the
     * timing pattern and not ours to blank. */
    for (let i = 0; i < 9; i++) {
      if (i === 6) continue;
      set(8, i, 0, true);
      set(i, 8, 0, true);
    }
    for (let i = 0; i < 8; i++) { set(8, size - 1 - i, 0, true); set(size - 1 - i, 8, 0, true); }

    /* ---- the data, in two-wide columns, zigzagging, right to left */
    let bitIndex = 0;
    const nextBit = () => {
      const byte = codewords[bitIndex >> 3];
      const bit = byte === undefined ? 0 : (byte >> (7 - (bitIndex & 7))) & 1;
      bitIndex++;
      return bit;
    };
    let up = true;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;             // the timing column is not a data column
      for (let i = 0; i < size; i++) {
        const row = up ? size - 1 - i : i;
        for (let k = 0; k < 2; k++) {
          const c = col - k;
          if (fn[row][c]) continue;
          let bit = nextBit();
          if (maskAt(mask, row, c)) bit ^= 1;
          m[row][c] = bit;
        }
      }
      up = !up;
    }

    /* ---- format information: 5 data bits, BCH(15,5), then a fixed XOR */
    const fmtData = (0b00 << 3) | mask;        // 00 = error level M
    let bch = fmtData << 10;
    for (let i = 4; i >= 0; i--) {
      if (bch & (1 << (i + 10))) bch ^= 0x537 << i;
    }
    const fmt = ((fmtData << 10) | bch) ^ 0x5412;
    const fmtBit = (i) => (fmt >> i) & 1;

    for (let i = 0; i <= 5; i++) set(8, i, fmtBit(i), true);
    set(8, 7, fmtBit(6), true);
    set(8, 8, fmtBit(7), true);
    set(7, 8, fmtBit(8), true);
    for (let i = 9; i <= 14; i++) set(14 - i, 8, fmtBit(i), true);

    for (let i = 0; i <= 6; i++) set(size - 1 - i, 8, fmtBit(i), true);
    for (let i = 7; i <= 14; i++) set(8, size - 8 + (i - 7), fmtBit(i), true);
    set(size - 8, 8, 1, true);          // the dark module belongs to nobody

    return m;
  }

  function maskAt(mask, r, c) {
    switch (mask) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
  }

  /* The spec's four penalty rules. Picking the lowest-scoring mask is what
   * keeps a code readable at an angle, in classroom light, on a projector. */
  function penalty(m) {
    const n = m.length;
    let score = 0;

    const run = (get) => {
      for (let a = 0; a < n; a++) {
        let last = -1, len = 0;
        for (let b = 0; b < n; b++) {
          const v = get(a, b);
          if (v === last) { len++; } else { last = v; len = 1; }
          if (len === 5) score += 3;
          else if (len > 5) score += 1;
        }
      }
    };
    run((a, b) => m[a][b]);
    run((a, b) => m[b][a]);

    for (let r = 0; r < n - 1; r++) {
      for (let c = 0; c < n - 1; c++) {
        const v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
      }
    }

    /* the 1:1:3:1:1 finder-lookalike, which confuses a scanner badly */
    const PAT = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const RPAT = PAT.slice().reverse();
    const hunt = (get) => {
      for (let a = 0; a < n; a++) {
        for (let b = 0; b <= n - 11; b++) {
          let f = true, g = true;
          for (let k = 0; k < 11; k++) {
            const v = get(a, b + k);
            if (v !== PAT[k]) f = false;
            if (v !== RPAT[k]) g = false;
          }
          if (f || g) score += 40;
        }
      }
    };
    hunt((a, b) => m[a][b]);
    hunt((a, b) => m[b][a]);

    let dark = 0;
    m.forEach((row) => row.forEach((v) => { if (v) dark++; }));
    const pct = (dark * 100) / (n * n);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  /* ------------------------------------------------------------------ api */

  /* text -> a 2D array of 0/1, quiet zone NOT included */
  function encode(text) {
    const bytes = [];
    for (const ch of String(text)) {
      const cp = ch.codePointAt(0);
      if (cp < 0x80) bytes.push(cp);
      else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
      else bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    }
    const version = pickVersion(bytes.length);
    if (!version) return null;              // longer than 106 bytes: not our job
    const codewords = bitstream(bytes, version);
    let best = null, bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const m = build(codewords, version, mask);
      const s = penalty(m);
      if (s < bestScore) { bestScore = s; best = m; }
    }
    return best;
  }

  /* Draw it into a canvas, sized to fit, with the four-module quiet zone the
   * spec requires — a code printed flush to its border does not scan. */
  function draw(canvas, text, opts) {
    opts = opts || {};
    const m = encode(text);
    if (!m) return false;
    const quiet = opts.quiet === undefined ? 4 : opts.quiet;
    const n = m.length + quiet * 2;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const css = opts.size || canvas.clientWidth || 240;
    const scale = Math.max(1, Math.floor((css * dpr) / n));
    const px = n * scale;
    canvas.width = px;
    canvas.height = px;
    canvas.style.width = css + 'px';
    canvas.style.height = css + 'px';
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = opts.light || '#FFFFFF';
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = opts.dark || '#1B2A33';
    for (let r = 0; r < m.length; r++) {
      for (let c = 0; c < m.length; c++) {
        if (m[r][c]) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
      }
    }
    return true;
  }

  return { encode: encode, draw: draw };
})();

if (typeof window !== 'undefined') window.QR = QR;
if (typeof module !== 'undefined' && module.exports) module.exports = QR;
