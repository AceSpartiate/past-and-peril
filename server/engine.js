/* engine.js — the spiderweb, from design/08-rule-schema.md.
 *
 * Nobody writes "if you chose X, go to Y." Authors write ACTIONS WITH
 * CONDITIONS, and this computes what each of thirty students can do right now.
 * The combinatorics are emergent: ~200 rules generate more distinct situations
 * than 490 authored passages could, because they multiply against thirty
 * character builds instead of adding along authored arrows.
 *
 * Two guarantees live here, and both are enforced in code rather than trusted
 * to an author's diligence:
 *
 *   THE FACTS ARE FREE   no student can fail their way out of the content
 *   THE IDLE FLOOR       no student is more than 20 seconds from something
 *                        worth doing
 */

class Engine {
  constructor(scene, facts, map, common) {
    this.scene = scene;
    this.map = map;              // the scene's default place
    this.facts = {};
    (facts.facts || []).forEach((f) => { this.facts[f.id] = f; });

    /* Shared actions first, then the scene's own. design/13 Stage 2: the eight
     * Callings are authored once and every scene gets them, which is what makes
     * a twenty-action scene affordable to write. */
    this.actions = {};
    ((common && common.actions) || []).forEach((a) => { this.actions[a.id] = a; });
    this.sceneOwn = {};
    (scene.actions || []).forEach((a) => {
      this.actions[a.id] = a;
      this.sceneOwn[a.id] = true;
    });

    /* Fallbacks are authored once per FACT, not per scene (design/08). */
    this.fallbacks = {};
    (facts.facts || []).forEach((f) => {
      if (!f.fallback) return;
      const fb = Object.assign({}, f.fallback, {
        fallback_for: f.id,
        requires: {},
        outcomes: { all: { narrate: f.statement, teach: [f.id] } },
      });
      this.fallbacks[fb.id] = fb;
      this.actions[fb.id] = fb;
    });
  }

  /* WHICH WORLD. A student inside Zumwalt's store is not standing in the
   * square, and the chest by the counter is not the chest in the forge. Every
   * map question goes through here so that can never be got wrong. */
  _map(ctx) { return (ctx && ctx.map) || this.map; }

  /* ---------------------------------------------------------------- requires
   * All conditions are AND. For OR, write two actions — which keeps this
   * debuggable at 3am, which is when it will be debugged. */
  meets(a, ctx) {
    const r = a.requires || {};
    const st = ctx.student;

    if (r.calling && r.calling.indexOf(st.calling) === -1) return false;
    if (r.origin && r.origin.indexOf(st.origin) === -1) return false;
    if (r.mark && r.mark.indexOf(st.mark) === -1) return false;
    if (r.mark_absent && r.mark_absent.indexOf(st.mark) !== -1) return false;
    if (r.role && r.role.indexOf(st.role) === -1) return false;
    if (r.person && r.person.indexOf(st.characterId) === -1) return false;
    if (r.scene_kind && r.scene_kind.indexOf(this.scene.kind) === -1) return false;

    if (r.strength && r.strength !== st.strength) return false;
    if (r.stat) {
      for (const k in r.stat) if ((st.stats[k] || 0) < r.stat[k]) return false;
    }

    if (r.flag) { for (const f of r.flag) if (!st.flags[f]) return false; }
    if (r.flag_absent) { for (const f of r.flag_absent) if (st.flags[f]) return false; }
    if (r.world_flag) { for (const f of r.world_flag) if (!ctx.world[f]) return false; }
    if (r.world_flag_absent) { for (const f of r.world_flag_absent) if (ctx.world[f]) return false; }

    if (r.hex && r.hex !== st.hex) return false;
    if (r.hex_in && r.hex_in.indexOf(st.hex) === -1) return false;

    if (r.adjacent_npc && !this.adjacentTo(st.hex, ctx.npcHex[r.adjacent_npc], this._map(ctx))) return false;
    /* the map matters here: a hex label means a different place indoors */
    if (r.adjacent_hex && !this.adjacentTo(st.hex, r.adjacent_hex, this._map(ctx))) return false;
    if (r.adjacent_character && this.neighbours(st, ctx).length === 0) return false;
    /* "Find somebody of this trade." A student counts, and so does a
     * townsman nobody is playing — the town HAS a blacksmith whether or not
     * a student picked him this period. Contrast adjacent_character above,
     * which means a CLASSMATE and only a classmate, because aiding somebody
     * who will never roll is a wasted turn. */
    if (r.adjacent_calling) {
      const mp = this._map(ctx);
      const pool = this.neighbours(st, ctx).concat(
        (ctx.townsfolk || []).filter((t) => this.adjacentTo(st.hex, t.hex, mp)));
      if (!pool.some((o) => r.adjacent_calling.indexOf(o.calling) !== -1)) return false;
    }

    if (r.clock) {
      for (const k in r.clock) if (!this.cmp(ctx.clocks[k], r.clock[k])) return false;
    }
    if (r.resource) {
      for (const k in r.resource) if (!this.cmp(ctx.resources[k], r.resource[k])) return false;
    }
    if (r.standing) {
      for (const k in r.standing) if (!this.cmp(ctx.standing[k], r.standing[k])) return false;
    }

    /* Once per scene, unless the action says otherwise. Counting the powder
     * twice is not a choice, and a pool you can spam is not a pool. This is
     * also what makes exhaustion real, which is what the reserve ladder is
     * there to catch. */
    if (!a.repeatable && st.used && st.used[a.id]) return false;

    /* Affordability is a condition too — an option a student cannot pay for
     * must never be shown. design/09: no greyed-out teases, it reads as
     * punishment. */
    const cost = a.cost || {};
    if (cost.move && st.moveLeft < cost.move) return false;
    if (cost.word && (st.words - st.wordsSpent) < cost.word) return false;

    return true;
  }

  cmp(value, test) {
    if (typeof test === 'number') return (value || 0) >= test;
    const m = String(test).match(/^(>=|<=|>|<|=)?\s*(-?\d+)$/);
    if (!m) return false;
    const v = value || 0, n = Number(m[2]);
    switch (m[1]) {
      case '<=': return v <= n;
      case '<': return v < n;
      case '>': return v > n;
      case '=': return v === n;
      default: return v >= n;
    }
  }

  adjacentTo(hexA, hexB) {
    if (!hexA || !hexB) return false;
    if (hexA === hexB) return true;
    const mp = arguments[2] || this.map;
    const a = mp.parse(hexA);
    if (!a) return false;
    return mp.neighbours(a.c, a.r).some((n) => mp.label(n.c, n.r) === hexB);
  }

  /* Who is standing next to you, IN THE SAME PLACE.
   *
   * Two students on the same hex LABEL in different buildings are not
   * neighbours — C3 in Zumwalt's store and C3 in the forge are not the same
   * four feet of Texas. This was wrong in exactly the way adjacent_hex was,
   * and it matters more now that three actions turn on standing beside a
   * classmate of a particular trade. */
  neighbours(st, ctx) {
    const mp = this._map(ctx);
    const here = mp.id;
    return ctx.others.filter((o) => o.characterId !== st.characterId &&
      (o.place || here) === here &&
      this.adjacentTo(st.hex, o.hex, mp));
  }

  /* ---------------------------------------------------------------- meaning
   *
   * design/08's idle floor turns on a definition, so here it is, checkable:
   * an action counts toward the floor only if it is not the one you just took,
   * AND it changes world state, teaches a fact you have not had, affects
   * another student, or sets a flag. A "look around" that does none of those is
   * FILLER, and filler does not count. */
  isMeaningful(a, ctx) {
    if (a.id === ctx.student.lastActionId) return false;
    const outs = a.outcomes || {};
    const tiers = [outs.all, outs.strong, outs.partial, outs.weak].filter(Boolean);
    for (const o of tiers) {
      if (o.world && Object.keys(o.world).length) return true;
      if (o.set_flags && o.set_flags.length) return true;
      if (o.clear_flags && o.clear_flags.length) return true;
      if (o.aid_target || o.guard_target) return true;
      if (o.clocks && Object.keys(o.clocks).length) return true;
      if (o.teach) {
        for (const f of o.teach) if (!ctx.student.taught[f]) return true;
      }
    }
    return false;
  }

  /* ---------------------------------------------------------------- offer
   *
   * What this student can do, right now. Order matters: the reserve ladder
   * promotes to the TOP of the list, not the bottom, because an option nobody
   * scrolls to is not an option. */
  offer(ctx) {
    const st = ctx.student;
    const base = Object.values(this.actions)
      .filter((a) => !a.fallback_for)
      .filter((a) => !a.scenes || a.scenes.indexOf(this.scene.id) !== -1)
      .filter((a) => this.meets(a, ctx));

    let list = base.slice();
    const meaningful = list.filter((a) => this.isMeaningful(a, ctx));

    const promoted = [];

    /* Reserve 1 — AID/GUARD on a named neighbour. Costs nothing, grants
     * Legacy, needs no new authoring, and is the right answer thematically:
     * the reward for being fast is that you get to help somebody. */
    if (meaningful.length < 2) {
      const near = this.neighbours(st, ctx);
      if (near.length) {
        list.filter((a) => (a.verb === 'AID' || a.verb === 'GUARD'))
          .forEach((a) => { if (promoted.indexOf(a) === -1) promoted.push(a); });
      }
    }

    /* Reserve 2 — a SEEK carrying a must_teach fact this student has not had.
     * Doubles as coverage, which is why it sits above the authored depth. */
    const owed = this.owedFacts(st);
    const pushFallbacks = () => {
      owed.forEach((fid) => {
        const f = this.facts[fid];
        if (f && f.fallback && this.fallbacks[f.fallback.id] &&
            promoted.indexOf(this.fallbacks[f.fallback.id]) === -1) {
          promoted.push(this.fallbacks[f.fallback.id]);
        }
      });
    };
    if (meaningful.length + promoted.length < 2 && owed.length) pushFallbacks();

    /* THE FALLBACK SWEEP (design/14). Near the end of the window, a fact this
     * student is still owed is promoted to the top of their list — whether or
     * not they are short of things to do. A student with twelve good options
     * and no route to Zacatecas is busy and about to miss required content,
     * and nobody would notice.
     *
     * ONE fact, not all of them. The simulator showed why: promoting five
     * near-identical "ask someone about X" options at once dilutes the signal
     * and buries the choice among nineteen. One unambiguous top option is both
     * better to look at and likelier to be taken. */
    if (ctx.sweep && owed.length) {
      const f = this.facts[owed[0]];
      if (f && f.fallback && this.fallbacks[f.fallback.id] &&
          promoted.indexOf(this.fallbacks[f.fallback.id]) === -1) {
        promoted.unshift(this.fallbacks[f.fallback.id]);
      }
    }

    /* Reserve 3 — authored depth, reachable only once you have already acted. */
    if (meaningful.length + promoted.length < 2) {
      (this.scene.depth_reserve || []).forEach((id) => {
        const a = this.actions[id];
        if (a && this.meets(a, ctx) && promoted.indexOf(a) === -1) promoted.push(a);
      });
    }

    /* Anything worth searching where you are standing, or next to you.
     * Generated from the map rather than authored, because a chest is a fact
     * about the world and not a fact about this scene. */
    const mp = this._map(ctx);
    const at = mp.parse(st.hex);
    const here = [st.hex].concat(
      (at ? mp.neighbours(at.c, at.r) : []).map((n) => mp.label(n.c, n.r)));
    here.forEach((hx) => {
      mp.featuresAt(hx).forEach((f) => {
        if ((f.kind === 'chest' || f.kind === 'body') && !f.searched) promoted.push(this.lootAction(f, hx));
        /* A portal is walked through, not "acted" on — see Room#enter. Offering
         * it as an action too would charge a student their turn for a door. */
        if (f.kind === 'door' && !f.to) promoted.push(this.doorAction(f, hx));
      });
    });

    /* Reserve 4 — the floor of the floor. Always something. */
    if (!list.length && !promoted.length) {
      const hold = this.actions.GEN_HOLD;
      if (hold) promoted.push(hold);
    }

    /* ORDER MATTERS, and getting it wrong is invisible.
     *
     * The pool used to come out in load order, which put the shared filler —
     * GEN_HOLD, "do nothing" — ahead of everything a scene was actually
     * authored to be about. A student scanning the list saw the least
     * interesting option first, and tools/sim-class.js, which always takes the
     * top option, never reached the scene content at all.
     *
     *   promoted (the sweep, the reserve ladder)
     *   this scene's own actions          ← what the scene is about
     *   your Calling's actions            ← what only you can do
     *   the always-available filler       ← last, always */
    const rank = (a) => {
      if (a.repeatable) return 3;
      if (this.sceneOwn[a.id]) return 1;
      return 2;
    };
    const seen = {};
    const out = promoted.concat(list.slice().sort((x, y) => rank(x) - rank(y)))
      .filter((a) => {
        if (seen[a.id]) return false;
        seen[a.id] = true;
        return true;
      });

    return out.map((a) => this.describe(a, ctx, promoted.indexOf(a) !== -1));
  }

  /* Searching is an ACTION — it costs you the turn, like anything else. */
  lootAction(f, hx) {
    return {
      id: 'LOOT:' + f.id,
      verb: 'SEEK',
      dynamic: true,
      label: f.searchLabel || ('Search ' + f.label.toLowerCase() + '.'),
      detail: f.note || 'Nobody has been through it yet.',
      requires: {},
      loot: f.id,
      outcomes: { all: { narrate: f.note || '' } },
    };
  }

  doorAction(f, hx) {
    return {
      id: 'DOOR:' + f.id,
      verb: 'ACT',
      dynamic: true,
      label: (f.open ? 'Close ' : 'Open ') + f.label.toLowerCase() + '.',
      detail: f.open
        ? 'Shut it, and whoever is behind you stays behind you.'
        : 'It is shut. Nobody gets through it while it stays that way.',
      requires: {},
      door: f.id,
      outcomes: { all: { narrate: '' } },
    };
  }

  owedFacts(st) {
    return (this.scene.must_teach || []).filter((f) => !st.taught[f]);
  }

  /* Who is standing next to this student, in words. Used to fill {adjacent},
   * and exposed so nothing else has to reimplement it. */
  fillIn(text, ctx) {
    const near = this.neighbours(ctx.student, ctx);
    const who = near.length ? near[0].name
      : ((ctx.townsfolk || []).filter((t) =>
           this.adjacentTo(ctx.student.hex, t.hex, this._map(ctx)))[0] || {}).name || 'them';
    return String(text || '').split('{adjacent}').join(who);
  }

  describe(a, ctx, promoted) {
    const st = ctx.student;
    const near = this.neighbours(st, ctx);
    const sub = (s) => this.fillIn(s, ctx);
    return {
      id: a.id,
      verb: a.verb || 'ACT',
      label: sub(a.label),
      detail: sub(a.detail),
      cost: a.cost || {},
      roll: a.roll || null,
      gate: this.gateLabel(a),
      promoted: !!promoted,
      fallback: !!a.fallback_for,
      dynamic: !!a.dynamic,
      loot: a.loot || null,
      door: a.door || null,
      target: (a.requires && a.requires.adjacent_character && near.length) ? near[0].name : null,
    };
  }

  /* What the student sees about WHY an option is theirs. design/09: a student
   * should SEE that an option is available because of who they are — that
   * perception is the entire feeling of "my character matters." */
  gateLabel(a) {
    const r = a.requires || {};
    const bits = [];
    if (r.calling) bits.push(r.calling.join('/'));
    if (r.mark) bits.push('✦ ' + r.mark.join('/').replace(/_/g, ' '));
    if (r.flag) bits.push('✦ ' + r.flag.join('/').replace(/_/g, ' '));
    if (a.cost && a.cost.word) bits.push('COSTS A WORD');
    if (a.roll) bits.push('ROLL ' + a.roll.stat.toUpperCase());
    return bits.join(' · ');
  }

  /* ---------------------------------------------------------------- resolve */
  d6() { return 1 + Math.floor(Math.random() * 6); }

  resolve(actionId, ctx, opts) {
    let a = this.actions[actionId];
    if (!a && /^(LOOT|DOOR):/.test(actionId)) {
      /* Regenerate the world action and re-check it is legitimately reachable
       * from where this student is actually standing. A client asking to open a
       * door across town gets nothing. */
      const f = this._map(ctx).feature(actionId.split(':')[1]);
      if (f) {
        const offered = this.offer(ctx).filter((x) => x.id === actionId)[0];
        if (offered) a = actionId.indexOf('LOOT') === 0 ? this.lootAction(f, f.hex) : this.doorAction(f, f.hex);
      }
    }
    if (!a) return { ok: false, error: 'no-such-action' };
    if (!a.dynamic && !this.meets(a, ctx)) return { ok: false, error: 'not-available' };

    const st = ctx.student;
    let tier = 'all';
    let d1 = null, d2 = null, total = null, bonus = 0;

    if (a.roll) {
      /* Both dice, not the sum — pre-teens need to SEE the dice, so the client
       * has to be able to draw the actual pips. */
      d1 = this.d6(); d2 = this.d6();
      bonus = (st.stats[a.roll.stat] || 0) + (opts && opts.aidBonus ? opts.aidBonus : 0);
      total = d1 + d2 + bonus;
      /* design/02: 10+ HELD · 7–9 HELD AT A COST · 6- GAVE GROUND
       * — and on every tier you still learn something true. */
      tier = total >= 10 ? 'strong' : (total >= 7 ? 'partial' : 'weak');
    }

    const outs = a.outcomes || {};
    const out = outs[tier] || outs.all || {};

    return {
      ok: true,
      action: a,
      tier: a.roll ? tier : null,
      d1, d2, bonus, total,
      stat: a.roll ? a.roll.stat : null,
      outcome: out,
      cost: a.cost || {},
    };
  }

  /* ---------------------------------------------------------------- coverage
   *
   * The engine will not let a scene converge until every student has been
   * OFFERED at least one action delivering each must_teach fact. This is the
   * report the console's FACT COVERAGE panel is drawn from. */
  coverage(students) {
    const need = this.scene.must_teach || [];
    return {
      facts: need.map((f) => ({
        id: f,
        short: this.facts[f] ? this.facts[f].short : f,
        reached: students.filter((s) => s.taught[f]).length,
      })),
      students: students.map((s) => ({
        characterId: s.characterId,
        name: s.name,
        missing: need.filter((f) => !s.taught[f]),
      })),
      complete: students.every((s) => need.every((f) => s.taught[f])),
    };
  }
}

module.exports = { Engine };
