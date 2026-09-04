/* zip.mjs — read and write zip files with nothing installed.
 *
 * Windows 10 and 11 ship libarchive as C:\Windows\System32\tar.exe, and it
 * handles zip in both directions. That is the entire reason this project can
 * auto-update with zero dependencies.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS CALLS tar BY ITS FULL PATH
 *
 * `spawn('tar')` is a coin flip on a Windows machine, and it took a real test
 * to notice. Git for Windows, MSYS2, Cygwin and a few package managers all put
 * a GNU tar earlier on PATH, and GNU tar:
 *
 *   · cannot read or write zip at all — it has no zip support, and `-a` just
 *     falls through and writes an uncompressed tar with a .zip name
 *   · treats any path containing a colon before the first slash as a REMOTE
 *     host, so every absolute Windows path fails with the wonderful
 *         tar: Cannot connect to C: resolve failed
 *
 * Both were measured. bsdtar in System32 does the right thing with the same
 * arguments, forward or backslashes. So the System32 binary is named
 * explicitly and PATH is only a fallback.
 *
 * The consequence of getting this wrong was not a crash: update.mjs would have
 * returned 'unzip-failed' forever, on exactly the machines most likely to have
 * a developer's tar installed, and no teacher would ever have seen an update.
 * ------------------------------------------------------------------------- */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

/* Candidates in order of trust. */
function tars() {
  const out = [];
  if (process.platform === 'win32') {
    const sysroot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const p = path.join(sysroot, 'System32', 'tar.exe');
    if (fs.existsSync(p)) out.push(p);
  }
  out.push('tar');                       // PATH: may be bsdtar, may be GNU
  return out;
}

/* A GNU tar that got handed a zip fails in a way worth recognising, so that a
 * caller can tell "no usable tar" from "the archive is corrupt". */
function run(exe, args, opts) {
  return spawnSync(exe, args, Object.assign({ encoding: 'utf8', timeout: 180000 }, opts || {}));
}

/* --------------------------------------------------------------- extracting */
export function unzip(zipFile, into) {
  fs.mkdirSync(into, { recursive: true });
  const errors = [];

  for (const exe of tars()) {
    const r = run(exe, ['-x', '-f', zipFile, '-C', into]);
    if (r.status === 0 && fs.readdirSync(into).length) return { ok: true, via: exe };
    errors.push(exe + ': ' + String(r.stderr || r.error || 'exit ' + r.status).trim().split('\n')[0]);
  }

  /* Every Windows with PowerShell can do this, it is just slower and chattier.
   * -EncodedCommand because Node's argument quoting and PowerShell's own
   * re-parse between them mangle a script full of quotes. */
  if (process.platform === 'win32') {
    const ps = "$ProgressPreference='SilentlyContinue'; Expand-Archive -LiteralPath '" +
      String(zipFile).replace(/'/g, "''") + "' -DestinationPath '" +
      String(into).replace(/'/g, "''") + "' -Force";
    const r = run('powershell', ['-NoProfile', '-EncodedCommand',
      Buffer.from(ps, 'utf16le').toString('base64')], { timeout: 300000 });
    if (r.status === 0 && fs.readdirSync(into).length) return { ok: true, via: 'Expand-Archive' };
    errors.push('Expand-Archive: exit ' + r.status);
  }

  return { ok: false, errors };
}

/* ----------------------------------------------------------------- creating */
/* `what` is a single entry name inside `fromDir`, so the archive gets exactly
 * one root folder and extracting it can never scatter forty items across
 * somebody's Desktop. */
export function zip(outFile, fromDir, what) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  try { fs.rmSync(outFile, { force: true }); } catch (e) {}
  const errors = [];

  for (const exe of tars()) {
    /* cwd is set to the output directory and -f is a bare filename: that form
     * works even on a GNU tar, which removes one whole class of failure. The
     * format still has to be zip, which GNU tar cannot do — hence the check on
     * the result below rather than on the exit code alone. */
    const r = run(exe, ['-a', '-c', '-f', path.basename(outFile), '-C', fromDir, what],
      { cwd: path.dirname(outFile), timeout: 900000 });
    if (r.status === 0 && fs.existsSync(outFile) && isZip(outFile)) return { ok: true, via: exe };
    if (fs.existsSync(outFile) && !isZip(outFile)) {
      /* GNU tar wrote a tarball with a .zip name. Throw it away rather than
       * publishing something no unzip on earth will open. */
      errors.push(exe + ': wrote a tar, not a zip (GNU tar has no zip support)');
      try { fs.rmSync(outFile, { force: true }); } catch (e) {}
      continue;
    }
    errors.push(exe + ': ' + String(r.stderr || r.error || 'exit ' + r.status).trim().split('\n')[0]);
  }

  if (process.platform === 'win32') {
    const src = path.join(fromDir, what);
    const ps = "$ProgressPreference='SilentlyContinue'; Compress-Archive -LiteralPath '" +
      src.replace(/'/g, "''") + "' -DestinationPath '" +
      outFile.replace(/'/g, "''") + "' -Force";
    const r = run('powershell', ['-NoProfile', '-EncodedCommand',
      Buffer.from(ps, 'utf16le').toString('base64')], { timeout: 900000 });
    if (r.status === 0 && fs.existsSync(outFile)) return { ok: true, via: 'Compress-Archive' };
    errors.push('Compress-Archive: exit ' + r.status);
  }

  return { ok: false, errors };
}

/* PK\003\004, or PK\005\006 for an empty archive. */
export function isZip(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(4);
    fs.readSync(fd, b, 0, 4, 0);
    fs.closeSync(fd);
    return b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5 || b[2] === 7);
  } catch (e) { return false; }
}
