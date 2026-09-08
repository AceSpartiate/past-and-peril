/* Presentation only: destinations, legality and progress come from the server. */
(function (root) {
  'use strict';
  const escape = (value) => String(value == null ? '' : value).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const roles = {
    CLERK: ['talk', 'Read documents and carry the town’s words'],
    TRADER: ['talk', 'Negotiate and call in favours'],
    RIDER: ['scout', 'Carry messages and cover ground quickly'],
    RANCHERO: ['scout', 'Read the land and travel the roads'],
    RIFLEMAN: ['scout', 'Stand guard and protect the town'],
    SMITH: ['build', 'Repair equipment and prepare supplies'],
    HOUSEHOLDER: ['build', 'Keep the town fed and ready'],
    HEALER: ['build', 'Help your neighbours recover their resolve'],
  };
  const role = (calling) => roles[calling] || ['build', 'Help the town with your own trade'];
  function effectsHTML(effects) {
    return (effects || []).map((e) => '<span class="effect-chip">' +
      escape(typeof e.value === 'number' && e.value > 0 ? '+' + e.value : e.value) +
      ' ' + escape(e.label) + '</span>').join('');
  }
  function mount(doc, callbacks) {
    const el = (id) => doc.getElementById(id);
    let me = null, world = null, selected = null, options = [], lastHTML = '';
    const result = doc.createElement('div');
    result.className = 'challenge-result'; result.hidden = true;
    result.setAttribute('role', 'status');
    el('mission-panel').appendChild(result);
    function notice(text) {
      el('mission-notice').textContent = text || '';
      el('mission-notice').hidden = !text;
    }
    function current() { return options.find((o) => o.id === selected) || options[0] || null; }
    function render(you, state) {
      me = you; world = state;
      if (!me) return;
      const g = me.guidance || {};
      options = g.options || [];
      if (!options.some((o) => o.id === selected)) selected = options.length ? options[0].id : null;
      el('mission-kicker').textContent = world && world.playMode === 'challenge' ? 'CLASS CHALLENGE' : 'CHOOSE YOUR NEXT MOVE';
      el('mission-title').textContent = g.title || 'Explore the town';
      el('mission-brief').textContent = g.brief || 'Choose a task, walk there, and see what changes.';
      el('mission-progress').textContent = (g.completed || 0) + ' deeds completed · ' + options.length + ' leads nearby';
      // Leads change as the world changes. Do not present them as a fixed completion bar.
      el('mission-meter').hidden = true;
      const boss = world && world.segment && world.segment.boss;
      el('mission-challenge').hidden = !boss;
      if (boss) {
        const bars = '<div class="challenge-phase">Phase ' + escape(boss.phase) + ' of ' + escape(boss.phases) + '</div>' +
          (boss.bars || []).map((id, i) => {
            const c = world.clocks && world.clocks[id];
            if (!c) return '';
            const percent = Math.max(0, Math.min(100, 100 * c.filled / (c.segments || 1)));
            return '<div class="challenge-clock' + (i ? ' pressure' : '') + '"><span>' + escape(c.label) +
              '</span><b>' + escape(c.filled) + ' / ' + escape(c.segments) + '</b>' +
              '<div class="challenge-track" role="progressbar" aria-label="' + escape(c.label) + '" aria-valuenow="' + c.filled +
              '" aria-valuemin="0" aria-valuemax="' + c.segments + '"><i style="width:' + percent + '%"></i></div></div>';
          }).join('');
        if (el('mission-challenge').innerHTML !== bars) el('mission-challenge').innerHTML = bars;
      }
      const toll = boss && world.segment.toll;
      const nextThreat = toll && (toll.at || []).find((at) => at > world.elapsed);
      const covered = toll && ((toll.except_hex_in || []).includes(me.hex) || (toll.except_flag || []).some((f) => (me.flags || []).includes(f)));
      const warning = nextThreat != null && nextThreat - world.elapsed <= (toll.lead || 10) && world.running;
      el('mission-danger').hidden = !warning;
      el('mission-danger').textContent = warning ? (covered ? 'You are protected from the next threat.' : toll.warn || 'A threat is approaching. Find cover.') : '';
      el('mission-cover').hidden = !toll || !world.turnOpen || covered || nextThreat == null;
      el('mission-hint').textContent = g.hint || '';
      const active = !!(world && world.turnOpen);
      const html = options.map((o, i) => '<button type="button" class="mission-option' +
        (o.id === selected ? ' active' : '') + '" data-mission="' + escape(o.id) + '"' +
        (!active ? ' disabled' : '') + '><span class="mo-icon" aria-hidden="true">' +
        (o.atTarget ? '◆' : (i + 1)) + '</span><span class="mo-title">' + escape(o.title) +
        '</span><span class="mo-detail">' + escape(o.reward || o.detail) +
        '</span><span class="mo-tag">' + (o.atTarget ? (o.kind === 'portal' ? 'Enter →' : 'Do this →') : 'Go there →') +
        '</span></button>').join('');
      if (html !== lastHTML) { el('mission-options').innerHTML = html; lastHTML = html; }
      const r = world && world.challengeResult;
      result.hidden = !r;
      if (r) {
        result.className = 'challenge-result' + (r.won ? ' won' : '');
        const reward = r.awarded && r.awarded[me.characterId] || r.reward || '';
        const body = '<strong>' + escape(r.title) + '</strong><p>' + escape(r.summary) +
          '</p>' + (reward ? '<p>' + escape(reward) + '</p>' : '');
        if (result.innerHTML !== body) result.innerHTML = body;
      }
    }
    el('mission-options').addEventListener('click', function (e) {
      const b = e.target.closest('[data-mission]');
      if (!b || b.disabled) return;
      const option = options.find((o) => o.id === b.getAttribute('data-mission'));
      if (!option) return;
      selected = option.id; notice(''); render(me, world);
      callbacks.choose(option);
    });
    el('mission-cover').addEventListener('click', function () { if (callbacks.cover) callbacks.cover(); });
    function waypoint(renderer, canvas) {
      const o = current(), box = el('waypoint');
      if (!o || !o.hex || o.place !== me.place || o.atTarget || !renderer.screenPoint) { box.hidden = true; return; }
      const p = renderer.screenPoint(o.hex);
      box.hidden = !p || p.x < 20 || p.y < 55 || p.x > canvas.clientWidth - 20 || p.y > canvas.clientHeight - 20;
      if (box.hidden) return;
      box.style.left = p.x + 'px'; box.style.top = p.y + 'px';
      el('waypoint-label').textContent = o.title;
    }
    return { render, notice, current, waypoint };
  }
  const api = { escape, role, effectsHTML, mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AdventureUI = api;
})(typeof window !== 'undefined' ? window : globalThis);
