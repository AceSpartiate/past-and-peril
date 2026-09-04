# THE VOICES
### What reads this game out loud, where it came from, and why we are allowed to ship it

---

## The short version

**311 lines of narration are pre-rendered to `app/audio/*.mp3` and committed to this repository.**
A fresh install on any school computer plays real neural narration with **no download, no Python, no
account, and no internet**. That is the whole design.

**The voice models are NOT committed.** `tools/get-voices.mjs` fetches them into `voices/`, which is
gitignored, and only somebody editing the *writing* ever needs to run it.

| | |
|---|---|
| **Engine** | Piper — `OHF-Voice/piper1-gpl`, installed with pip, never vendored |
| **Voices** | 6, all public domain or Unlicense (see the table) |
| **Rendered** | 311 lines · 6,959 words · ~40 minutes · **11.6 MB** |
| **Format** | 22,050 Hz mono MP3 at ~43 kbps, written by libsndfile — **no ffmpeg needed** |
| **Re-render** | `node tools/render-voices.mjs` |

---

## Why the audio is committed and the models are not

This looks like the wrong way round until you cost it out.

| | commit the models | commit the audio |
|---|---|---|
| size in git | **363 MB**, undeltifiable, forever | **11.6 MB** |
| GitHub push | the good `high` voices are **114 MB — over the 100 MiB hard limit**, push rejected | fine |
| setup on a new machine | pip install, 363 MB download, then render | **clone and play** |
| offline first lesson | no | **yes** |
| licence exposure | redistributing model weights | redistributing our own rendered audio |

The last row is the one that decided it. Rendered audio is **not** a derivative work of the GPL-3.0
engine — the same way a document typed in a GPL editor is not GPL — so the committed mp3s carry no
obligation from Piper at all. Vendoring the wheel *would* make this repository a GPL distribution
with source-offer obligations. So: install the engine, don't ship it.

---

## The voices actually used

All six were chosen by reading the `MODEL_CARD` on HuggingFace, not by trusting a repository-level
tag. Each card is downloaded next to its model as `<voice>.MODEL_CARD.txt` so provenance is a
five-second answer and not a research project.

| voice | licence | trained on | lineage | ships? |
|---|---|---|---|---|
| `en_US-norman-medium` | public domain | LibriVox, ~15.5 h | **from scratch** | ✅ |
| `en_US-kristin-medium` | public domain | LibriVox, ~11.5 h | **from scratch** | ✅ |
| `en_GB-cori-medium` | public domain | LibriVox, ~24 h | **from scratch** | ✅ |
| `en_US-john-medium` | public domain | LibriVox, ~12.5 h | fine-tuned from kristin (clean) | ✅ |
| `en_US-bryce-medium` | public domain | the author's own voice | fine-tuned from his own unreleased voice | ✅ |
| `es_MX-ald-medium` | **The Unlicense** | `rmcpantoja/Ald_Mexican_Spanish_speech_dataset` — 535 clips, 1 h 33 m, native Mexican Spanish | fine-tuned from `es_ES-davefx` ← `en_US-lessac` | ⚠️ see below |

The five English voices are all Bryce Beattie's, built from public-domain LibriVox recordings and
dedicated to the public domain. No attribution is required. We give it anyway.

---

## The one caveat, stated plainly

**`es_MX-ald-medium` has a clean licence and a murky weight lineage, and there is no es-MX voice in
the Piper catalogue that has both.**

The speech *data* is an explicit public-domain dedication (The Unlicense) and the phonemiser is
`es-419` — Latin American Spanish, which is right. But the *weights* were fine-tuned from
`es_ES-davefx-medium`, which was fine-tuned from `en_US-lessac-medium`, and the Blizzard 2013 Lessac
corpus licence permits research use only and forbids redistribution.

Whether fine-tuned neural weights are a derivative work of their training corpus **has no settled
answer in US law.** Our position:

- We do **not** redistribute the weights. Only our own rendered audio, from a public-domain corpus.
- The use is non-commercial classroom teaching.
- The alternative, `es_MX-ald-x_low`, has genuinely clean lineage (trained from scratch on synthetic
  data) but **states no licence at all** and sounds noticeably degraded.

So the choice is a clean licence with murky weights, or clean weights with no stated licence. We
took the first and are telling you we did. **If your district wants a spotless paper trail, the
answer is not another model — it is to record the Spanish with a native speaker** (see below).

---

## Voices deliberately NOT used

| rejected | why |
|---|---|
| **`en_US-lessac-*`** | The Blizzard 2013 licence permits **research purposes only**, forbids sub-licensing and distribution, and explicitly excludes commercial use. **It is also the worked example in Piper's own `docs/CLI.md` and `docs/VOICES.md`**, so anybody following a quickstart commits it by accident. This is the highest-probability mistake in this whole area. |
| **`es_MX-claude-high`** | Its `MODEL_CARD` cites a HuggingFace *Space*, not a dataset. The sibling voices in that Space are named `cortana`, `jarvis_ucm`, `veritasium` and `1peso-de-salsa` — Microsoft and Marvel properties and named living people. That pattern is consistent with voice cloning without consent, which is a **right-of-publicity** problem, not a licence mismatch, and no attribution file cures it. Excluded on provenance. |
| `en_US-ryan-*`, `en_US-hfc_*`, `en_GB-semaine-medium` | CC BY-NC-SA 4.0. ShareAlike could attach a copyleft obligation to district curriculum material. Public-domain alternatives exist, so there is no reason to accept it. |
| `en_GB-alba`, `en_GB-vctk`, `en_GB-aru`, `es_ES-sharvard`, `en_US-libritts_r` | CC BY / CC BY-SA. Usable, but attribution is a *condition* — omit it and you are infringing, not being impolite. Avoided so there is nothing to get wrong. |
| **Any `es_ES` Castilian voice** | Not a licensing issue — a **historical** one. The Iberian *theta* is wrong for Mexican officers in 1835 Texas, and a Texas History teacher will hear it immediately. |
| **Microsoft Dalia / Jorge / David / Zira** | Windows OS components. No redistribution grant, no output grant, and Narrator's natural voices are not even reachable from a browser except through a community tool that extracts encryption keys from system files. A teacher may install them locally to improve the *live fallback*; nothing derived from them may be committed. |
| Coqui XTTS-v2 | The Coqui Public Model License restricts "the model **or its output**" to non-commercial use — so the restriction travels into every school that clones this repo. Coqui Inc. shut down in January 2024, so there is nobody left to license it from. |
| MBROLA `mx1`/`mx2` | The AGPL on the repo covers the *engine*; each voice database has its own custom licence forbidding sale and permitting use "with and only with the Mbrola program". And unlike neural synthesis, MBROLA output is **concatenated segments of the licensed recordings** — the "output isn't a derivative" reasoning does not apply. Painful, because mx1 was built by Mexican researchers for Mexican Spanish. |

---

## The casting, and the two rules that are not negotiable

The render cast lives in [`tools/voices.json`](tools/voices.json). It is a **different table** from
`SPEAKERS` in [`app/js/audio.js`](app/js/audio.js) — that one casts whatever voices the machine
happens to have installed, for the live fallback, and can only pick from what is there.

**RULE 1 — Mexican and Tejano characters are rendered in native es-MX, never as an English speaker
doing an accent.** Ugartechea, Castañeda, Seguín and Santa Anna all read from `es_MX-ald-medium`.

The Piper catalogue contains **only two distinct es-MX speakers**, so four men cannot have four
voices. They are separated by speaking rate and phoneme-width variation instead — Santa Anna slow
and grave at `length 1.16`, Castañeda clipped at `0.92`. That is an honest workaround for a real
limit. Substituting Castilian voices to get variety would not be.

In the live browser fallback, a machine with no Spanish voice reads these lines **as the narrator**
rather than faking an accent. A neutral read is better than a bad one.

**RULE 2 — Joe, Greenbury Logan, Samuel McCulloch Jr. and Hendrick Arnold get straight, dignified,
unaccented reads. No dialect performance.** `design/10-voice-cast.md` calls the alternative
"minstrelsy with a lesson plan attached" and it is right. Their entries in `voices.json` are
deliberately ordinary. **This is not an oversight. Do not "fix" it later by adding an accent.**

---

## The thing worth doing that no model in this survey can do

Roughly 8–12 minutes of this campaign is Spanish. **Record it with a native es-MX speaker** — a
Spanish teacher, a bilingual colleague, a parent volunteer, an older student — one afternoon, a
cheap USB microphone, and a signed release dedicating the recordings to the public domain.

That output is legally cleaner than anything above, unambiguously and authentically Mexican rather
than "generic Latin American", and better *acted* than any synthesis. It satisfies Rule 1 in a way
no model here fully does. Drop the files in `app/audio/` named by the line id
(`node tools/render-voices.mjs --dry` prints every id) and they win over the synthesised version
automatically, with no code change.

Use Piper for the English narrator and the large English cast, where it is genuinely good and where
hand-recording 280 lines is not realistic.

---

## How to re-render after editing the writing

```bash
python -m pip install piper-tts soundfile
node tools/get-voices.mjs          # 363 MB into voices/, gitignored, once
node tools/render-voices.mjs       # renders only what changed
node tools/render-voices.mjs --prune   # delete audio for lines you rewrote
```

The line id is an **FNV-1a hash of speaker + text**, implemented identically in
`tools/render-voices.mjs` and `app/js/audio.js`. Authors never assign one. Change a word and the id
changes, the old mp3 becomes an orphan, and the next run renders the new line — so **the audio
cannot silently drift out of step with the script.**

If you touch one copy of `lineId`, touch both. They disagreed once during development — one had a
stray NUL byte where the other had a space — and the symptom was not an error. It was 311 correct
mp3 files that nothing ever asked for.
