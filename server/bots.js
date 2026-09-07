/* bots.js — TEST MODE. A full class of nobody.
 *
 * WHAT THIS IS FOR. A teacher cannot rehearse a period without twenty-six
 * twelve-year-olds, and the only thing that has ever played this game end to
 * end is tools/sim-class.js, which runs headless in milliseconds and prints
 * numbers. You cannot watch it. Test mode seats the whole roster as bots on
 * the REAL server, on the REAL wall clock, so the projector, the student
 * screen and the teacher's desk all do exactly what they would do in a room.
 *
 * WHAT IT IS NOT. It is not the simulator and it does not replace it.
 * sim-class answers "does every student get every fact"; this answers "what
 * does it look like". A bot has no boredom and no delight, and nothing here
 * measures whether any of it is fun.
 *
 * SAFETY, BECAUSE THIS WRITES TO A REAL ROOM.
 *   · Bots take sids prefixed `bot:` and characterIds nobody has claimed, so
 *     a real student who joins mid-test takes their seat back off a bot.
 *   · It refuses to start in a room that already has real students.
 *   · Turning it off retires every bot and leaves the room empty.
 *   · The room is flagged testMode in the snapshot, so every screen can say so.
 *     A period that was rehearsed must never be mistaken for one that happened.
 */

'use strict';

/* Human-ish pacing. The simulator's profiles, coarsened: the point here is
 * that the room does not move in lockstep, because a class does not. */
const PROFILES = [
  { id: 'fast',       wait: [2, 6],   moves: 2, acts: true },
  { id: 'steady',     wait: [8, 22],  moves: 1, acts: true },
  { id: 'slow',       wait: [20, 55], moves: 1, acts: true },
  { id: 'struggling', wait: [35, 80], moves: 0, acts: true },
  { id: 'elsewhere',  wait: [60, 200], moves: 0, acts: false },
];
const WEIGHTS = [2, 10, 7, 3, 2];

/* Deterministic per room code, so two runs of the same rehearsal look the
 * same and a teacher can show a colleague the thing they just saw. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
function seedOf(code) {
  let h = 2166136261;
  for (let i = 0; i < code.length; i++) { h ^= code.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

class Bots {
  constructor(room) {
    this.room = room;
    this.on = false;
    this.bots = [];
    this.rand = rng(seedOf(room.code || 'TEST'));
  }

  /* Seat everybody who is not already a person. */
  start() {
    const room = this.room;
    /* PRESENT, not ever-joined. The first version of this counted every seat
     * in room.students, which meant a room that a class had already sat in
     * could never be rehearsed again - and those are precisely the rooms a
     * teacher has. A seat nobody has pinged in a minute is a Chromebook that
     * went home. join() then treats it as a reconnect and hands it over,
     * which is the same path a student uses on a machine that slept.
     *
     * A minute rather than the 15s of liveStudents(): a student whose screen
     * dozed off mid-lesson must still block this, and seenCatchUp() parks a
     * real student at now-14s, just inside the live window. */
    const now = room.now();
    const real = Object.keys(room.students).filter((sid) =>
      sid.indexOf('bot:') !== 0 && (now - room.students[sid].seen) < 60000);
    if (real.length) return { ok: false, error: 'real-students-present', students: real.length };

    const pool = [];
    PROFILES.forEach((p, i) => { for (let n = 0; n < WEIGHTS[i]; n++) pool.push(p); });

    const roster = (room.rosterData.roster || []);
    this.bots = [];
    roster.forEach((person) => {
      const sid = 'bot:' + person.id;
      const r = room.join(sid, person.id);
      if (!r || !r.ok) return;
      this.bots.push({
        sid: sid,
        characterId: person.id,
        profile: pool[Math.floor(this.rand() * pool.length)],
        /* ~5% of a class is away on any given day, and a rehearsal that
         * pretends otherwise is rehearsing the wrong period. */
        away: this.rand() < 0.05,
        nextAt: 0,
        movesLeft: 0,
      });
    });
    this.on = true;
    room.testMode = true;
    /* PERMANENT. testMode goes off when the bots do; this never does, because
     * the save file cannot tell you afterwards whether the twenty-six names in
     * it belonged to anybody. */
    room.wasTestMode = true;
    return { ok: true, seated: this.bots.length, away: this.bots.filter((b) => b.away).length };
  }

  stop() {
    const room = this.room;
    this.bots.forEach((b) => { delete room.students[b.sid]; });
    this.bots = [];
    this.on = false;
    room.testMode = false;
    room._emit();
    return { ok: true };
  }

  /* Called from Room#_tick, four times a second. */
  tick() {
    if (!this.on) return;
    const room = this.room;
    const now = room.now();

    this.bots.forEach((b) => {
      if (b.away) return;
      const st = room.students[b.sid];
      if (!st) return;                       // a real student took the seat back
      st.seen = now;                         // bots do not have a browser to ping
    });

    if (!room.turnOpen) return;

    this.bots.forEach((b) => {
      if (b.away) return;
      const st = room.students[b.sid];
      if (!st || st.declared) return;
      if (!b.nextAt) {
        const w = b.profile.wait;
        b.nextAt = now + (w[0] + this.rand() * (w[1] - w[0])) * 1000;
        b.movesLeft = b.profile.moves;
        return;
      }
      if (now < b.nextAt) return;

      /* Walk first, then choose — the same order a student does it in. */
      if (b.movesLeft > 0) {
        b.movesLeft -= 1;
        const priv = room.privateFor(b.sid);
        const reach = (priv.reach || []).filter((h) => h.cost <= st.moveLeft);
        if (reach.length) {
          /* toward the ring if there is one, else anywhere reachable */
          const want = priv.target && reach.filter((h) => h.hex === priv.target)[0];
          const pick = want || reach[Math.floor(this.rand() * reach.length)];
          room.move(b.sid, pick.hex);
        }
        b.nextAt = now + 1500;
        return;
      }

      if (!b.profile.acts) { b.nextAt = now + 30000; return; }

      const offer = room.offerFor(b.sid);
      if (!offer.length) { b.nextAt = now + 5000; return; }
      /* Prefer something that is not the always-available filler, so a
       * rehearsal shows the content rather than twenty-six people holding. */
      const meaty = offer.filter((a) => !/^GEN_/.test(a.id));
      const from = meaty.length ? meaty : offer;
      const choice = from[Math.floor(this.rand() * from.length)];
      room.perform(b.sid, choice.id);

      const w = b.profile.wait;
      b.nextAt = now + (w[0] + this.rand() * (w[1] - w[0])) * 1000;
      b.movesLeft = b.profile.moves;
    });
  }

  /* A new window is a new decision for everybody. */
  reset() {
    this.bots.forEach((b) => { b.nextAt = 0; b.movesLeft = 0; });
  }
}

module.exports = { Bots };
