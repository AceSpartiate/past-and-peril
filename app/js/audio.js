/* audio.js — narration.
 *
 * Two sources, in order:
 *   1. audio/<id>.mp3   — PRE-RENDERED NEURAL VOICES, committed to the repo
 *   2. speechSynthesis  — the browser's own voice, whatever the machine has
 *
 * (1) IS NOW THE NORMAL CASE, and that is the answer to "it sounds robotic".
 * tools/render-voices.mjs speaks every authored line with Piper and commits the
 * mp3s, so a fresh install on a school computer plays real neural narration
 * with no download, no Python and no account. See VOICE_LICENSES.md for which
 * voices and why those ones.
 *
 * THE ID IS A HASH OF THE LINE. Authors never assign one. lineId() below is
 * mirrored EXACTLY in tools/render-voices.mjs — if you change one, change both,
 * or every line silently falls back to the browser voice. Change a word of
 * writing and the id changes with it, so the audio cannot drift out of step
 * with the script.
 *
 * (2) remains for anything not yet rendered — a line typed this morning, or a
 * fact statement assembled at runtime. It has a hard ceiling on quality and it
 * is a fallback, not the plan.
 *
 * Honest note: with real mp3s the narration length COULD set the beat length
 * (design/12-ken-burns-sequences.md), but the timeline is still driven by the
 * authored `seconds`. Keep lines short enough to fit inside their beat. */

const Narrator = (function () {
  const synth = window.speechSynthesis || null;
  let voices = [];
  let have = null;              // the set of line ids that have a rendered mp3
  let current = null;        // HTMLAudioElement or SpeechSynthesisUtterance
  let muted = false;
  let onCaption = null;
  let playback = 0;             // invalidates callbacks from an older line
  let paused = false;
  let currentVoice = null;

  /* WHO SOUNDS LIKE WHAT, and the two rules from design/10-voice-cast.md that
   * are not negotiable.
   *
   * RULE 1 — Mexican and Tejano characters are rendered in NATIVE es-MX, never
   * as an English speaker doing an accent. If this machine has no es-MX voice
   * the line falls back to the narrator rather than being faked, because a bad
   * accent is worse than a neutral read.
   *
   * RULE 2 — Joe, Greenbury Logan, Samuel McCulloch Jr. and Hendrick Arnold get
   * STRAIGHT, DIGNIFIED, UNACCENTED reads. No dialect performance. The voice
   * spec calls the alternative "minstrelsy with a lesson plan attached" and it
   * is right. This is deliberate and it is not an oversight — do not "fix" it
   * by adding an accent later.
   *
   * Everything below is a browser voice, which has a hard ceiling on quality.
   * Dropping a rendered mp3 into audio/<id>.mp3 replaces any of these, and that
   * is the actual answer to "it sounds robotic". */
  const SPEAKERS = {
    NARRATOR:    { lang: 'en-US', rate: 0.90, pitch: 0.92, prefer: ['natural', 'neural', 'enhanced', 'premium', 'google', 'aria', 'guy'] },
    HISTORIAN:   { lang: 'en-GB', rate: 0.95, pitch: 1.04, prefer: ['natural', 'neural', 'enhanced', 'libby', 'ryan', 'sonia'], fallback: 'NARRATOR' },

    // Mexican and Tejano — native es-MX, or the narrator. Never an accent.
    UGARTECHEA:  { lang: 'es-MX', rate: 0.88, pitch: 0.90, fallback: 'NARRATOR' },
    CASTANEDA:   { lang: 'es-MX', rate: 0.90, pitch: 0.95, fallback: 'NARRATOR' },
    SANTA_ANNA:  { lang: 'es-MX', rate: 0.86, pitch: 0.88, fallback: 'NARRATOR' },
    SEGUIN:      { lang: 'es-MX', rate: 0.93, pitch: 1.00, fallback: 'NARRATOR' },
    ALMONTE:     { lang: 'en-US', rate: 0.93, pitch: 0.98, note: 'Educated in the United States — the documented exception to rule 1.' },

    // Anglo Texians
    TRAVIS:      { lang: 'en-US', rate: 0.95, pitch: 1.00 },
    AUSTIN:      { lang: 'en-US', rate: 0.88, pitch: 0.96 },
    HOUSTON:     { lang: 'en-US', rate: 0.84, pitch: 0.84 },

    /* Rule 2. Same configuration as any other speaker, on purpose. */
    JOE:            { lang: 'en-US', rate: 0.92, pitch: 0.96 },
    GREENBURY_LOGAN:{ lang: 'en-US', rate: 0.90, pitch: 0.92 },
    MCCULLOCH:      { lang: 'en-US', rate: 0.92, pitch: 0.94 },
  };

  /* FNV-1a over speaker + text. Mirrored in tools/render-voices.mjs. */
  function lineId(speaker, text) {
    const s = (speaker || 'NARRATOR') + ' ' + String(text).replace(/\s+/g, ' ').trim();
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return (speaker || 'NARRATOR').toLowerCase().replace(/[^a-z0-9]+/g, '') +
           '-' + ('0000000' + h.toString(16)).slice(-8);
  }

  /* One small file answers "is this line recorded?" for all of them. Without it
   * every unrendered line costs a request that 404s — on thirty Chromebooks on
   * school wifi, thousands of them a period. */
  function loadManifest() {
    return fetch('audio/index.json')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        have = {};
        ((j && j.ids) || []).forEach(function (id) { have[id] = true; });
        return j;
      })
      .catch(function () { have = {}; return null; });
  }
  loadManifest();

  function loadVoices() {
    if (!synth) return;
    voices = synth.getVoices() || [];
  }
  if (synth) {
    loadVoices();
    synth.addEventListener && synth.addEventListener('voiceschanged', loadVoices);
    if ('onvoiceschanged' in synth) synth.onvoiceschanged = loadVoices;
  }

  /* Browsers ship a range from "1998 answering machine" to genuinely decent
   * neural voices, and getElementsByDefault hands you the worst one. Score by
   * name so the good ones win where they exist. */
  function score(v, prefer) {
    const n = (v.name || '').toLowerCase();
    let sc = 0;
    ['natural', 'neural', 'enhanced', 'premium', 'siri', 'google'].forEach(function (w, i) {
      if (n.indexOf(w) !== -1) sc += 40 - i * 4;
    });
    (prefer || []).forEach(function (w, i) { if (n.indexOf(w) !== -1) sc += 25 - i * 2; });
    if (n.indexOf('compact') !== -1 || n.indexOf('espeak') !== -1) sc -= 30;
    if (v.localService === false) sc += 6;         // server voices are usually better
    return sc;
  }

  function pickVoice(lang, prefer) {
    if (!voices.length) return null;
    const want = lang.replace('_', '-');
    const base = want.split('-')[0];
    const exact = voices.filter(function (v) { return v.lang.replace('_', '-') === want; });
    const loose = voices.filter(function (v) { return v.lang.replace('_', '-').indexOf(base) === 0; });
    const pool = exact.length ? exact : loose;
    if (!pool.length) return null;
    return pool.slice().sort(function (a, b) { return score(b, prefer) - score(a, prefer); })[0];
  }

  function stop() {
    playback += 1;
    paused = false;
    currentVoice = null;
    if (synth) { try { synth.cancel(); } catch (e) {} }
    if (current && current.pause) { try { current.pause(); current.currentTime = 0; } catch (e) {} }
    current = null;
  }

  function pause() {
    if (paused) return;
    paused = true;
    if (current && current.pause) current.pause();
    else if (current && synth) synth.pause();
  }

  function resume() {
    if (!paused || muted) return;
    paused = false;
    if (current && current.play) {
      const clip = current, token = playback, voice = currentVoice;
      clip.play().then(function () {
        if (token !== playback || current !== clip || paused) clip.pause();
      }).catch(function () {
        if (token === playback && current === clip && !paused) speak(voice);
      });
    } else if (current && synth) synth.resume();
  }

  return {
    setMuted: function (m) { muted = !!m; if (muted) stop(); },
    get muted() { return muted; },
    onCaption: function (fn) { onCaption = fn; },
    stop: stop,
    pause: pause,
    resume: resume,

    lineId: lineId,
    ready: function () { return have !== null; },
    rendered: function (voice) {
      if (!voice || !voice.text) return false;
      const id = voice.id || lineId(voice.speaker, voice.text);
      return !!(have && have[id]);
    },

    /* voice = { speaker, text, id? } */
    say: function (voice) {
      stop();
      if (!voice || !voice.text) { if (onCaption) onCaption(null); return; }
      if (onCaption) onCaption({ speaker: voice.speaker || 'NARRATOR', text: voice.text });
      if (muted) return;
      currentVoice = voice;
      const token = playback;

      /* 1 · the rendered clip. Asked for by hash, so no author ever types an
       * id and no line can be recorded under the wrong name. */
      const id = voice.id || lineId(voice.speaker, voice.text);
      if (!have || have[id]) {
        const el = new Audio('audio/' + id + '.mp3');
        let failed = false;
        function fallback() {
          if (failed || token !== playback) return;
          failed = true;
          el.pause();
          speak(voice);          // not recorded yet: the browser reads it
        }
        el.addEventListener('error', fallback);
        /* Own the clip before play settles, so Pause/Stop can reach a clip
         * that is still loading. Late callbacks cannot revive an old line. */
        current = el;
        el.play().then(function () {
          if (token !== playback || current !== el || paused) el.pause();
        }).catch(function () {
          if (!paused) fallback();
        });
        return;
      }
      speak(voice);
    },

    /* What the machine can actually do, for the console to show honestly. */
    describe: function () {
      /* The honest answer, and it is now usually the good one. */
      const n = have ? Object.keys(have).length : 0;
      if (n) return n + ' lines are recorded in real voices' +
        (synth && voices.length ? ' · anything not yet recorded is read by ' +
          ((pickVoice('en-US', SPEAKERS.NARRATOR.prefer) || {}).name || 'the browser voice') : '');
      if (!synth) return 'no speech synthesis on this browser — read aloud yourself';
      if (!voices.length) return 'speech synthesis warming up…';
      const nar = pickVoice('en-US', SPEAKERS.NARRATOR.prefer);
      const es = pickVoice('es-MX');
      const good = nar && /natural|neural|enhanced|premium|google|siri/i.test(nar.name);
      return 'narrator: ' + (nar ? nar.name : 'none') +
        (good ? '' : ' — a basic system voice, and it will sound like one') +
        ' · ' + (es ? 'es-MX: ' + es.name : 'NO es-MX voice, so Spanish lines read as the narrator');
    },
    /* What is actually installed, so the console can stop guessing. */
    inventory: function () {
      return voices.map(function (v) {
        return { name: v.name, lang: v.lang, local: v.localService,
                 score: score(v, SPEAKERS.NARRATOR.prefer) };
      }).sort(function (a, b) { return b.score - a.score; });
    },
  };

  function speak(voice) {
    if (!synth || muted || !voice) return;
    let key = voice.speaker || 'NARRATOR';
    let cfg = SPEAKERS[key] || SPEAKERS.NARRATOR;
    let v = pickVoice(cfg.lang, cfg.prefer);
    if (!v && cfg.fallback) { cfg = SPEAKERS[cfg.fallback]; v = pickVoice(cfg.lang, cfg.prefer); }

    const u = new SpeechSynthesisUtterance(voice.text);
    if (v) u.voice = v;
    u.lang = cfg.lang;
    u.rate = cfg.rate;
    u.pitch = cfg.pitch;
    u.volume = 1;
    current = u;
    try {
      if (!paused && synth.paused) synth.resume();
      synth.speak(u);
      if (paused) synth.pause();
    } catch (e) {}
  }
})();

/* A top-level `const` in a classic script is NOT a property of window. play.js
 * guarded every call with `window.Narrator &&`, which was silently false
 * forever — the read-aloud button toggled, said it was reading, and read
 * nothing. Export it explicitly so the guard means what it says. */
window.Narrator = Narrator;
