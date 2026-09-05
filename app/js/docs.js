/* docs.js — the primary documents, on the student's screen.
 *
 * There is no paper. So the thirteen handouts that design/13 explicitly
 * refused to migrate ("Do not migrate these. Print them.") now have to arrive
 * here, at the moment the lesson needs them, without the teacher doing
 * anything.
 *
 * TWO WAYS IN, and the first one matters most:
 *
 *   AUTOMATICALLY. A timeline segment can declare `handout: "01"`. When the
 *   lesson reaches it the server adds that document to every student's shelf
 *   and play.js opens it. The cold open is four minutes long and used to show
 *   a student nothing but "Watch the board" — that is now four minutes with
 *   the actual document in their hands.
 *
 *   ON PURPOSE. A DOCUMENTS button, and a link on any fact that rests on one,
 *   so a source read in the cold open can be re-read during the tally.
 *
 * SAFETY, and why this file has no innerHTML in it
 *
 * The blocks come from markdown that a teacher will edit for years while
 * transcribing 1836 letters — not thinking about angle brackets. Every piece
 * of text here goes in through textContent, so a stray `<` in a transcript is
 * a less-than sign. That is a property of the code rather than of anyone's
 * carefulness. See server/handouts.js.
 *
 * READING LOAD. These documents are long, and long is the point — it is a
 * primary source, not a summary. But the bottom quartile of this class reads
 * at 110 words a minute (tools/reading-load.js), so the top of every document
 * carries its own one-sentence orientation, and the verbatim passage is set
 * apart from the apparatus around it. Nobody has to read the provenance table
 * to reach the text. */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  let LIST = [];               // every document that exists
  let mine = [];               // the ids this student has been given
  let openId = null;
  let cache = {};              // id -> the parsed document
  let onNeedRedraw = null;

  /* ---------------------------------------------------------------- render
   * One element per block, built rather than templated. */
  function runsInto(el, runs) {
    (runs || []).forEach((r) => {
      if (r.b) {
        const b = document.createElement('b');
        b.textContent = r.t;
        el.appendChild(b);
      } else {
        el.appendChild(document.createTextNode(r.t));
      }
    });
  }

  function blockEl(b) {
    if (b.type === 'h') {
      /* The file's own H1 is the document title and is already in the header
       * bar, so it would appear twice. */
      const el = document.createElement(b.level <= 2 ? 'h3' : 'h4');
      el.className = 'doc-h';
      runsInto(el, b.runs);
      return el;
    }
    if (b.type === 'p') {
      const el = document.createElement('p');
      el.className = 'doc-p';
      runsInto(el, b.runs);
      return el;
    }
    if (b.type === 'hr') {
      return document.createElement('hr');
    }
    if (b.type === 'quote') {
      /* THE DOCUMENT ITSELF. Set in the serif, indented, ruled down the left —
       * so a student can see at a glance which words are the 1832 committee's
       * and which are ours. */
      const el = document.createElement('blockquote');
      el.className = 'doc-q';
      (b.paras || []).forEach((p) => {
        const q = document.createElement('p');
        runsInto(q, p);
        el.appendChild(q);
      });
      return el;
    }
    if (b.type === 'list') {
      const el = document.createElement('ul');
      el.className = 'doc-ul';
      (b.items || []).forEach((it) => {
        const li = document.createElement('li');
        runsInto(li, it);
        el.appendChild(li);
      });
      return el;
    }
    if (b.type === 'table') {
      /* The provenance box. Scrolls inside itself on a narrow Chromebook
       * rather than pushing the page sideways. */
      const wrap = document.createElement('div');
      wrap.className = 'doc-tw';
      const t = document.createElement('table');
      t.className = 'doc-t';
      (b.rows || []).forEach((row) => {
        const tr = document.createElement('tr');
        row.forEach((cell, i) => {
          const td = document.createElement(i === 0 ? 'th' : 'td');
          runsInto(td, cell);
          tr.appendChild(td);
        });
        t.appendChild(tr);
      });
      wrap.appendChild(t);
      return wrap;
    }
    return null;
  }

  function paint(doc) {
    $('doc-title').textContent = doc.title;
    $('doc-blurb').textContent = doc.blurb || '';
    $('doc-blurb').hidden = !doc.blurb;

    const body = $('doc-body');
    body.textContent = '';
    let firstHeadingSkipped = false;
    (doc.blocks || []).forEach((b) => {
      /* skip the file's own H1 — it is the title, already in the bar above */
      if (!firstHeadingSkipped && b.type === 'h' && b.level === 1) {
        firstHeadingSkipped = true;
        return;
      }
      /* and skip the "What this is:" paragraph, now shown as the blurb */
      if (b.type === 'p') {
        const flat = (b.runs || []).map((r) => r.t).join('');
        if (/^What this is:/i.test(flat)) return;
      }
      const el = blockEl(b);
      if (el) body.appendChild(el);
    });
    body.scrollTop = 0;
  }

  /* ------------------------------------------------------------------ shelf */
  function paintShelf() {
    const box = $('doc-shelf');
    if (!box) return;
    const have = LIST.filter((d) => mine.indexOf(d.id) !== -1);
    box.textContent = '';
    if (!have.length) {
      const p = document.createElement('p');
      p.className = 'doc-none';
      p.textContent = 'Your teacher has not given you a document yet.';
      box.appendChild(p);
      return;
    }
    have.forEach((d) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'doc-card' + (d.id === openId ? ' on' : '');
      b.setAttribute('data-doc', d.id);
      const t = document.createElement('span');
      t.className = 'dc-t';
      t.textContent = d.title;
      const s = document.createElement('span');
      s.className = 'dc-s';
      s.textContent = d.blurb || '';
      b.appendChild(t);
      b.appendChild(s);
      box.appendChild(b);
    });
  }

  function fetchDoc(id) {
    if (cache[id]) return Promise.resolve(cache[id]);
    return fetch('api/handout?id=' + encodeURIComponent(id), { cache: 'no-store' })
      .then((r) => r.json())
      .then((res) => {
        if (!res || !res.ok) return null;
        cache[id] = res.handout;
        return res.handout;
      })
      .catch(() => null);
  }

  /* The block renderer is the only piece of this file the person card needs,
   * and a second copy of it would be a second thing to keep in step. */
  function renderBlocks(into, blocks, opts) {
    opts = opts || {};
    into.textContent = '';
    let firstH1Skipped = false;
    (blocks || []).forEach((b) => {
      if (opts.skipFirstH1 && !firstH1Skipped && b.type === 'h' && b.level === 1) {
        firstH1Skipped = true;
        return;
      }
      const el = blockEl(b);
      if (el) into.appendChild(el);
    });
  }

  const Docs = {
    renderBlocks: renderBlocks,
    /* Called once at boot. Failing is survivable: the button simply says the
     * documents could not be loaded, and the lesson goes on. */
    init(opts) {
      onNeedRedraw = (opts || {}).onChange || null;
      return fetch('api/handouts', { cache: 'no-store' })
        .then((r) => r.json())
        .then((res) => { LIST = (res && res.handouts) || []; paintShelf(); return LIST; })
        .catch(() => { LIST = []; return LIST; });
    },

    /* the ids this student has been given, from the server */
    setMine(ids) {
      const next = (ids || []).slice();
      const changed = next.join(',') !== mine.join(',');
      mine = next;
      if (changed) paintShelf();
      return changed;
    },

    get mine() { return mine.slice(); },
    get count() { return mine.length; },
    get isOpen() { return !!openId; },

    titleOf(id) {
      const d = LIST.filter((x) => x.id === id)[0];
      return d ? d.title : 'Document ' + id;
    },

    open(id) {
      if (!id) return Promise.resolve(false);
      return fetchDoc(id).then((doc) => {
        if (!doc) return false;
        openId = id;
        paint(doc);
        paintShelf();
        $('docs').hidden = false;
        document.body.classList.add('reading');
        if (onNeedRedraw) onNeedRedraw();
        return true;
      });
    },

    close() {
      openId = null;
      $('docs').hidden = true;
      document.body.classList.remove('reading');
      paintShelf();
      if (onNeedRedraw) onNeedRedraw();
    },

    /* WHO YOU ACTUALLY WERE.
     *
     * Shown in the same reader as the primary sources, on purpose: a student's
     * own biography and Travis's letter are the same kind of thing — a record
     * somebody kept, with gaps in it. Using a different panel would suggest
     * otherwise. */
    showCard(res) {
      if (!res || !res.card) return false;
      openId = null;
      $('doc-title').textContent = res.name;
      const bits = [res.role, res.calling, res.company].filter(Boolean);
      $('doc-blurb').textContent = bits.join(' · ');
      $('doc-blurb').hidden = !bits.length;
      renderBlocks($('doc-body'), res.card.blocks);
      $('doc-body').scrollTop = 0;
      paintShelf();
      $('docs').hidden = false;
      document.body.classList.add('reading');
      return true;
    },

    /* WHAT YOU DID TODAY.
     *
     * The closing checklist asks for four sentences "from your Turn Log", and
     * the Turn Log was paper. This is the same list, kept by the server as the
     * student played it: what they tried, how it went, and what it taught them.
     *
     * Shown in the reader with the documents because it is the same kind of
     * thing — a record somebody kept. Theirs, this time. */
    showDay(trail, who) {
      openId = null;
      const list = (trail || []).slice();
      $('doc-title').textContent = 'What you did today';
      $('doc-blurb').textContent = who || '';
      $('doc-blurb').hidden = !who;

      const body = $('doc-body');
      body.textContent = '';

      if (!list.length) {
        const p = document.createElement('p');
        p.className = 'doc-p';
        p.textContent = 'You have not taken a turn yet.';
        body.appendChild(p);
      } else {
        const ol = document.createElement('ol');
        ol.className = 'day-list';
        list.forEach((e) => {
          const li = document.createElement('li');
          li.className = 'day-row';

          const lab = document.createElement('span');
          lab.className = 'day-what';
          lab.textContent = e.label || '';
          li.appendChild(lab);

          /* tier is null for the actions that do not roll — opening a door,
           * walking through one. Those still belong in the record. */
          if (e.tier) {
            const t = document.createElement('span');
            t.className = 'day-tier mono t-' + String(e.tier).replace(/[^a-z]/gi, '');
            t.textContent = String(e.tier).replace(/_/g, ' ').toUpperCase();
            li.appendChild(t);
          }
          if (e.taught && e.taught.length) {
            const k = document.createElement('span');
            k.className = 'day-learned';
            k.textContent = 'you found out: ' + e.taught.join(', ');
            li.appendChild(k);
          }
          ol.appendChild(li);
        });
        body.appendChild(ol);
      }
      body.scrollTop = 0;
      paintShelf();
      $('docs').hidden = false;
      document.body.classList.add('reading');
    },

    /* the shelf on its own, with nothing open */
    openShelf() {
      openId = null;
      $('doc-title').textContent = 'Your documents';
      $('doc-blurb').hidden = true;
      $('doc-body').textContent = '';
      paintShelf();
      $('docs').hidden = false;
      document.body.classList.add('reading');
    },

    wire() {
      const close = $('doc-close');
      if (close) close.addEventListener('click', () => Docs.close());
      const shelf = $('doc-shelf');
      if (shelf) {
        shelf.addEventListener('click', (e) => {
          const b = e.target.closest('[data-doc]');
          if (b) Docs.open(b.getAttribute('data-doc'));
        });
      }
      /* Escape closes it, because a document that traps you is worse than no
       * document — and a twelve-year-old will find the key before the button. */
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !$('docs').hidden) Docs.close();
      });
    },
  };

  window.Docs = Docs;
}());
