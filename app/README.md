# Past & Peril software

One local server drives four browser views: the teacher console, join screen,
projector stage, and student game. There is no framework, package install, or build
step.

```powershell
node server/serve.js
```

Use the URLs printed by the server. `localhost` works only on the teacher laptop;
students need the ranked local-network address shown on the join screen.

## Current student experience

The student client is undergoing a mission-centered, fun-first redesign. The target
loop is immediate and visible:

1. Pick a documented character with a quick role suggestion or play-style filter.
2. Enter the map immediately; the tutorial is optional.
3. Choose from no more than three reachable missions.
4. Follow a waypoint and a direct “go here / do this” instruction.
5. Preview benefit, risk, and cost, act, then see the real result.
6. Explore freely until a shared challenge begins.
7. Spend three challenge actions with finite movement and receive a class assessment.

The server currently carries provisional support for play modes, free exploration,
challenge action limits, guidance, previews, outcome effects, and persisted challenge
results. Treat all of it as unverified until the focused regressions and browser
playtest in `TESTING.md` pass.

## Rules the interface must communicate

| Mode | Movement | Actions | Student question |
|---|---|---|---|
| Waiting/paused | Locked | Locked | What is happening now? |
| Exploration | Unlimited | Unlimited ordinary actions | What useful thing can I do next? |
| Challenge | Finite | Three per student | How do I help the class prepare and succeed? |

The mission panel is the primary navigation. It shows actual server progress, a map
waypoint, and one specific next action. Action cards show benefit, risk, and cost
before a student commits. The result panel reports actual applied effects; it should
not restate generic authored flavor as if it happened. Extra result facts may begin
collapsed behind a free tap; required facts must still be delivered.

Challenge play shows progress and pressure, the current phase, threat warnings, and a
route to cover. Results describe the class's preparation and performance. Historical
events remain fixed. Rewards come from the existing item catalog and must survive
refresh, restart, replay, and repeated resolution without duplication.

## Pacing and reading

- A student can play as soon as they join and choose a character.
- Opening housekeeping is at most 15 seconds.
- Later noninteractive narration is at most 35 seconds per beat.
- Student-facing authored units are at most 50 words unless an approved exception applies.
- Reading support remains available without making thirty devices speak at once.

## Authority and persistence

`server/room.js` owns room state, time, movement, action limits, challenge state, and
persistence. `server/engine.js` decides which actions are legal and resolves them.
`server/adventure.js` derives guidance and explanatory summaries from that state.

Clients display choices and send intents. The server must still reject an illegal
move, unaffordable action, exhausted challenge action, or duplicate reward claim even
if a student changes browser code.

Room files live in `data/<CLASS-CODE>.json`. Tests must use isolated temporary state.
A restored period returns paused so a restarted laptop cannot resume play into an
empty room.

## Files

```text
app/
  play.html              student shell
  index.html             teacher console
  join.html              join screen
  stage.html             projector
  css/adventure.css      mission-centered redesign
  js/adventure-ui.js     mission, preview, result, challenge UI
  js/play.js             student state and interaction
  js/hexmap.js           shared map and movement implementation
  content/               sessions, scenes, facts, maps, roster, items

server/
  serve.js               HTTP, API, and state streams
  room.js                authoritative room and persistence
  engine.js              action offer and resolution
  adventure.js           guidance and challenge presentation data
```

## Validation

See [`../TESTING.md`](../TESTING.md). Static checks are necessary but cannot validate
waypoint clarity, touch behavior, animation, pacing, or whether students enjoy the
loop. Use a fresh room for manual testing and do not claim classroom readiness before
a real student playtest.
