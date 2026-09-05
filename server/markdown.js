/* markdown.js — the small, deliberately incomplete markdown reader.
 *
 * Shared by server/handouts.js (the twelve primary sources) and
 * server/people.js (the person cards). Both are markdown a teacher writes and
 * edits for years; both are rendered on a student's screen.
 *
 * IT RETURNS BLOCKS, NOT HTML, AND THAT IS THE POINT.
 *
 * The client renders these by building elements and setting textContent. It
 * never assigns innerHTML from this data. So the whole path is XSS-proof by
 * construction rather than by careful escaping — which matters because these
 * files get edited by someone transcribing an 1836 letter, who is not thinking
 * about angle brackets.
 *
 * WHAT IS NOT PARSED
 *
 * Inline markdown other than **bold** — no links, no images, no nested
 * emphasis. Deliberate: a primary source needs a quotation and a citation, not
 * typography, and every construct supported is a construct that can go wrong
 * in front of a class.
 */

/* ---------------------------------------------------------------- inline
 * **bold** only, as a run list. The client turns a run with bold:true into a
 * <b> whose textContent is the text — so a stray < in a transcript is a
 * less-than sign and never a tag. */
function runs(line) {
  const out = [];
  let rest = String(line);
  const re = /\*\*(.+?)\*\*/;
  for (;;) {
    const m = re.exec(rest);
    if (!m) break;
    if (m.index > 0) out.push({ t: rest.slice(0, m.index) });
    out.push({ t: m[1], b: true });
    rest = rest.slice(m.index + m[0].length);
  }
  if (rest) out.push({ t: rest });
  return out.length ? out : [{ t: '' }];
}

/* ------------------------------------------------------------------ blocks */
function parse(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  const flushPara = (buf) => {
    if (!buf.length) return;
    blocks.push({ type: 'p', runs: runs(buf.join(' ').trim()) });
    buf.length = 0;
  };

  let para = [];
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();

    /* headings */
    let m = /^(#{1,4})\s+(.*)$/.exec(line);
    if (m) {
      flushPara(para);
      blocks.push({ type: 'h', level: m[1].length, runs: runs(m[2]) });
      i += 1; continue;
    }

    /* a rule */
    if (/^-{3,}$/.test(line) || /^\*{3,}$/.test(line)) {
      flushPara(para);
      blocks.push({ type: 'hr' });
      i += 1; continue;
    }

    /* a table: any run of lines starting with | */
    if (/^\|/.test(line)) {
      flushPara(para);
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|')
          .map((c) => c.trim());
        /* the |---|---| separator row carries no content */
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) {
          rows.push(cells.map((c) => runs(c)));
        }
        i += 1;
      }
      if (rows.length) blocks.push({ type: 'table', rows: rows });
      continue;
    }

    /* a blockquote: this is where the document itself lives */
    if (/^>/.test(line)) {
      flushPara(para);
      const paras = [];
      let buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        const t = lines[i].replace(/^\s*>\s?/, '').trimEnd();
        if (t === '') { if (buf.length) { paras.push(buf.join(' ')); buf = []; } }
        else buf.push(t);
        i += 1;
      }
      if (buf.length) paras.push(buf.join(' '));
      blocks.push({ type: 'quote', paras: paras.map((p) => runs(p)) });
      continue;
    }

    /* a list */
    if (/^[-*+]\s+/.test(line) || /^\d+[.)]\s+/.test(line)) {
      flushPara(para);
      const items = [];
      while (i < lines.length) {
        const t = lines[i].trim();
        const li = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(t);
        if (!li) break;
        items.push(runs(li[1]));
        i += 1;
      }
      blocks.push({ type: 'list', items: items });
      continue;
    }

    if (line === '') { flushPara(para); i += 1; continue; }

    para.push(line);
    i += 1;
  }
  flushPara(para);
  return blocks;
}


module.exports = { parse, runs };
