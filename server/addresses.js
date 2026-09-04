/* addresses.js — which address do I tell the children?
 *
 * Pulled into its own file because there were TWO implementations of this
 * question — server/serve.js had `lanAddresses()` and tools/preflight.mjs had
 * its own `lan()` — and they gave the same wrong answer for the same reason.
 * Fixing one and forgetting the other is how a teacher ends up with a correct
 * banner and a preflight check that still recommends their VPN.
 *
 * THE BUG THIS EXISTS TO FIX
 *
 * Both old versions filtered on `family === 'IPv4' && !internal` and then
 * trusted position 0. `internal` is true only for loopback, so a VPN adapter
 * passes with full standing, and Windows enumerates by adapter order rather
 * than anything useful. A teacher wrote the first address on the board and no
 * student could reach it: it was 10.5.0.2, their NordVPN tunnel (NordLynx).
 * The one that worked was second.
 *
 * SIGNALS, strongest first, and honest about which are guesses.
 *
 *  1. AN ADDRESS A CLIENT HAS ACTUALLY REACHED US ON — not a heuristic at all.
 *     If a browser dialled it and we answered, it demonstrably works. Fed in
 *     by the server from req.socket.localAddress; empty in preflight, which
 *     runs before anything has connected.
 *
 *  2. THE DEFAULT-ROUTE SOURCE ADDRESS. A connected UDP socket transmits
 *     nothing — it forces a route lookup and a source bind. Measured on the
 *     affected machine: returns the real NIC and rejects the VPN, because that
 *     tunnel holds an address but no default route. When a full-tunnel VPN is
 *     genuinely up it owns the default route by design and this picks it. A
 *     good first guess, not a proof.
 *
 *  3. AN ALL-ZERO MAC. WireGuard-family adapters (NordLynx, Tailscale,
 *     WireGuard for Windows) report 00:00:00:00:00:00; a real NIC never does.
 *     Verified on the exact adapter that caused this. Strong but partial —
 *     Hyper-V and VMware adapters carry real-looking MACs.
 *
 *  4. PUBLISHED VIRTUAL OUIs. A vendor assignment match is a fact.
 *
 *  5. THE INTERFACE NAME. A guess, labelled as one: right for the products it
 *     names, blind to the next VPN that ships, and wrong if the adapter was
 *     renamed or Windows localised "Wi-Fi". Small weight; it breaks ties.
 *
 * DELIBERATELY NOT USED — both measured, both backwards:
 *
 *  · INTERFACE METRIC, the obvious choice, picks the VPN. On the affected
 *    machine NordLynx has metric 5 and the real NIC 20, and lower wins.
 *  · NETMASK LENGTH. The VPN was /16 and the NIC /22, which tempts a
 *    longest-prefix rule. Plenty of school LANs are /16.
 */

const os = require('os');
const dgram = require('dgram');

/* APIPA means DHCP failed; CGNAT is Tailscale's range. Neither is ever a
 * school LAN, so these are excluded rather than merely demoted. */
const DEAD = [
  (a) => a.startsWith('169.254.'),
  (a) => {
    const o = a.split('.').map(Number);
    return o[0] === 100 && o[1] >= 64 && o[1] <= 127;
  },
];

const VIRTUAL_OUI = [
  '00:15:5d',                                        // Hyper-V
  '00:03:ff',                                        // Microsoft Virtual Machine
  '00:05:69', '00:0c:29', '00:50:56', '00:1c:14',    // VMware
  '08:00:27', '0a:00:27',                            // VirtualBox
  '02:00:4c',                                        // MS Loopback / Npcap
];
const VIRTUAL_NAME = /nordlynx|wireguard|tailscale|vethernet|vmnet|virtualbox|zerotier|tap-?windows|hamachi|docker|wsl|hyper-?v|proton|expressvpn|openvpn|mullvad|radmin|softether/i;
const REAL_NAME = /^ethernet|^wi-?fi|^wireless|^en\d|^eth\d|^wlan\d|^local area connection/i;

let routeAddr = null;
function defaultRouteAddress() {
  if (routeAddr !== null) return routeAddr;
  routeAddr = '';
  try {
    const s = dgram.createSocket('udp4');
    /* TEST-NET-3. Never routed anywhere, and connect() sends no packet. */
    s.connect(53, '203.0.113.1', () => {});
    s.on('connect', () => {
      try { routeAddr = s.address().address || ''; } catch (e) {}
      try { s.close(); } catch (e) {}
    });
    s.on('error', () => { try { s.close(); } catch (e) {} });
  } catch (e) { routeAddr = ''; }
  return routeAddr;
}
defaultRouteAddress();                                // warm it on load

/* `confirmed` is a Set (or array) of addresses a real client has connected on.
 * The server keeps one; preflight has none to give. */
function ranked(confirmed) {
  const has = (ip) => {
    if (!confirmed) return false;
    return typeof confirmed.has === 'function' ? confirmed.has(ip)
                                               : confirmed.indexOf(ip) !== -1;
  };
  const route = defaultRouteAddress();
  const ifs = os.networkInterfaces();
  const rows = [];
  Object.keys(ifs).forEach((name) => {
    (ifs[name] || []).forEach((a) => {
      if (a.family !== 'IPv4' || a.internal) return;
      if (DEAD.some((f) => f(a.address))) return;
      const mac = String(a.mac || '').toLowerCase();
      let score = 0;
      const why = [];
      if (has(a.address)) { score += 100; why.push('a student reached us here'); }
      if (route && a.address === route) { score += 40; why.push('carries the default route'); }
      if (mac === '00:00:00:00:00:00') { score -= 60; why.push('no hardware address — a VPN tunnel'); }
      if (VIRTUAL_OUI.some((p) => mac.startsWith(p))) { score -= 50; why.push('virtual adapter'); }
      if (VIRTUAL_NAME.test(name)) { score -= 30; why.push('named like a VPN or virtual adapter'); }
      else if (REAL_NAME.test(name)) { score += 10; }
      rows.push({ ip: a.address, name: name, score: score, why: why });
    });
  });
  rows.sort((x, y) => (y.score - x.score) || x.ip.localeCompare(y.ip));
  return rows;
}

module.exports = {
  ranked,
  list(confirmed) { return ranked(confirmed).map((r) => r.ip); },
  defaultRouteAddress,
};
