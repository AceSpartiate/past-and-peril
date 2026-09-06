# TESTING IT
### Your laptop is the teacher. The mini PC is a student. Here is the order to do it in.

---

## 0. Getting it onto the laptop

The whole thing is **one folder and zero dependencies.** There is nothing to install but Node.

1. Install **Node.js LTS** from <https://nodejs.org> — accept every default.
2. Copy the `HistoryDND` folder to the laptop. Anywhere is fine; Documents is fine.
3. Don't copy `voices/` (363 MB of AI voice models) or `data/` (saved periods). Neither is
   needed — the narration is already rendered into `app/audio/`, which **is** part of the folder.

That is the install.

> **How big is it?** About 25 MB, and 12 of that is the 311 recorded narration lines.

---

## 1. Start it

**Double-click `START-CLASS.cmd`.**

It checks the machine, starts the server, and opens your desk in a browser. A black window stays
open — **leave it open for the whole lesson.** Closing it stops the server.

You'll see something like:

```
  ok     Node 22.11.0
  ok     port 8099 is free
  ok     7 places, 10 scenes, 30 characters
  ok     311 narration lines recorded (11.6 MB)
  ok     2 addresses: 10.5.0.2, 192.168.4.38
  warn   NO firewall rule for port 8099...
```

If it says `STOP` anywhere, fix that first — nothing has started.

You can run the checks on their own any time: `node tools/preflight.mjs`

---

## 2. The firewall. Do this before you try the mini PC.

**This is the one that will waste your afternoon.** Windows blocks the port by default, and the
symptom is not an error — the mini PC's browser just spins and eventually gives up. It looks like
the software is broken.

Open PowerShell **as Administrator** and run this once, ever:

```powershell
New-NetFirewallRule -DisplayName "Past and Peril" -Direction Inbound -Protocol TCP -LocalPort 8099 -Action Allow
```

Preflight already checked and told you whether you need it. Right now, on this machine, **you do.**

---

## 3. The four screens

| what | where | who looks at it |
|---|---|---|
| **your desk** | `http://localhost:8099/?key=devkey` | you, on the laptop |
| **the join screen** | `http://localhost:8099/join` | the projector, while they arrive |
| **the projector** | `http://localhost:8099/stage.html` | the projector, during the lesson |
| **a student** | `http://10.5.0.2:8099/p` | the mini PC |

The join screen is the one to have up first: the address in type readable from the back of the
room, a **QR code** so anything with a camera skips the typing entirely, and the names of everyone
who has joined so far, appearing live.

> **The address will be different on school wifi.** The laptop gets a new IP on every network. The
> server prints the current one every time it starts, and the join screen always shows the right
> one — so put the join screen on the projector and read it off that rather than writing anything
> down.
>
> Your laptop has two addresses right now. If the mini PC can't reach the first, try the second.

---

## 4. Test it alone, with a full class

You can't be thirty students. So:

```bash
node tools/fill-room.mjs --n 24
```

This joins **24 students over HTTP** — the same requests a Chromebook makes, not a shortcut through
the back. They move, they choose actions, they take 20–60 seconds over each one like people do.
Leave it running in its own window.

Now you have a real class in front of you. Go to your desk, press **START**, and watch:

- the room list fills with names
- the coverage meter moves as facts get delivered
- the feed scrolls with what students are actually doing
- 6 **townsfolk** appear on the map — the roster characters nobody claimed
- the projector broadcasts named students by name

Then open one more browser window as **a real student among them** — `http://localhost:8099/p?sid=me`
— and play alongside the bots.

`Ctrl-C` in the fill-room window when you're done. The period is untouched.

Flags: `--n 24` how many · `--room 7B` which class · `--host 192.168.4.38` a server on another
machine · `--quiet` join and stand still · `--seed 7` reproduce a run you liked.

> **Use a fresh class code each time you test** — `--room 7C`, `7D`, and so on. A code that has been
> played before comes back as a **restored, paused** period, and then START does nothing and RESUME
> is the button. That is deliberate, and it will confuse you at least once. It confused me.

**What tells you it is really working:** the desk should read something like
`24 connected · 21 acted · 6 townsfolk` within a minute of the window opening. If *acted* stays at 0
while the feed is scrolling, something is wrong — that pairing was broken until today.

---

## 5. What to actually look at, in order

**A. Does a student get in?**
Mini PC → the student URL → tap a name. The pick screen should say *"The town still needs: healer,
rifleman, smith"* with those cards badged and sorted first.

**B. Does the tutorial run?**
It should start **by itself** the first time, because the period hasn't started. Ten steps, and it
should take you **under three minutes**. Watch for:
- step 1 naming *your* ability
- the hex you're sent to being **ringed with GO HERE** — you should never have to read where to go
- step 6 leaving your movement at **0/3**, so "searching costs your turn" lands
- **step 8, which is the whole point.** It goes badly on purpose — and the fact still appears
  underneath. That is the rule of the game.

Pick a **blacksmith** and then a **clerk** and run it twice. They should be genuinely different
tutorials: different building, different item, different stat.

To run it again: the **Show me how to play again** button on the lock screen.

**C. Does the world look like a world?**
Open the map key (top right). It should list only what's on *this* map, commonest ground first,
with real drawn swatches. Then walk into Zumwalt's store — **your map should change and nobody
else's should.** Look at your token from the other machine: a hollow ring on the doorstep.

**D. Does the lesson drive itself?**
Press START and then **do nothing**. The timeline should run the whole 45 minutes on its own —
reads, turn windows opening and closing, the tally. That's the thing to verify, because it's the
promise the whole design rests on.

**E. Does absence work?**
Let a period finish (or `goto` the last segment). Then advance the session and join as a character
who wasn't there. You should get four sentences of what happened, what your class voted, and the
facts you missed — handed over, marked *caught up*. And your desk should say so without being asked.

---

## 6. When something is wrong

| symptom | it is almost certainly |
|---|---|
| mini PC spins forever, no error | **the firewall** (§2) |
| mini PC says "can't reach" instantly | wrong IP — try the other one on the join screen |
| both machines see it, but not each other | school wifi **client isolation**. Ask IT to allow device-to-device, or use a cheap switch and two cables — this needs no internet at all |
| `port 8099 is already in use` | a server from earlier is still running. Close the other black window |
| narration is silent | it is **off by default** — one student, one **READ TO ME** button. Thirty devices talking at once is not a lesson |
| narration sounds robotic | that line has no recording yet and fell back to the browser voice. `node tools/render-voices.mjs --dry` shows what is missing |
| a student's screen is frozen | reload it. They rejoin into the true state, standing where they were, keeping everything they found |
| you closed the black window mid-lesson | restart it. The period comes back **paused**, exactly where it was. Press RESUME |
| **you press START and nothing happens** | that class code has been played before, so the period was restored — and a restored period is always **paused**. The button you want is **RESUME**. This caught me while testing; it is designed behaviour, not a fault |
| you want a genuinely clean slate | **stop the server first**, then empty the `data` folder, then start again. Deleting while it is running does not work — it writes the period back a few seconds later |

---

## 7. The checks you can run any time

```bash
node tools/preflight.mjs          # is this machine ready
node tools/check-maps.mjs         # are the seven maps sane
node tools/check-content.mjs      # are the people and the actions honest about each other
node tools/sim-class.js           # 30 bots, one period, against the engine
node tools/sim-class.js --session 2
node tools/render-voices.mjs --dry
```

`check-content.mjs` currently reports **6 errors on purpose** — six characters whose Calling in the
app contradicts a Calling their paper card marks FIXED. Those predate this build and each one is a
decision for you, not a bug. `Jacob C. Darst` is the one to look at first: the app calls him The
Blacksmith, and the research says that shop is only *possibly* his.

---

## 8. New since you last tested — what to look at

**Movement.** When your turn opens, the map DIMS everywhere you cannot walk
and draws one hard line round the edge of where you can. Hover a hex and it
shows the route it will walk; tap it and your figurine walks the route rather
than jumping. `MOVE` pips in the turn bar go out as you spend them, and when
you are out the veil lifts — the whole map going bright again *is* the message.

The rule was never broken; nothing on screen said what it was.
`node tools\probe-movement.js` measures it: 3 to 40 hexes offered out of 300,
and every far hex refused.

**Character creation.** Tapping a name no longer drops you onto the board. It
opens a creation screen: your person, your ability, your stats, and **twelve
colours with a live preview of your figurine**. A badge shows how many
classmates already took each colour — a nudge, not a rule.

**Figurines.** Students are no longer identical dots. The silhouette differs by
Calling and the colour is the one they chose. Check it in greyscale if you
like: the shapes still separate, so a colour-blind student loses nothing.

**Documents.** There is no paper. Press START and let it reach the cold open —
the Turtle Bayou Resolutions **open by themselves** on every student screen,
with the verbatim text set apart from the apparatus around it. After that they
live behind a **DOCUMENTS** button, and a student who joins late or was absent
is given everything the room has already been handed.

**Pull the plug mid-lesson.** Close the black window while a student is
part-way through a turn. Their screen should go red at the bottom, grey out the
action cards, and refuse taps. Start it again and they recover on their own,
with no reload — landing on **"Eyes up front."** because a restored period is
paused.

**The address on the board.** Preflight now ranks your addresses and says why
it demoted one:

```
  ok     2 addresses, best first
           -> http://192.168.4.38:8099/p   (Ethernet 4)
              http://10.5.0.2:8099/p   (NordLynx)
               no hardware address — a VPN tunnel
```

`10.5.0.2` is your NordVPN adapter. Windows enumerates it first, and the old
code trusted whatever came first — which is why the address on the board was
unreachable. The projector screen also re-checks every few seconds and switches
to an address a student has **actually** connected on, so if the ranking is
ever wrong it corrects itself in front of the class.

> `localhost` only works in a browser **on the laptop running the server.** The
> banner now prints both, labelled. That is what went wrong with `/join`.

---

## 9. What is not built yet

So you don't go looking for it:

- **Sessions 3 to 6 in the app.** Only 1 and 2 are playable. All six are designed on paper in
  `gm-materials/` — the thinking is done, the JSON is not written.
- **Fog of war.** You can see the whole map, always.
- **The Alamo at its own scale.** It reads as a walled block at 110 yards a hex.
- **Bodies to search** exist only on the Béxar map and were placed by hand — nothing in the content
  generates a casualty where one actually fell.
- **The ford never closes**, though the river was up on 1 October.
- **The tutorial's own words** use the browser voice, not the recorded one.
