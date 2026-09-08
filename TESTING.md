# Testing Past & Peril

The fun-first overhaul is in progress. Run checks in layers so a basic syntax or data
error is found before a long simulation or browser session. Do not use a real class
code: saved rooms live in `data/` and are part of the teacher's classroom state.

## 1. Fast checks

```powershell
node --check server/engine.js
node --check server/room.js
node --check server/adventure.js
node tools/check-content.mjs
node tools/check-words.mjs
node tools/check-maps.mjs
node tools/check-people.mjs
```

Treat every new error as a regression. Record existing warnings exactly rather than
describing the suite as clean.

## 2. Rule and persistence regressions

```powershell
node tools/test-server.js
node tools/test-recovery.js
node tools/test-screens.js
node tools/test-solo.js
node tools/test-toll.js
node tools/test-loot.js
node tools/test-abilities.js
node tools/test-invites.js
```

Also run any focused adventure/challenge regression added with the overhaul. It must
cover, at minimum:

- exploration movement does not spend movement;
- exploration actions do not spend the three-action challenge budget;
- challenge movement is finite and the fourth action is rejected;
- guidance returns at most three tasks and every destination is reachable;
- a preview reports benefit, risk, and cost from the offered action;
- the result summary matches actual applied state deltas;
- the challenge result evaluates preparation without changing historical fact;
- the existing-item reward is granted once, persists, and is idempotent after replay
  and restore.

If no such focused test exists yet, say so in the handoff. Passing older tests alone
does not verify the new loop.

## 3. Teaching guarantees and simulations

```powershell
node tools/sim-class.js
node tools/sim-class.js --session 2
```

The simulator must still report that **THE FACTS ARE FREE** holds and that no student
is short of required facts. It should exercise a one-student room as well as a typical
class where the available tool supports it. Bots test reachability and invariants;
they do not test boredom, comprehension, social dynamics, or delight.

## 4. Pacing audit

Inspect the session timeline data. The acceptance limits for the redesign are:

- opening housekeeping: **15 seconds or less**;
- each later noninteractive narration beat: **35 seconds or less**;
- the student can enter exploration without waiting through an intro sequence.

Do not infer this from total period length. Check the actual segments a newly joined
student experiences.

## 5. Manual browser playtest

Start an isolated server on an unused port with a temporary data directory and test
key, then use a fresh room. Verify at phone width and laptop width.

Play this route as a student:

1. Choose a role from the suggestion and then use each play-style filter.
2. Skip the tutorial and confirm play starts immediately; replay the tutorial later.
3. Follow each of the three guidance slots. Confirm the waypoint is visible, the
   destination is reachable, and the instruction says exactly what to do.
4. Walk repeatedly during exploration. Movement should remain unlimited.
5. Perform several ordinary actions. The challenge counter should remain untouched.
6. Inspect an action preview, perform it, and compare the reported outcome with the
   visible inventory, clock, fact, flag, or other state change.
7. Enter the shared challenge. Confirm finite movement, three actions, clear feedback
   after each action, progress and pressure bars, phase count, threat warnings, a
   working route to cover, and server rejection of a fourth.
8. Resolve the challenge. Confirm the wording assesses preparation and does not claim
   history changed.
9. Replay/reload, restart the server, and rejoin. The challenge result and reward must
   persist with no duplicate item.
10. Pause and resume from the teacher console. Waiting and paused screens must explain
    why play is locked.

Also verify keyboard, touch, visible focus, readable contrast, and no horizontal
scrolling. A waypoint or preview that exists only on hover fails on student phones.

## 6. Full-room rehearsal

```powershell
node tools/fill-room.mjs --n 24 --room TEST-FUN-01
```

Use a fresh code for every run. Watch the teacher and projector views while playing
one real student alongside the bots. Confirm the room remains responsive, guidance
does not oscillate on every state push, and a broken view cannot stop the room clock.

Then test from a second physical device using the address on the join screen. Failure
to connect is commonly a Windows firewall rule, a wrong network adapter address, or
school Wi-Fi client isolation.

## 7. What a passing suite means

A passing suite supports a claim that the implemented rules are internally consistent
and survive common recovery paths. It does not support a claim that the overhaul is
world-class, intuitive, fun, or ready for a real class. Those claims require observed
student play. Record where students hesitate, ignore guidance, misunderstand costs,
or fail to notice feedback, then revise from that evidence.
