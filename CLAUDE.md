# PAST & PERIL — working notes for Claude

> ## ▶ IF THIS IS YOUR FIRST MESSAGE IN THIS PROJECT, STOP AND READ `design/22-START-HERE.md` NOW.
>
> It is the handoff: an ordered list of what to do, what is already verified so
> you do not pay to rediscover it, and what is flagged as the teacher’s decision
> rather than yours. There is a specific task waiting and a spec for it.
>
> The teacher is near their usage limit. Being economical is part of the job.

Read this before changing anything. It is short on purpose; the long version
lives in `design/`, which is **not in this repository** (see *Where the thinking
lives*, below).

---

## What this is

A digital classroom RPG that teaches the Texas Revolution to 7th graders. One
teacher, one projector, and 20–30 students on Chromebooks and phones. A unit is
six ~45-minute periods.

Node server (`server/`), browser clients (`app/`), no framework, no build step,
no `package.json`. Server-authoritative: clients POST an intent and receive
state over SSE. A bundled Node runtime ships with it so a non-technical teacher
can run it by double-clicking.

**It is a game first.** A real class played an earlier version and said it felt
like "a textbook with a gamey exterior." Everything since has been in service of
fixing that.

---

## The four rules that outrank everything

### 1. THE FACTS ARE FREE

> A student who loses every roll, arrives on the second day, is never invited to
> anything, and never opens a menu still learns every required fact.

No required fact may be gated on winning, surviving, affording, being invited,
being grouped, or being present. This is what lets the game be as harsh as it
likes — you can lose the battle, you cannot lose the lesson.

It holds *structurally*, not by good intentions, in two places worth knowing
before you touch either:

- `server/engine.js` unshifts a swept fallback action to index 0, so no ranking
  change can displace it.
- `server/room.js`'s `record` segment hands every session's required facts to
  every student unconditionally, at the end of the period.

Every fact carries a fallback action with empty `requires`, auto-built by the
engine. **Never author a fact without one.**

Verify with `node tools/sim-class.js`. It must print `✓ THE FACTS ARE FREE
holds` and `0 of N short`. It currently simulates **session 1 only**.

### 2. FIFTY WORDS

No single piece of authored student-facing text may exceed 50 words without an
explicit exception. `node tools/check-words.mjs` enforces it and carries the
exception list — primary sources are exempt because a historical document is as
long as it is. Add an exception only when the teacher says so.

### 3. HORIZONTAL PROGRESSION ONLY

Loot never improves a die roll. It gives a student a button nobody around them
has. Resolution is `2d6 + stat` where stats are 0–3, against three tiers, with
no content level-scaling — so flat `+N` bonuses collapse the three tiers into
one and nothing costs anything any more.

This reversed an earlier decision; `server/room.js` still carries a comment
explaining why items were once deliberately made to affect rolls. `effect.stat`
is being removed from the item schema.

### 4. SOURCING DISCIPLINE

Students play **real, named, documented people**, and their names go on a
classroom wall. The research marks every claim DOCUMENTED / NOT DOCUMENTED /
OPEN. Never assert something a source does not support, and never invent a
quotation, a date, or an act by a real person. When you propose content, cite
the file and line it rests on.

---

## The shape of a period

Roughly twenty minutes of solo play — every student walking their own town on
their own screen, no groups, nobody waiting — then a shared encounter at the end
that the whole room fights together, then a lock-screen that hands out anything
still owed.

**Everything scales off the live roster.** Class sizes vary between periods, and
the game must be playable by a large class *or a single player*. Never size a
mechanic against thirty. Nothing may require a second student to exist; things
built on `adjacent_character` degrade to *nothing happens*, never to *you cannot
act*.

---

## Architecture orientation

| where | what |
|---|---|
| `server/engine.js` | offer/resolve. `meets()` is the gating vocabulary; `resolve()` rolls and picks a tier. |
| `server/room.js` | all mutable state, the timeline, persistence. The big one. |
| `app/js/play.js` | the student screen |
| `app/js/stage.js` | the projector |
| `app/js/console.js` | the teacher's desk |
| `app/content/*.json` | every authored word and rule |
| `tools/` | the checks. Run them. |

**The gating vocabulary** (`requires`, all ANDed — for OR, write two actions):
`calling · origin · mark · mark_absent · role · person · scene_kind · strength ·
stat · flag · flag_absent · world_flag · world_flag_absent · hex · hex_in ·
adjacent_npc · adjacent_hex · adjacent_character · adjacent_calling · clock ·
resource · standing`, plus `cost.move` / `cost.word` and once-per-scene unless
`repeatable`.

There is **no `requires.item`**. Items express themselves as flags.

`requires.clock` supports comparators (`>=`, `<=`, `>`, `<`, `=`) and no content
uses it yet — it is the cheapest way to gate an encounter's phases.

**Outcome tiers** are keyed `strong` / `partial` / `weak` in code, though they
display as HELD and so on. `all` applies to unrolled actions.

---

## Gotchas that have already cost real time

**Line endings are mixed and it matters.** A multi-line pattern with `\n` will
silently fail to match on a CRLF file, and a patch that inserts `\n` lines into
one leaves it mixed. **Do not trust a list — measure the file you are about to
touch:**

```bash
grep -qU $'\r' FILE && echo CRLF || echo LF
```

Measured 6 Sep 2026, correcting two entries this file had wrong that each cost
a session real time:

| CRLF | LF |
|---|---|
| `server/serve.js`, `server/engine.js` | **`server/room.js`** |
| `app/js/play.js`, `app/js/stage.js` | `app/js/hexmap.js`, `app/js/docs.js` |
| `app/play.html`, `app/index.html`, `app/stage.html` | `app/join.html` |
| `README.md`, **`tools/sim-class.js`** | `app/css/*.css`, other `tools/*` |

`tools/` is **not** uniformly LF — `sim-class.js` is CRLF, the rest are LF.
`.gitattributes` is `* -text`, so nothing is ever normalised and whatever you
write is what ships.

**Two more that have bitten, both in generated patches.** `String.replace`
expands `$&`, `` $` `` and `$'` in a *replacement string*, so a replacement
containing a regex literal ending in `$` gets silently eaten — pass a function
instead. And a backslash does not reliably survive a shell heredoc into a
generated file; write code with no regex literals in it, or use the Write tool.

**`.gitignore` does not support trailing comments.** `data/   # saved periods`
is a pattern matching that literal string and ignores nothing. An earlier
version did exactly this and nearly published 527 MB including saved class
progress and the console key. Comments go on their own line.

**`tar` on Windows.** Git Bash gives GNU tar, which cannot make zips and treats
`C:` as a remote host. Use `%SystemRoot%\System32\tar.exe` (bsdtar), which
handles both — `tools/zip.mjs` names it explicitly.

**`r.outcome` is a live reference** into the shared parsed content object, not a
copy. Mutating it in place permanently rewrites that action for every other
student for the rest of the period. `perform()` already copies rather than
mutates — follow that pattern.

**A clock a session did not declare is silently a no-op** (`if (c)` guard). This
is load-bearing and deliberate: it is how clocks scope themselves per session.
It also means a typo'd clock id fails silently.

**`node --check` will not catch a scope error** in the renderer. Some bugs only
appear by opening the page.

---

## Before you say you are done

```bash
node tools/check-content.mjs && node tools/check-words.mjs && node tools/sim-class.js
```

`check-content` currently exits with a known error about character Callings
contradicting their cards — a content decision that is being repaired, not a
regression you introduced. Everything else should be clean.

Never claim the guarantee holds without running the simulator. And note what a
simulator cannot see: it found nothing wrong with a design that would have left
five particular students at the bottom of a ladder for six weeks, because bots
do not notice being left off a list.

---

## Where the thinking lives

`design/`, `research/`, `gm-materials/`, `assessment/` and `player-materials/`
are **deliberately not published**. This repository is public — auto-update
reads GitHub's API with no token — so those directories would put run sheets,
per-student secrets and rubrics in front of any student who found the repo.

That means **a fresh clone does not contain the design work.** If you are
picking this up on a new machine and those directories are absent, ask before
inferring intent from the code alone; a great deal of the reasoning is in
`design/`, especially:

- **`design/22-START-HERE.md` — read this first.** Handoff, the ordered list of
  what to do next, and what is already diagnosed and waiting.
- `design/23-slice0-spec.md` — the exact work currently in front of you
- `design/21-decisions.md` — settled decisions, with what they killed
- `design/20-the-wow-plan.md` — the plan the game is being built toward
- `design/00-constraints.md` — the original constraints

---

## Working with this teacher

They are a working 7th-grade teacher, not a developer, and the thing has to
survive a real room: 45 minutes, one adult, a fire drill, six absences, three
dead Chromebooks, and a kid who will try to break it. A feature that needs the
teacher to adjudicate anything mid-period will not survive contact.

Measure before fixing. Several confident diagnoses in this project's history
have been wrong, and the measurements were cheap.
