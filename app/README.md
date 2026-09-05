# PAST & PERIL — the software

Three screens, one server: **the console** you drive, **the Stage** on the projector, and **the
Slate** on thirty Chromebooks.

---

## Running it

```bash
node server/serve.js
```

It prints three addresses:

| | |
|---|---|
| **You** | `http://localhost:8099/?key=…` — bookmark it. The key is not on any student screen. |
| **Students** | `http://<your-laptop-ip>:8099/play.html` — write it on the board |
| **Projector** | `http://localhost:8099/stage.html` |

Nothing to install: no dependencies, no build step, no framework, no accounts.

### Why this runs on your laptop and not in the cloud

`design/09-screens-and-cloud.md` specified Cloudflare Workers with a Durable Object per class
period, and that is still a fine destination. It is not the right *first* target for this room:

- **nothing leaves the building**, so there is no vendor for the district to vet
- no account, no bill, no deploy step
- **it works when the school wifi is down** — students reach your laptop over the local network even
  with no internet in the building at all

`server/room.js` is transport-agnostic, so hosting it in a Durable Object later is a swap, not a
rewrite. One `Room` per class code is already the shape design/09 asked for.

> **The one thing that can stop this working:** some school networks turn on *client isolation*,
> which blocks device-to-device traffic on the student wifi. If nobody can reach your laptop, that
> is the reason, and IT can allow it. The server prints this reminder every time it starts.

### Why SSE and not WebSockets

Broadcast is one-way — the server to thirty screens — and student actions are occasional POSTs,
which is exactly the shape Server-Sent Events fit. `EventSource` also **reconnects by itself for
free**, so a closed Chromebook lid resumes with no code, and school proxies that sometimes block
WebSocket upgrades never block plain HTTP.

### The server owns the period

`server/room.js` holds the timeline, the clocks, the ledger and every student. Consequences worth
knowing:

- **reloading the console does not lose the lesson** — it reconnects to a period already in progress
- thirty clients cannot disagree about which beat it is
- **a student editing their own JavaScript gains nothing.** Movement range is drawn on the client as
  a convenience; the server independently rejects an illegal step, an action outside the turn
  window, a second action in one turn, or a SPEAK with no Words left
- **one person, one player** — a second device claiming a taken name is refused, unless the first
  has gone quiet, which is how a student moves to a working Chromebook
- a retired name is never reissued

### Getting it onto the projector

**Two displays** — open `stage.html` in a second window, drag it to the projector, press F11. It
finds the room by itself; there is nothing to pair. Open as many as you like, on any machine — the
console tells you honestly how many screens are listening, because the server counts them.

**One display** — click **Stage on this screen**. The Stage fills the laptop. **Escape** toggles
between the Stage and the console.

If you press *Open the room* without doing either, it puts the Stage on this screen so you never
start with a blank projector.

---

## Running a period

**Press "Open the room" and put it down.** The period runs to the bell without another touch: it
reads the situations aloud, counts the ninety seconds of DECLARE, rolls the public dice, ticks the
clocks, walks Set the Record Straight, and stops.

Everything else is an override you may never need:

| | |
|---|---|
| **Space** | Pause. Thirty screens go quiet — that silence is the classroom-management tool. |
| **→ / ←** | Skip forward, step back |
| **E** | Extend the current beat by 30 seconds |
| **R** | Replay this beat from the top |
| **Escape** | Show/hide the Stage on a one-screen setup |
| **I'll read it** | Mutes the narrator and shows you the text. You are always allowed to be the better instrument. |
| **+/− on any clock** | Manual override on everything |

The **bell clock** is wall-clock true: it keeps running while you are paused, because the bell does.
Under it, **ON PACE** compares how much session is left to how much period is left, so you can see a
problem coming rather than discovering it at 2:40.

The **coloured band** under the masthead is readable across the room while you are crouched at a
desk: calm, amber (paused, or a teacher note is up), oxide (under two minutes, or you are behind).

---

---

## The student client — `play.html`

Students open **http://localhost:8099/play.html** and tap their name. Roll20's loop, at
twelve-year-old scale:

> ## SEE THE WORLD · MOVE YOUR TOKEN · USE AN ABILITY

- **The map is the screen.** The whole of Gonzales, fitted so nobody ever pinches or scrolls.
  Hovering a hex names the ground and what it costs to cross.
- **The turn window is the autopilot beat.** When the Stage reaches DECLARE, thirty screens unlock
  at once. When the beat ends they lock and the room looks up. **The teacher does not open or close
  anything.**
- **Movement is per Calling** — a Rider has 5 points and reaches 75 hexes from the plaza; a Clerk has
  2 and reaches 18. Reachable hexes are outlined; an unreachable tap does nothing, with no scolding.
- **The bar is six verbs plus the one ability that is yours alone.** SPEAK greys out when your Words
  are gone. Declaring locks the verbs but **not** movement — deciding early must never park you.
- **Between turns the screen goes quiet** and says *Watch the board.* Nothing is tappable, on
  purpose: if there is something to click, a twelve-year-old clicks it instead of looking up.
- **Rejoining mid-lesson just works.** A dead Chromebook picks up where the room is.

The console's **THE ROOM** panel fills in by itself as students join — name, hex, and the verb they
chose — so the teacher can see who has acted without asking.

### `window.PlayAgent` is a seam, not debug scaffolding

`design/16-build-order.md` makes the software its own test harness, because no class is available
until the whole thing is built. `PlayAgent` lets a machine do anything a student can, through the
same code path — `choose()`, `options()`, `moveTo()`, `verbs()`, `use()`. `tools/sim-class.js` will
drive thirty of them.

---

## Persistence — five periods, five campaigns

State lives in `data/<CLASS-CODE>.json`, one file per class period. Nothing else is needed: no
database, no migrations, no service.

**Two different things are remembered, and conflating them would be a mistake.**

| | |
|---|---|
| **The period** | Where today's lesson had got to. Survives a crash, a closed lid, a restarted laptop. |
| **The campaign** | What carries between sessions: the Gonzales Ledger, each student's Legacy and flags, the standing of the ranchos, who has been retired. This is what makes 4th period's campaign different from 7th period's. |

### A restored period comes back PAUSED. Always.

A server returning mid-lesson must not silently resume a period whose room has moved on. Something
interrupted it and **the teacher is the only one who knows whether the class is still in their
seats.** So the console shows the gate with the button reading **Resume the period**, and says
*"picked up at segment 4 of 20 — everything is where it was."* Pressing it is a decision, not a
default.

### Verified by killing the server mid-lesson

Darst had Legacy 2, one fact, and had moved to C7. The process was killed and restarted:

```
before   segment 10/20 · scene S1.3 · legacy 4 · facts 12 · flags 2 · hex C7
         powder 12 · stores 40 · demand 3/4 · word 1/6
after    identical
```

**Progress is held under the character id, not the device.** Whichever Chromebook a student picks up
on Monday, the character it claims is the one carrying their Legacy and their flags — which is also
how a student moves to a working machine mid-period.

### What is in these files, and what is not

Character ids, hexes, flags, facts received, Legacy, and where the lesson had got to. **No student
names, no emails, no ages, no school identifiers** — there is nowhere in the application to enter
any of those, so there is nothing of that kind to write down. A row reads:

```json
{ "characterId": "p03", "hex": "C7", "legacy": 6,
  "flags": { "MOUNTED_THE_CANNON": true }, "taughtVia": { "FACT_ZACATECAS": "play" } }
```

Jacob C. Darst died in 1836. The roster mapping a real student to a character stays on paper, with
you, exactly as it does now.

**Writes are atomic** — temp file, fsync, rename — because a classroom laptop is not shut down
politely. The worst case is losing the last few seconds, never a half-written file that refuses to
open on Monday morning. A file that is somehow unreadable is moved aside rather than blocking the
lesson, and the server says so.

Autosave is debounced to 3 seconds, plus a sweep every minute, plus on `SIGINT`/`SIGTERM` and on an
uncaught exception.

---

## The rules engine

`server/engine.js` implements `design/08-rule-schema.md`. **Nobody writes "if you chose X go to Y."**
Authors write ACTIONS WITH CONDITIONS and the engine computes what each of thirty students can do
right now, so situations multiply against character builds instead of adding along authored arrows.

Session 1 Scene 1 currently holds **25 authored actions + 10 fact fallbacks**, and every one of the
30 builds is offered **7 to 13 options**, all of them meaningful.

### What a student sees is a consequence of who they are

| | |
|---|---|
| Jacob Darst, SMITH | *Mount the cannon on something that will hold* `[SMITH · ROLL ARMS]` |
| Andrew Ponton, CLERK, LETTERED | *Offer to draft the alcalde's reply* `[CLERK · ROLL WORD]`, *Read the letter over his shoulder* `[✦ LETTERED]` |
| Galba Fuqua, RIDER | *Ride for help before anyone tells you not to* |

Darst is never shown the Clerk's option. Options you cannot pay for are never shown either —
`design/09`: no greyed-out teases, they read as punishment.

### Two guarantees, enforced in code

**THE FACTS ARE FREE.** Every outcome tier of an action teaches the same fact, so a bad roll still
delivers the content. Verified live on a natural snake-eyes: 1 + 1 + 3 WORD = 5, **GAVE GROUND** —
and the fact plate still appeared.

**THE FALLBACK SWEEP.** Measured before it existed: **29 of 30 builds could not reach
`FACT_ZACATECAS` through play**, because it was gated behind standing next to the dragoon. Busy
students, about to miss required content, and nobody would have noticed. Inside the last 90 seconds
of a window the engine now promotes every owed fact's fallback to the **top** of that student's list.
Coverage went from **1/30 to 30/30**.

That is a different problem from the idle floor and needs its own trigger: a student with twelve
good options and no route to Zacatecas is not idle, they are simply going to miss it.

**THE IDLE FLOOR.** Simulated exhaustion across all 30 builds — take the three best actions, spend
all movement, spend both Words — leaves a worst case of **5 meaningful options remaining**, against a
floor of 2.

### The teacher sees it happening

The console's **FACT COVERAGE** grid is one row per student, one column per required fact, with a
`reached` tally along the bottom — the row that tells you which fact the room as a whole is thin on,
which is what you open with tomorrow.

---

## What is honest about Phase 1

- **One scene is authored.** S1.1 has its full action pool; the other 27 timeline segments still run
  as narration and timers only. `design/13-migration-plan.md` has the plan and the arithmetic.
- **Thirty real devices have not been tried.** The loop is verified across browser tabs against the
  real server; a cart of Chromebooks on school wifi is a different test.
- **Thirty real devices have not been tried.** The loop is verified across three browser tabs
  against the real server; a cart of Chromebooks on school wifi is a different test.
- **Nothing is saved.** A server restart resets the room. Carry-forward between sessions needs
  persistence, which is not written.
- **No fog yet.** Everyone sees the whole town. The three visibility states from
  `design/11-map-data.md` are step 5 in the build order.
- **The paper path is still there** and still printable — but see the reading-load finding below
  before relying on it.
- **The timers cannot watch the room.** `design/14-autopilot.md` specifies extending a beat when
  fewer than 70% have acted. That needs student clients to measure and Phase 1 has none. The seam is
  in `timeline.js` (`roomStatus()` returns `null`); until Phase 2, **E extends and you decide.**
- **Narration is the browser's own voice.** `audio.js` looks for `audio/<id>.mp3` first and falls
  back to `speechSynthesis`. That is what makes this hands-free today without rendering anything.
  Drop real mp3s into `audio/` and each one silently upgrades — no code change.
  - Consequence: with the browser voice we cannot know a line's length in advance, so the
    **authored `seconds` is the clock**, not the narration. With real mp3s, invert that per
    `design/12-ken-burns-sequences.md`.
  - The preflight screen tells you what voices this machine actually has, including whether an
    **es-MX** voice exists. If it does not, Spanish lines read as the narrator rather than as an
    English speaker doing an accent — see `design/10-voice-cast.md` rule 1.
- **There are no images yet.** Sequences render **marked placeholders** naming the image, the tier,
  the move and the provenance. That is the designed behaviour, not a failure.
- **Two physical displays could not be tested here.** The transport is verified working across two
  browser tabs; a real projector as a second display is the same code path but has not been run.

---

## Files

```
server/
  serve.js            HTTP + SSE + the three URLs it prints. Zero dependencies.
  room.js             ONE CLASS PERIOD. Owns the timeline and every rule.
app/
  index.html          the console — what the teacher opens
  stage.html          the projector view
  play.html           the student client
  css/app.css         tokens lifted from overview.html; console dark, stage lit
  css/play.css        the student client — the map is the screen
  js/net.js           every view opens its own stream to the server
  js/console.js       the teacher's desk — every control an override
  js/stage.js         the projector renderer — a pure view
  js/play.js          the student client — draws and asks, never decides
  js/hexmap.js        the world. Runs in the browser AND in the server.
  js/kenburns.js      canvas pan/zoom per design/12, with tier enforcement
  js/audio.js         narration: the committed mp3, else the browser voice
  js/tutorial.js      ten steps, solo, curated to the character they made
  content/
    terrain.json      THE MASTER LEGEND — every glyph, colour, cost and light level
    map-gonzales.json the town, 17x13
    map-bexar.json    Béxar and the Alamo, 20x15
    map-in-*.json      five interiors: Ponton's house, the store, the forge,
                       the hotel, a jacal
    session-*.json    the 45-minute timetable
    scene-s*.json     the action pools, one file per scene
    facts-s1.json     every required fact and its fallback
    roster-s1.json    thirty documented people
  audio/              311 rendered narration lines, 11.6 MB, committed
    index.json        which lines have audio, so a missing one costs no request
tools/
  reading-load.js     measures the reading burden of the real content
  sim-class.js        thirty bots against the real engine
  check-maps.mjs      THE MAP VALIDATOR. Run it after touching any map.
  check-content.mjs   THE PEOPLE VALIDATOR. Nobody is playable AND an NPC.
  voices.json         the render cast, and every voice's licence
  get-voices.mjs      fetch the voice models into voices/ (gitignored)
  render-voices.mjs   speak every authored line, once
  piper-render.py     the render worker
voices/               363 MB of models. GITIGNORED. Only needed to re-render.
VOICE_LICENSES.md     what reads this out loud and why we may ship it
.teacher-key          your console key, so the bookmark survives restarts
```

## The world — places, light, and the map key

See **design/17-the-world.md**. In brief, and all of it verified end to end:

**A PLACE IS A MAP.** Seven of them. Every student carries `st.place`, and movement, reach,
occupancy, features and the offer list all go through `Room#mapFor(student)`. Two students who
walk into different buildings in the same second are looking at different worlds a beat later.

**GOING INSIDE IS MOVEMENT, NOT AN ACTION.** It costs one point. Charging a twelve-year-old their
whole turn to open a door teaches them never to open doors. Stand on the threshold and press the
button. Everyone left outside sees a hollow token on the doorstep, and the teacher's desk marks
them `INSIDE` and counts them.

**TERRAIN IS DRAWN, NOT COLOURED.** Grass has blades, fields have furrows, roads are one continuous
rutted ribbon, timber casts shadows, high ground gets surveyor's hachures. The scatter is hashed
from the hex coordinate, so thirty Chromebooks agree to the pixel and nothing crawls on redraw.

**THE MAP SAYS WHAT TIME IT IS.** Every scene declares `time` and `weather`; the ground is washed
for the hour and lit windows come on after dark. Fog is bright and blind, night is dark and blind —
deliberately not the same overlay. The Battle of Gonzales renders as `DAWN` + `FOG`, because that
is what it was.

**THE MAP KEY IS GENERATED**, from the glyphs this map actually contains, ordered by cost then by
what is commonest. Every swatch is a real one-hex map put through the real renderer, so the key
cannot drift out of step with the map.

### Run the validator after touching any map

```bash
node tools/check-maps.mjs
```

It checks row widths, unknown glyphs, landmarks inside walls, portals into places that do not
exist, **portals with no way back**, chests holding items nothing defines, scenes with no time of
day — and it flood-fills every map to find **rooms nobody can walk to**. That last one is why it is
not optional: an interior whose hearth is walled off looks perfectly fine in the JSON and perfectly
fine on screen, and a student finds it by walking at a wall for four minutes.

It found five real faults on its first run, including `bexar_alamo` — a map two scenes had declared
since they were written and which **did not exist**. Béxar and the Alamo were being played on the
Gonzales town grid. Nothing crashed; it just was not Béxar.

## Sitting down — the first ninety seconds

See **design/18-joining-and-catching-up.md**. Five mechanics, none of which asks the teacher to do
anything:

**ONE PERSON, ONE SLOT.** A name is either somebody the class plays or somebody the class walks over
to. Andrew Ponton carries six gated actions across three scenes, so he is the NPC and his roster slot
went to Joseph D. Clements, also of the documented Old Eighteen. Zumwalt, Lockhart and Darst carried
one action each and are better as players, so their shadow NPCs are gone and those actions now send
you to find *the student* — or *a trade*, via the new `adjacent_calling`. Enforced by
`node tools/check-content.mjs`.

**THE TUTORIAL** runs by itself the first time a student picks a name, if the period has not started.
Ten steps, self-paced, **2:44 for this class's bottom quartile and 3:02 for a struggling reader** —
measured, not guessed. It drives the REAL screen through `window.PlayStage`, because a mock is a
promise to keep two interfaces in step forever and nobody keeps it. And it is **cut to the character
they just made**: the smith learns the game in the forge and rolls his own ARMS; the clerk learns it
at the alcalde's table and rolls his own WORD. Step 8 goes badly on purpose, and the fact still
lands — which is the rule of the whole game, taught in the one moment a student is watching closely.

**CALLING BALANCE** is a nudge and then a cap. The pick screen names the three scarcest untaken
trades and sorts them to the top. The cap is `ceil(share × taken) + 2`, so it starts at two per
trade, stops a stampede at three, and has relaxed to the roster's own numbers by the time
twenty-four students are in. It can never lock the last student out, and it never needs to be told
how big the class is.

**THE TOWNSFOLK.** Twenty-two students in a thirty-name town leaves eight documented people with
nobody in the chair, and they stand in the square anyway. They drift toward their trade, gather where
the scene is, get out of doorways, and **stand still when a student walks up to them**. They are
bodies you cannot walk through. They never roll, never fill a clock, never earn Legacy — the
arithmetic of the lesson belongs to the students in the room. They are also why "give a blacksmith
your hands" still works in a class where nobody picked a blacksmith. A student arriving late takes
over their own body exactly where it was standing.

**ABSENCE** is detected on join and handled before the student does anything. Four authored
sentences of fixed history, then what *their* town did with it, then every `must_teach` fact they
missed — granted, and recorded as `caught-up` so the coverage report stays honest. Legacy is not
granted and the card says why. The teacher's desk shows `CAUGHT UP AUTOMATICALLY · name (1 session,
17 facts granted)` — told, not asked.

## Narration — 311 lines, in real voices, in the repo

```bash
node tools/render-voices.mjs --dry     # what would be spoken, and by whom
```

The audio is **committed**; the 363 MB of voice models are **not**. A fresh install on a school
computer plays real neural narration with no download, no Python, no account and no internet. Only
somebody editing the *writing* ever runs the render.

Line ids are an FNV-1a hash of speaker + text, computed identically in `tools/render-voices.mjs`
and `app/js/audio.js`. Authors never assign one; change a word and the audio follows.

Students get a **READ TO ME** button, off by default — because thirty Chromebooks talking at once is
a room nobody can teach in — which reads that student's own outcome and the fact it taught them.
That is design/15 R2: for the bottom quartile, narration is not an accessibility nicety, it is how
they receive the lesson at all.

**Licensing is not hand-waved.** See `VOICE_LICENSES.md`: six voices, all public-domain or
Unlicense, each chosen by reading its actual MODEL_CARD, with the one genuine caveat stated plainly
and a list of what was rejected and why — including `en_US-lessac`, which is the example voice in
Piper's own quickstart and is **not redistributable**.

### `hexmap.js` runs in both places on purpose

The client draws the movement range; the server recomputes it to judge the step. Sharing one module
means the two can never drift into disagreeing about what a hex costs — and a student who edits
their copy only changes what they *see*, not what they may *do*.

### Two bugs found by building it

- **`req.on('close')` fires immediately for a body-less GET** in modern Node — it means the request
  is complete, not that the connection went away. Using it to clean up an SSE stream tears the
  stream down at birth. Listen on `res` instead. Found while chasing a wrong label on the console,
  which is the sort of thing that would have looked like flaky wifi in a classroom.
- **`classList.add('')` throws.** One such call in the console's status band threw inside a render,
  which stopped the Stage receiving state *and* escaped the timer tick — blank projector, frozen
  clock, no visible error. **A broken view must never stop the clock**, and both the room's emit and
  the console's subscriber now isolate view exceptions.

### Two bugs worth remembering

- **`classList.add('')` throws.** One such call in the "calm" ambient branch threw inside `render()`,
  which stopped `StageLink.push()` from ever running *and* propagated out of the timer tick — so the
  Stage stayed blank and the period never advanced, with no visible error. Both `Timeline.emit()` and
  the console's subscriber now isolate view exceptions: **a broken panel must never stop the clock.**
- **The bell was computed from authored lengths**, so extending a beat or pausing desynced it from
  the real bell. It is now wall-clock from the moment the room opened.

---

---

## The reading-load finding — run it yourself

```bash
node tools/reading-load.js
```

It measures the real authored content against published reading rates. The headline:

| | words read per scene | strong | grade level | ~2 yrs below | ~4 yrs below |
|---|---|---|---|---|---|
| paper gamebook | 1,086 | 5:26 ✗ | 7:14 ✗ | 9:52 ✗ | 13:35 ✗ |
| software path | 411 | 2:03 ✓ | 2:44 ✓ | 3:44 ⚠ | 5:08 ✗ |

*(against a 4:30 path)*

**On the paper path not one reader profile fits** — it needs a sustained 241 words per minute just to
read. That is the measurement that moved the map from "polish" to "core": a shown world costs no
reading at all, and it is why the Roll20 shape is the cheaper shape as well as the better one.

## Next

The world layer is built and verified. What remains is listed at the end of
**design/17-the-world.md**: the Alamo compound at its own scale, fog of war, bodies that appear
where a casualty actually fell rather than by hand, and a ford that closes when the river is up.

Phase 2 is the student client (`design-canvas-student/` has the screens designed:
https://claude.ai/code/artifact/734d282c-4e8e-45cb-b01d-81e6c218cf10). Before that,
`design/15-risk-review.md` recommends running **Session 1 on paper with one real class** — and this
app is the instrument for it, since it automates the timers and the narration while the students are
still on Slates. Four things to measure are listed at the end of that review.
