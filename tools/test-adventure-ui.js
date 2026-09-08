#!/usr/bin/env node
/* Mission interactions: stable focus on live updates, safe text, authoritative choices. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const UI = require('../app/js/adventure-ui.js');
const nodes = {};
function node() {
  return { hidden: false, style: {}, attrs: {}, events: {}, writes: 0,
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(k, f) { this.events[k] = f; },
    appendChild(child) { this.child = child; },
    get innerHTML() { return this.html || ''; },
    set innerHTML(value) { this.html = value; this.writes++; },
  };
}
const doc = { getElementById: (id) => nodes[id] ||= node(), createElement: node };
const chosen = [];
const mission = UI.mount(doc, { choose: (o) => chosen.push(o) });
const option = { id: 'lead', actionId: 'real-action', title: '<script>oops</script>',
  reward: 'Tools & supplies', place: 'town', hex: 'B2', atTarget: false };
const me = { characterId: 'p01', place: 'town', guidance: { completed: 2, options: [option] } };
const world = { turnOpen: true, playMode: 'explore' };
mission.render(me, world);
assert.equal(nodes['mission-options'].writes, 1);
assert.match(nodes['mission-options'].html, /&lt;script&gt;/);
assert.match(nodes['mission-options'].html, /Go there/);
assert.doesNotMatch(nodes['mission-options'].html, /<script>/);
mission.render(me, { ...world, remaining: 250 });
assert.equal(nodes['mission-options'].writes, 1, 'Timer updates preserve buttons and keyboard focus');
nodes['mission-options'].events.click({ target: { closest: () => ({ disabled: false, getAttribute: () => 'lead' }) } });
assert.equal(chosen[0].actionId, 'real-action');
assert.equal(chosen[0].atTarget, false, 'Travel does not pretend the action is already available');
me.guidance.options = [{ ...option, atTarget: true }];
mission.render(me, world);
assert.match(nodes['mission-options'].html, /Do this/);
mission.render(me, { ...world, turnOpen: false });
assert.match(nodes['mission-options'].html, / disabled/);
nodes['mission-options'].events.click({ target: { closest: () => ({ disabled: true }) } });
assert.equal(chosen.length, 1, 'Paused mission buttons cannot issue actions');
me.guidance.options = [{ ...option, id: 'new-lead' }];
mission.render(me, world);
assert.equal(mission.current().id, 'new-lead', 'Removed leads cannot remain the selected destination');
mission.waypoint({ screenPoint: () => ({ x: 100, y: 100 }) }, { clientWidth: 500, clientHeight: 400 });
assert.equal(nodes.waypoint.hidden, false);
assert.equal(nodes.waypoint.style.left, '100px');
mission.waypoint({ screenPoint: () => ({ x: -100, y: 100 }) }, { clientWidth: 500, clientHeight: 400 });
assert.equal(nodes.waypoint.hidden, true, 'Off-screen pins do not cover unrelated map controls');
mission.render(me, { ...world, challengeResult: { title: 'Ready', won: true, summary: 'The class prepared.', awarded: { p01: 'A toolkit' } } });
assert.match(nodes['mission-panel'].child.html, /A toolkit/);
assert.equal(nodes['mission-panel'].child.hidden, false);
assert.match(UI.effectsHTML([{ label: 'Supplies', value: 2 }, { label: 'Strain', value: -1 }]), /\+2 Supplies/);
assert.match(UI.effectsHTML([{ label: 'Supplies', value: 2 }, { label: 'Strain', value: -1 }]), /-1 Strain/);
const roster = JSON.parse(fs.readFileSync(path.join(__dirname, '../app/content/roster-s1.json'))).roster;
for (const p of roster) assert.notEqual(UI.role(p.calling)[1], 'Help the town with your own trade', p.calling + ' needs a clear role');
console.log('PASS: mission travel/action states, pause, focus stability, safe text, waypoints, personal rewards, effects and all roster roles.');
