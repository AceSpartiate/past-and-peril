/* get-voices.mjs — fetch the neural voices named in tools/voices.json.
 *
 *     node tools/get-voices.mjs
 *
 * WHY THIS IS A SEPARATE STEP FROM PLAYING THE GAME
 *
 * A teacher opening this project on a new school computer should NOT have to
 * run this. The rendered mp3s in app/audio/ are committed, and the game plays
 * them with no Python, no download and no account. This script exists for one
 * person: whoever EDITS THE WRITING and needs to re-render a line.
 *
 * The models go into voices/, which is gitignored, and they stay there. They
 * are ~63 MB each; six of them is 380 MB of undeltifiable binary that would
 * live in git history forever, and the two best-sounding 'high' voices are over
 * GitHub's 100 MiB hard push limit and would be rejected outright. Committing
 * rendered audio instead is ~1/30th the size AND removes a setup step. See
 * VOICE_LICENSES.md.
 *
 * Every voice's MODEL_CARD is downloaded next to it, on purpose. If anybody
 * ever asks where a voice came from, that is a five-second answer instead of a
 * research project. */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const OUT = path.join(ROOT, 'voices');
const BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';

const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'voices.json'), 'utf8'));
fs.mkdirSync(OUT, { recursive: true });

function human(n) {
  return n > 1e6 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' kB';
}

async function grab(url, dest, expect) {
  if (fs.existsSync(dest)) {
    const have = fs.statSync(dest).size;
    if (!expect || have === expect) return { skipped: true, bytes: have };
    console.log('    size mismatch, refetching (' + human(have) + ' != ' + human(expect) + ')');
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(res.status + ' ' + res.statusText + '  ' + url);
  const buf = Buffer.from(await res.arrayBuffer());
  /* Write to a temp name and rename, so a interrupted download never leaves a
   * half a voice behind that looks complete on the next run. */
  fs.writeFileSync(dest + '.part', buf);
  fs.renameSync(dest + '.part', dest);
  return { skipped: false, bytes: buf.length };
}

console.log('\nVOICES — fetching into voices/  (gitignored; the game does not need them)\n');

let total = 0, failed = 0;
for (const v of cfg.voices) {
  console.log('  ' + v.id + '   ' + v.license + (v.clean ? '' : '   [see caveat]'));
  for (const [suffix, expect] of [['.onnx', v.bytes], ['.onnx.json', null]]) {
    const url = BASE + '/' + v.path + '/' + v.id + suffix;
    const dest = path.join(OUT, v.id + suffix);
    try {
      const r = await grab(url, dest, expect);
      total += r.bytes;
      console.log('      ' + (r.skipped ? 'have  ' : 'got   ') + human(r.bytes) + '  ' + v.id + suffix);
    } catch (e) {
      failed++;
      console.log('      FAILED  ' + v.id + suffix + '  — ' + e.message);
    }
  }
  /* The licence, kept beside the file it licenses. */
  try {
    const card = await fetch(BASE + '/' + v.path + '/MODEL_CARD');
    if (card.ok) {
      fs.writeFileSync(path.join(OUT, v.id + '.MODEL_CARD.txt'), await card.text());
    }
  } catch (e) { /* the card is documentation, not a dependency */ }
}

console.log('\n  ' + human(total) + ' in voices/' + (failed ? '   ' + failed + ' FAILED' : ''));
console.log('\n  next:  python -m pip install piper-tts soundfile');
console.log('         node tools/render-voices.mjs\n');
if (failed) process.exitCode = 1;
