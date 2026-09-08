# Past & Peril

Past & Peril is a local, browser-based classroom RPG about the Texas Revolution.
Students play documented people from Gonzales, explore a shared world, make choices,
and see what those choices changed. One teacher runs the room from a laptop; students
join from Chromebooks or phones; a projector carries the shared story.

The project is in a **fun-first overhaul** after classroom feedback found the earlier
version boring and hard to understand. The intended loop is now:

> **Pick a role → follow a nearby mission → move and act freely → see the result →
> prepare for a shared challenge → learn what really happened.**

The overhaul is still being implemented and has not been classroom validated. See
[`design/24-FUN-FIRST-HANDOFF.md`](design/24-FUN-FIRST-HANDOFF.md) for the current
contract, implementation status, gaps, and bounded next work. Older numbered design
files record how the project reached this point; they are not the current build order.

## Start the classroom server

On Windows, double-click `START-CLASS.cmd`. For development:

```powershell
node server/serve.js
```

The server prints the teacher, student, join, and projector addresses. It has no
package install or build step. State stays on the teacher's machine in `data/`.

See [`TESTING.md`](TESTING.md) before using the overhaul with students. Only Sessions
1 and 2 currently have playable app content; Sessions 3–6 exist as teacher run sheets
and still need digital authoring.

## Current game contract

- **Exploration:** movement and ordinary actions are unlimited outside a shared
  challenge. Walking should never consume the student's chance to play.
- **Challenges:** movement is finite and each student gets three actions. The result
  measures how well the class prepared and acted; it does not rewrite history.
- **Guidance:** show at most three tasks the student can actually reach. Each task
  names progress, a map destination, and what to do there.
- **Choices:** preview benefit, risk, and cost before commitment. Afterwards, report
  the real state changes caused by that action.
- **Pacing:** students should be able to play immediately. Opening housekeeping aims
  for 15 seconds or less and any noninteractive narration for 35 seconds or less.
- **Interface:** the mission is the center of the student screen. Role suggestions
  and play-style filters get a student into play quickly; the tutorial is optional.
- **Rewards:** a challenge may award an existing item. Replays and restarts must not
  duplicate or erase the reward.

These points describe the target behavior. Until the regression checks and manual
playtest pass, treat the current implementation as provisional.

## Teaching rules

**The facts are free.** Required historical content is never gated by a roll, route,
item, invitation, reading speed, or victory. Student-facing authored text stays at
50 words or fewer unless an approved source exception applies.

**History and simulation stay distinct.** Historical events, people, quotations,
dates, and outcomes come from sources. Player choices model preparation, priorities,
and consequences inside documented uncertainty. The challenge result says how the
class performed; it never says the class changed a fixed historical outcome.

Students play real people, so invented biographical claims are not harmless flavor.
Research marks claims as documented, open, or not documented. Preserve that boundary.

## Project map

| Area | Purpose |
|---|---|
| `server/` | Authoritative room state, rules, timeline, persistence |
| `app/` | Student, teacher, join, and projector screens |
| `app/content/` | Session, scene, map, fact, item, and roster data |
| `tools/` | Validators, simulations, regression tests, release helpers |
| `design/` | Private design history and the current handoff |
| `research/` | Private source work and standards alignment |
| `gm-materials/` | Private teacher run sheets |
| `assessment/` | Private rubrics and teacher materials |
| `player-materials/` | Private character and classroom materials |

The private directories are intentionally ignored because the public repository feeds
the updater and students may find it. Do not force-add them to Git.

## Core checks

```powershell
node --check server/engine.js
node --check server/room.js
node --check server/adventure.js
node tools/check-content.mjs
node tools/check-words.mjs
node tools/check-maps.mjs
node tools/sim-class.js
node tools/sim-class.js --session 2
```

Run the focused server and browser checks listed in [`TESTING.md`](TESTING.md). Automated
checks cannot establish that the game is fun, clear, or classroom-ready; that requires
a real student playtest.
