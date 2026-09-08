/* net.js — the classroom transport.
 *
 * Every view (console, stage, student) opens its own EventSource to the server
 * and renders whatever arrives. Nobody talks to anybody else. That replaces the
 * cross-document bus entirely: with an authoritative server there is no reason
 * for two browser documents to gossip, and one less thing to be wrong.
 *
 * EventSource reconnects on its own, so a closed Chromebook lid, a dropped
 * wifi association, or a walk past the gym all resume with no code. That is
 * most of the reason for choosing SSE over WebSockets. */

const Net = (function () {
  const listeners = {};
  let es = null;
  let room = 'GN7B';
  let role = 'view';
  let key = null;
  let sid = null;
  let onlineState = false;

  function fire(type, payload) {
    (listeners[type] || []).forEach(function (fn) {
      try { fn(payload); } catch (e) { console.error('handler for ' + type, e); }
    });
  }

  /* A stable per-device id. Survives a reload, so a student who refreshes keeps
   * their character instead of being told somebody else has it. */
  function deviceId() {
    /* ?sid=… forces an identity. Two purposes, both real: tools/sim-class.js
     * runs thirty bots in one browser, and localStorage is per-ORIGIN, so
     * without this every tab on one machine would be the same student. */
    const forced = new URLSearchParams(location.search).get('sid');
    if (forced) return forced;
    let v = null;
    try { v = localStorage.getItem('gonzales-sid'); } catch (e) {}
    if (!v) {
      v = 'd' + Math.random().toString(36).slice(2, 10);
      try { localStorage.setItem('gonzales-sid', v); } catch (e) {}
    }
    return v;
  }

  function setOnline(v) {
    if (onlineState === v) return;
    onlineState = v;
    fire('online', v);
  }

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); })
      .catch(function () { setOnline(false); return { ok: false, error: 'offline' }; });
  }

  return {
    get sid() { return sid; },
    get room() { return room; },
    get online() { return onlineState; },
    get isTeacher() { return !!key; },

    on: function (type, fn) { (listeners[type] = listeners[type] || []).push(fn); },

    /* Is a server there at all? Everything else waits on this answer. */
    probe: function () {
      return fetch('api/hello', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });
    },

    connect: function (opts) {
      opts = opts || {};
      role = opts.role || 'view';
      sid = deviceId();
      const params = new URLSearchParams(location.search);
      room = (opts.room || params.get('room') || 'GN7B').toUpperCase();
      key = params.get('key') || null;

      if (es) es.close();
      es = new EventSource('api/stream?room=' + encodeURIComponent(room) +
                           '&role=' + role + '&sid=' + encodeURIComponent(sid));

      es.onopen = function () { setOnline(true); };
      es.onerror = function () { setOnline(false); };   // EventSource retries by itself
      es.onmessage = function (ev) {
        setOnline(true);
        let d = null;
        try { d = JSON.parse(ev.data); } catch (e) { return; }
        if (d.state) fire('state', d.state);
        if (d.you !== undefined) fire('you', d.you);
      };
      return sid;
    },

    /* Teacher commands. Refused by the server without the key that was printed
     * in the terminal, which is why it is not on any student's screen. */
    cmd: function (type, payload) {
      return post('api/cmd', { room: room, key: key, type: type, payload: payload || {} });
    },

    /* Student intents. The server decides whether they were legal. */
    join: function (characterId, tint) {
      return post('api/join', { room: room, sid: sid, characterId: characterId,
                                /* the figurine colour, as a palette index —
                                 * validated server-side, see Room.tintOf */
                                tint: tint });
    },
    move: function (hex) {
      return post('api/act', { room: room, sid: sid, type: 'move', hex: hex });
    },
    act: function (actionId) {
      return post('api/act', { room: room, sid: sid, type: 'act', actionId: actionId });
    },
    /* Walking through a door into somewhere else. Movement, not an action. */
    enter: function (featureId) {
      return post('api/act', { room: room, sid: sid, type: 'enter', featureId: featureId });
    },
    /* The town decides. Sent like any other intent; the server checks that a
     * vote is actually open and that the option exists. */
    vote: function (key) {
      return post('api/act', { room: room, sid: sid, type: 'vote', key: key });
    },
    /* "I have read the catch-up." */
    caughtUp: function () {
      return post('api/act', { room: room, sid: sid, type: 'caughtUp' });
    },
    maps: function () {
      return fetch('api/maps')
        .then(function (r) { return r.json(); })
        .catch(function () { return { ok: false }; });
    },
    ping: function () {
      return post('api/act', { room: room, sid: sid, type: 'ping' });
    },
    roster: function () {
      return fetch('api/roster?room=' + encodeURIComponent(room))
        .then(function (r) { return r.json(); })
        .catch(function () { return { ok: false }; });
    },
  };
})();
