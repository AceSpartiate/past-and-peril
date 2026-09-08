/* Adventure guidance is derived from the authoritative rules, never a second
 * quest engine. Cached by meaningful state so a timer repaint does not pathfind. */
'use strict';

const guidanceCache = new WeakMap();
const signed = (n) => (n > 0 ? '+' : '') + n;
const outcomes = (a) => Object.values(a.outcomes || {}).filter(Boolean);

function preview(a, ctx) {
  const outs = outcomes(a), good = [], risk = [], costs = [];
  const clocks = new Set(), resources = new Set();
  outs.forEach((o) => {
    Object.keys(o.clocks || {}).forEach((k) => clocks.add(k));
    Object.keys(o.resource || {}).forEach((k) => resources.add(k));
  });
  const range = (values) => {
    const lo = Math.min(...values), hi = Math.max(...values);
    return lo === hi ? signed(hi) : signed(lo) + ' to ' + signed(hi);
  };
  clocks.forEach((k) => {
    const label = (ctx.clockLabels || {})[k] || 'Town progress';
    const line = label + ' ' + range(outs.map((o) => (o.clocks || {})[k] || 0));
    ((ctx.riskClocks || []).includes(k) ? risk : good).push(line);
  });
  resources.forEach((k) => {
    const label = (ctx.resourceLabels || {})[k] || k;
    const vals = outs.map((o) => (o.resource || {})[k] || 0);
    (Math.max(...vals) > 0 ? good : risk).push(label + ' ' + range(vals));
  });
  const itemIds = [...new Set(outs.flatMap((o) => [].concat(o.grant_item || [])))];
  if (a.loot && ctx.itemNames) {
    const names = ctx.lootNames && ctx.lootNames[a.loot];
    if (names && names.length) good.push('Find ' + names.join(', '));
  }
  itemIds.forEach((id) => good.push('Receive ' + ((ctx.itemNames || {})[id] || 'an item')));
  if (outs.some((o) => (o.teach || []).some((id) => !ctx.student.taught[id]))) good.push('Discover a historical fact');
  if (outs.some((o) => o.aid_target)) good.push('Help a classmate’s next roll');
  if (outs.some((o) => o.guard_target)) good.push('Protect a classmate');
  if (outs.some((o) => o.clear_resolve || o.clear_resolve_target || o.clear_resolve_company)) good.push('Recover strain');
  if (outs.some((o) => o.grant_move) && !ctx.movementFree) good.push('Recover movement');
  const strain = Math.max(0, ...outs.map((o) => o.resolve || 0));
  if (strain) risk.push('Up to ' + strain + ' strain');
  if (!good.length && outs.some((o) => o.world || (o.set_flags || []).length)) good.push('Change what happens next');
  if (!good.length && outs.some((o) => o.legacy)) good.push('Record a contribution');
  if (a.cost && a.cost.word) costs.push(a.cost.word + ' Word' + (a.cost.word === 1 ? '' : 's'));
  if (a.cost && a.cost.move && !ctx.movementFree) costs.push(a.cost.move + ' movement');
  return {
    benefit: good.slice(0, 2).join(' · ') || 'See the result of your choice',
    risk: risk.slice(0, 2).join(' · ') || (a.roll ? 'The dice decide how well it goes' : 'No roll'),
    cost: costs.join(' · ') || 'Free',
  };
}

function capture(room, st) {
  return {
    clocks: Object.fromEntries(Object.entries(room.clocks).map(([k, c]) => [k, c.filled])),
    resources: Object.fromEntries(Object.entries(room.ledger).map(([k, c]) => [k, c.value])),
    resolve: st.resolveUsed || 0, legacy: st.legacy || 0,
    moveLeft: st.moveLeft, wordsLeft: st.words - st.wordsSpent,
    items: (st.items || []).slice(),
  };
}

function effects(room, st, before) {
  const out = [];
  Object.entries(room.clocks).forEach(([k, c]) => {
    const n = c.filled - (before.clocks[k] || 0);
    if (n) out.push({ label: c.label, value: n });
  });
  Object.entries(room.ledger).forEach(([k, c]) => {
    const n = c.value - (before.resources[k] || 0);
    if (n) out.push({ label: c.label, value: n });
  });
  const strain = (st.resolveUsed || 0) - before.resolve;
  if (strain) out.push({ label: 'Strain', value: strain });
  const legacy = (st.legacy || 0) - before.legacy;
  if (legacy) out.push({ label: 'Contribution', value: legacy });
  const movement = st.moveLeft - before.moveLeft;
  if (movement) out.push({ label: 'Movement', value: movement });
  const words = (st.words - st.wordsSpent) - before.wordsLeft;
  if (words) out.push({ label: 'Words', value: words });
  (st.items || []).filter((id) => !before.items.includes(id)).forEach((id) => {
    out.push({ label: 'Found', value: (room.item(id) || {}).name || 'An item' });
  });
  return out;
}

function guidance(room, st, offered) {
  const mp = room.mapFor(st), engine = room.engine, ctx = room.ctxFor(st);
  const seg = room._seg() || {};
  const completed = (st.trail || []).filter((entry) =>
    entry.session === room.sessionIndex && entry.scene === room.sceneId).length;
  const key = JSON.stringify([room.sceneId, room.idx, room.playMode, st.hex, st.place,
    st.moveLeft, st.wordsSpent, st.used, st.flags, st.taught, st.items, room.world,
    ctx.clocks, ctx.resources, ctx.others.map((x) => [x.characterId, x.hex, x.place, x.flags]),
    ctx.townsfolk.map((x) => [x.characterId, x.hex]), offered.map((a) => a.id)]);
  let cache = guidanceCache.get(room);
  if (!cache) { cache = new Map(); guidanceCache.set(room, cache); }
  const old = cache.get(st.characterId);
  if (old && old.key === key) return old.value;

  const choices = new Map(), reachable = mp.reachable(st.hex, 10000, room._moveOpts(st));
  const costTo = (hex) => {
    const p = mp.parse(hex);
    return p && reachable[p.c + ',' + p.r];
  };
  const neighbours = (hex) => {
    const p = mp.parse(hex);
    return p ? [hex].concat(mp.neighbours(p.c, p.r).map((n) => mp.label(n.c, n.r))) : [];
  };
  const available = new Map(offered.map((a) => [a.id, a]));
  const add = (a, hex, distance, kind) => {
    if (choices.has(a.id)) return;
    const d = available.get(a.id) || engine.describe(a, ctx, false);
    const freshFact = outcomes(a).some((o) => (o.teach || []).some((id) => !st.taught[id]));
    const realChange = outcomes(a).some((o) => o.clocks || o.resource || o.world || o.grant_item || o.aid_target || o.guard_target);
    if (!freshFact && !realChange && !a.job && !a.loot && !a.requires?.item && a.repeatable) return;
    const priority = (a.job ? 35 : a.loot ? 32 : freshFact ? 30 : realChange ? 24 : 8)
      + (engine.sceneOwn[a.id] ? 8 : 0) + (a.requires?.calling ? 5 : 0)
      + (available.has(a.id) ? 10 : 0) - Math.min(15, distance || 0);
    choices.set(a.id, {
      id: a.id, actionId: a.id, title: d.label, detail: d.detail || '',
      reward: (d.preview || preview(a, ctx)).benefit,
      place: mp.id, hex, atTarget: available.has(a.id), kind: kind || 'action',
      _priority: priority,
      _story: !!freshFact || !!engine.sceneOwn[a.id],
      _world: !!realChange,
      _identity: !!(a.requires && (a.requires.calling || a.requires.item || a.requires.flag)),
    });
  };

  if (room.turnOpen && !(room.challengeOpen && st.declared)) {
    offered.forEach((d) => {
      let a = engine.actions[d.id];
      if (d.id.startsWith('JOB:')) a = engine.jobAction(room.feature(d.id.slice(4)), st.hex);
      if (d.loot) a = engine.lootAction(room.feature(d.loot), st.hex);
      if (a && !a.door) add(a, st.hex, 0, a.job ? 'job' : a.loot ? 'chest' : 'action');
    });

    // Destinations come from the authored spatial gates, not every map hex.
    Object.values(engine.actions).forEach((a) => {
      if (choices.has(a.id) || a.fallback_for || a.repeatable || (a.scenes && !a.scenes.includes(room.sceneId))) return;
      const r = a.requires || {};
      const spatial = ['hex', 'hex_in', 'adjacent_hex', 'adjacent_npc', 'adjacent_character', 'adjacent_calling', 'adjacent_flag'];
      const basic = Object.assign({}, r);
      spatial.forEach((k) => delete basic[k]);
      if (!engine.meets(Object.assign({}, a, { requires: basic }), ctx)) return;
      let destinations = [st.hex];
      if (r.hex) destinations = [r.hex];
      else if (r.hex_in) destinations = r.hex_in;
      else if (r.adjacent_npc) {
        const npc = (room.scene.npcs || []).find((n) => n.id === r.adjacent_npc);
        if (!npc || (npc.place || room.sceneMapId()) !== mp.id) return;
        destinations = neighbours(ctx.npcHex[r.adjacent_npc]);
      } else if (r.adjacent_hex) destinations = neighbours(r.adjacent_hex);
      else if (r.adjacent_character || r.adjacent_calling || r.adjacent_flag) {
        destinations = ctx.others.concat(ctx.townsfolk).filter((p) => (p.place || mp.id) === mp.id)
          .flatMap((p) => neighbours(p.hex));
      }
      const legal = [...new Set(destinations)].map((hex) => ({ hex, cost: costTo(hex) }))
        .filter((x) => x.cost !== undefined && (room.movementFree || x.cost <= st.moveLeft))
        .sort((a, b) => a.cost - b.cost);
      const target = legal.find((x) => {
        const student = Object.assign({}, ctx.student, { hex: x.hex,
          moveLeft: room.movementFree ? st.moveLeft : st.moveLeft - x.cost });
        return engine.meets(a, Object.assign({}, ctx, { student }));
      });
      if (target) add(a, target.hex, target.cost);
    });

    (mp.features || []).forEach((f) => {
      if (!['job', 'chest', 'body'].includes(f.kind) || !engine.openTo(f, st)) return;
      const targets = neighbours(f.hex).map((hex) => ({ hex, cost: costTo(hex) }))
        .filter((x) => x.cost !== undefined && (room.movementFree || x.cost <= st.moveLeft))
        .sort((a, b) => a.cost - b.cost);
      if (!targets.length) return;
      const t = targets[0];
      add(f.kind === 'job' ? engine.jobAction(f, f.hex) : engine.lootAction(f, f.hex),
        t.hex, t.cost, f.kind === 'job' ? 'job' : 'chest');
    });
  }

  const ranked = [...choices.values()].sort((a, b) => b._priority - a._priority);
  const picked = [];
  const take = (test) => {
    const unique = ranked.find((x) => !picked.includes(x) && test(x)
      && !picked.some((p) => p.reward === x.reward));
    const next = unique || ranked.find((x) => !picked.includes(x) && test(x));
    if (next) picked.push(next);
  };
  take((x) => x._story && x.kind === 'action');
  take((x) => x.kind === 'job' || x.kind === 'chest');
  take((x) => x._identity || x._world);
  while (picked.length < 3) {
    const next = ranked.find((x) => !picked.includes(x)
      && !picked.some((p) => p.reward === x.reward)) || ranked.find((x) => !picked.includes(x));
    if (!next) break;
    picked.push(next);
  }
  let options = picked.slice(0, 3).map(({ _priority, _story, _world, _identity, ...option }) => option);
  if (!options.length && room.roamOpen) {
    const portal = (mp.features || []).filter((f) => f.to && f.open !== false && costTo(f.hex) !== undefined)
      .sort((a, b) => costTo(a.hex) - costTo(b.hex))[0];
    if (portal) options = [{ id: portal.id, actionId: null,
      title: portal.to.label || 'Explore another place', detail: 'More work may be waiting through this door.',
      reward: 'Discover another part of town', place: mp.id, hex: portal.hex,
      atTarget: st.hex === portal.hex, kind: 'portal' }];
  }
  const boss = seg.boss;
  const value = {
    title: boss ? 'Boss · ' + boss.name : (room.scene.title || 'Explore the town'),
    /* A TALLY'S instruction IS THE TEACHER'S RUN SHEET - "count hands for
     * anyone without one" - and a student must never be handed that as their
     * brief. Theirs is the question the town is actually being asked. */
    brief: seg.kind === 'tally' ? (seg.question || 'The town is deciding.')
      : seg.instruction || (seg.voice && seg.voice.text)
      || (boss ? 'Fill the town’s progress bar before pressure catches up.' : 'Pick a lead. Walk there. Choose what happens next.'),
    completed, total: completed + choices.size, options,
    hint: room.playMode === 'waiting' ? 'Your adventure begins when the teacher starts.'
      : !room.running ? 'The teacher has paused the game.'
      /* Before the generic pause line: during a tally there IS something to
       * do, and telling them to watch while a live vote sits on their screen
       * is the same contradiction the scrim used to make. */
      : seg.kind === 'tally' ? 'The town is deciding. Choose on your screen.'
      : room.playMode === 'paused' ? 'Watch the scene. Your next move opens in a moment.'
      : room.challengeOpen && st.declared ? 'Your three choices are in. Move into cover before the next phase.'
      : room.movementFree ? 'Explore freely. Your Words are limited; walking is free.'
      : 'Three actions this phase. Save movement to reach cover.',
  };
  cache.set(st.characterId, { key, value });
  return value;
}

function resolveChallenge(room, def) {
  room.challengeResults = room.challengeResults || {};
  const key = room.data.session + ':' + (def.id || def.progress);
  if (room.challengeResults[key]) {
    room.challengeResult = room.challengeResults[key];
    return room.challengeResult;
  }
  const progress = room.clocks[def.progress], pressure = room.clocks[def.pressure];
  if (!progress || !pressure) return null;
  const won = progress.filled >= progress.segments && pressure.filled < pressure.segments;
  const rewardId = [].concat(def.reward || []).find((id) => room.item(id));
  const rewardItem = rewardId && room.item(rewardId);
  const awarded = {};
  if (won) room._allStudents().forEach((st) => {
    if (!rewardItem) return;
    if ((st.items || []).includes(rewardId)) {
      awarded[st.characterId] = 'Already carried: ' + rewardItem.name + '.';
      return;
    }
    const got = room.giveItem(st, rewardId);
    awarded[st.characterId] = got
      ? 'Awarded: ' + got + '.'
      : 'Pack full: ' + rewardItem.name + ' was not added.';
  });
  const result = {
    title: def.title || 'Class challenge', won,
    summary: won ? (def.win || 'Your class reached the goal before pressure caught up.')
      : (def.loss || 'Your class ran out of time before reaching the goal.'),
    reward: won && rewardItem ? 'Reward: ' + rewardItem.name + '.'
      : 'No equipment reward. The historical record remains complete.',
    awarded,
  };
  room.challengeResults[key] = result;
  room.challengeResult = result;
  room.note(result.title + ': ' + result.summary, won ? 'strong' : 'weak');
  return result;
}

module.exports = { preview, capture, effects, guidance, resolveChallenge };
