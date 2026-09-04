/* handouts.js — the primary documents, on the screen instead of on paper.
 *
 * design/13-migration-plan.md said, in a table, of the thirteen handouts and
 * the person cards: "A student reading Travis's actual handwriting off a sheet
 * in their own hands beats reading it on a Chromebook … Do not migrate these.
 * Print them." That was a real argument and it has been overruled by the
 * teacher who has to run the room: there will be no paper. So the documents
 * have to arrive on the screen, at the moment they are needed, without anybody
 * remembering to do anything.
 *
 * WHY THE MARKDOWN STAYS THE SOURCE
 *
 * handouts/*.md is where these were written, where the provenance was checked,
 * and where they will be corrected. Copying them into a JSON file would create
 * two versions of a primary source, which is precisely the kind of drift that
 * makes a history classroom untrustworthy. So the markdown is read at startup
 * and parsed into blocks. Edit the markdown, restart, done — no build step to
 * forget.
 *
 * WHY BLOCKS AND NOT MARKDOWN-TO-HTML
 *
 * The client renders these blocks by building elements and setting
 * textContent. It never assigns innerHTML from this data. That makes the whole
 * path XSS-proof by construction rather than by careful escaping, which
 * matters because these files will be edited for years by someone who is not
 * thinking about injection while transcribing an 1836 letter.
 *
 * WHAT IS NOT PARSED
 *
 * Inline markdown other than **bold** — no links, no images, no nested
 * emphasis. Deliberate: a primary source needs a quotation and a citation, not
 * typography, and every construct supported is a construct that can go wrong
 * in front of a class.
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'handouts');

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

/* ------------------------------------------------------------------- load */
let cache = null;

function load() {
  if (cache) return cache;
  cache = { byId: {}, order: [] };
  let files = [];
  try { files = fs.readdirSync(DIR).filter((f) => /^\d\d-.*\.md$/.test(f)).sort(); }
  catch (e) { return cache; }              // no handouts folder: not an error

  files.forEach((f) => {
    const id = f.slice(0, 2);
    let md = '';
    try { md = fs.readFileSync(path.join(DIR, f), 'utf8'); } catch (e) { return; }
    const blocks = parse(md);

    /* The title is the first heading, with the "Handout 1: " prefix taken off
     * — a student does not need the filing system, and "Handout 1" is not what
     * the document is called. */
    const head = blocks.filter((b) => b.type === 'h')[0];
    const rawTitle = head ? head.runs.map((r) => r.t).join('') : f;
    const title = rawTitle.replace(/^handout\s*\d+\s*[:—-]\s*/i, '').trim();

    /* "**What this is:** …" is the one-sentence orientation every file opens
     * with. Pulled out so a card can show it without opening the document. */
    let blurb = '';
    for (const b of blocks) {
      if (b.type !== 'p') continue;
      const flat = b.runs.map((r) => r.t).join('');
      const m = /^What this is:\s*(.*)$/i.exec(flat);
      if (m) { blurb = m[1].trim(); break; }
    }

    cache.byId[id] = { id: id, file: f, title: title, blurb: blurb, blocks: blocks };
    cache.order.push(id);
  });
  return cache;
}

module.exports = {
  /* ids and titles only — this is what the shelf lists.
   *
   * 00-INDEX.md is the teacher's contents page for the paper set. It has no
   * document in it and no business on a student's shelf. */
  list() {
    const c = load();
    return c.order.filter((id) => id !== '00').map((id) => ({
      id: id, title: c.byId[id].title, blurb: c.byId[id].blurb,
    }));
  },

  /* one document, in full. `id` is validated to exactly two digits by the
   * caller's regex AND by the lookup being a plain key on a built map — there
   * is no path here for a request to reach, so traversal is not possible. */
  get(id) {
    const c = load();
    return c.byId[String(id)] || null;
  },

  has(id) { return !!load().byId[String(id)]; },

  /* for tests */
  _parse: parse,
};
