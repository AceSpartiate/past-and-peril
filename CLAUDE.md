# Past & Peril — continuation guide for Claude

Read this file and `design/24-FUN-FIRST-HANDOFF.md` before changing the project. The
old directive in `design/22-START-HERE.md` to build Slice 3 is superseded.

## Current objective

The teacher's classroom feedback was direct: the game felt boring and unintuitive.
Continue the fun-first overhaul until the student experience has a clear loop:

> **Choose a role, receive a reachable mission, move and act, see the consequence,
> prepare for a shared challenge, and separate class performance from historical fact.**

Do not claim the game is world-class, fun, intuitive, classroom-ready, or fully
validated. The implementation is in progress and still needs browser and student
playtesting.

## Source of truth

1. `design/24-FUN-FIRST-HANDOFF.md` — current behavior, implementation status, gaps,
   next priorities, and acceptance checks.
2. This file — durable engineering and teaching constraints.
3. `TESTING.md` — current test order and manual playtest script.
4. `design/21-decisions.md` and older design notes — decision history. Follow them
   only where they do not conflict with the current handoff.

Inspect the working tree before editing. Preserve unrelated changes and do not assume
another agent's unfinished code is verified. `design/` is gitignored on purpose.

## Non-negotiable product behavior

- Outside a shared challenge, movement and ordinary actions are unlimited.
- During a challenge, movement is finite and each student has three actions.
- Guidance contains at most three reachable tasks. Each shows actual progress, a map
  waypoint, and one clear instruction.
- Action cards preview benefit, risk, and cost. Results describe the actual state
  deltas applied by the server.
- Opening housekeeping is at most 15 seconds; later noninteractive narration is at
  most 35 seconds. A student can begin playing immediately.
- The tutorial is optional. Role suggestions are quick, and play-style filters help
  students choose without reading the whole roster.
- The student screen is mission-centered and gives immediate visible feedback.
- A challenge result evaluates preparation and play. It never changes a fixed
  historical outcome.
- Challenge rewards use existing items and persist safely. Replay, restore, repeated
  resolution, and duplicate requests must not grant the item twice.

## Teaching integrity

**THE FACTS ARE FREE.** A student who loses every roll, joins late, ignores the ideal
route, or never wins still receives required history. Facts cannot depend on success,
items, invitations, or another student.

**FIFTY WORDS.** Keep each authored student-facing unit to 50 words or fewer unless an
existing approved exception covers a primary source. Run `check-words.mjs`.

**HISTORICAL TRUTH IS FIXED.** Dice and challenge scores govern preparedness, cost,
and personal consequence. They do not decide whether the Battle of Gonzales, the
Alamo, Goliad, the Runaway Scrape, or San Jacinto happened. Label dramatized or
simulated outcomes plainly.

**SOURCE REAL PEOPLE CAREFULLY.** Never invent an occupation, quotation, relationship,
deed, or motive for a named person. Match roster entries by stable id, not surname.
Preserve documented/open/not-documented distinctions in the research.

**HORIZONTAL REWARDS.** Existing items may open actions or provide bounded utility.
Do not add permanent die-roll bonuses that flatten the three outcome tiers.

## Architecture

| File | Responsibility |
|---|---|
| `server/engine.js` | Offer and resolve actions; requirement and outcome vocabulary |
| `server/room.js` | Authoritative room state, timing, movement, challenges, persistence |
| `server/adventure.js` | Guidance, previews, outcome summaries, challenge assessment |
| `app/js/play.js` | Existing student client and server interaction |
| `app/js/adventure-ui.js` | Mission-centered overhaul UI |
| `app/css/adventure.css` | Overhaul presentation |
| `app/content/*.json` | Authored sessions, scenes, facts, maps, roster, items |
| `tools/` | Validators, simulations, and focused regressions |

The server decides whether movement or an action is legal. Client previews and map
affordances must derive from server state and must not create a second rules engine.
Treat persisted `data/*.json` as classroom state; never use it for routine tests.

## Working rules

- Search before editing and measure the current behavior; older prose is frequently stale.
- Keep changes small enough to review. Preserve work already present in a dirty tree.
- Do not mutate shared authored action objects through a live outcome reference.
- Unknown session clocks are silent no-ops; validate ids when adding content.
- A restored period returns paused. Verify any new play mode through save and restore.
- Keep all mechanics valid for one student and for a full class.
- Do not require teacher adjudication during ordinary play.
- Sessions 3–6 have paper designs but no complete app content. Do not say the digital
  campaign is complete.

## Before handing off

Run the relevant focused checks first, then the core suite in `TESTING.md`. Open a
student screen and verify the experience with a fresh test room. Report exactly what
ran and what did not. A green simulation proves rule invariants; it does not prove
delight, comprehension, device performance, or classroom fit.

Leave the next agent a bounded list: implemented and verified, implemented but
unverified, remaining gaps, exact commands, and the first safe next task. Update
`design/24-FUN-FIRST-HANDOFF.md`; do not resurrect a numbered slice directive.
