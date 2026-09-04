/* store.js — JSON on disk. Zero dependencies, atomic writes.
 *
 * WHAT IS IN THESE FILES, AND WHAT IS NOT
 * Character ids, hexes, flags, facts received, Legacy, and where the lesson
 * had got to. No student names, no emails, no ages, no school identifiers —
 * there is nowhere in the application to enter any of those (design/09), so
 * there is nothing of that kind to write down. A row reads
 * "p03 · Jacob C. Darst · 7 Legacy", and Jacob C. Darst died in 1836.
 *
 * The roster that maps a real student to a character stays on paper, with the
 * teacher, exactly as it does now.
 *
 * ATOMIC BECAUSE A LAPTOP LID CLOSES MID-WRITE. Write to a temp file, fsync,
 * rename. A rename is atomic on every filesystem this will ever run on, so the
 * worst case is losing the last few seconds, never a half-written file that
 * refuses to load on Monday morning. */

const fs = require('fs');
const path = require('path');

class Store {
  constructor(dir) {
    this.dir = dir;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  }

  _file(key) {
    /* A class code becomes a filename, so it may only ever be a class code. */
    const safe = String(key).toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24);
    return path.join(this.dir, safe + '.json');
  }

  read(key) {
    try {
      const raw = fs.readFileSync(this._file(key), 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        /* A corrupt file must not stop a lesson. Move it aside and start
         * clean — the teacher gets a working room, and the wreckage is kept
         * in case it can be recovered later. */
        try { fs.renameSync(this._file(key), this._file(key) + '.broken-' + Date.now()); } catch (e2) {}
        console.error('  ! ' + key + ' was unreadable and has been set aside: ' + e.message);
      }
      return null;
    }
  }

  write(key, obj) {
    const file = this._file(key);
    const tmp = file + '.tmp';
    try {
      const fd = fs.openSync(tmp, 'w');
      fs.writeSync(fd, JSON.stringify(obj, null, 1));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      console.error('  ! could not save ' + key + ': ' + e.message);
      try { fs.unlinkSync(tmp); } catch (e2) {}
      return false;
    }
  }

  list() {
    try {
      return fs.readdirSync(this.dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''));
    } catch (e) { return []; }
  }
}

module.exports = { Store };
