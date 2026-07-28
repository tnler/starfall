/* STARFALL — tools/netcheck.mjs
   Two guardians, one shard. Talks the real wire protocol to a running server
   and asserts the things that decide whether a friend can actually play:
   the handshake, host election, seeing each other move, chat, and the host
   handover when the host leaves.

     node serve.js &                     (or npm start)
     node tools/netcheck.mjs [url]
*/

const URL_ = process.argv[2] || 'ws://localhost:7722';
const ok = [], bad = [];
const check = (name, cond, detail = '') => {
  (cond ? ok : bad).push(`${cond ? 'ok   ' : 'FAIL '} ${name}${detail ? ' — ' + detail : ''}`);
  return !!cond;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function guardian(name, classId) {
  const g = { name, classId, seen: [], ws: null, id: null, host: null, chats: [], states: [] };
  g.ws = new WebSocket(URL_);
  g.ready = new Promise((resolve, reject) => {
    g.ws.addEventListener('open', () => {
      g.ws.send(JSON.stringify({ t: 'hello', name, classId }));
    });
    g.ws.addEventListener('error', () => reject(new Error(`${name} could not connect to ${URL_}`)));
    g.ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      g.seen.push(m.t);
      if (m.t === 'welcome') { g.id = m.id; g.host = !!m.host; g.welcome = m; resolve(g); }
      if (m.t === 'join') g.joined = m;
      if (m.t === 'leave') g.left = m;
      if (m.t === 'host') g.hostMsg = m;
      if (m.t === 'chat') g.chats.push(m);
      if (m.t === 'states') g.states.push(m.p);
      if (m.t === 'esnap') g.snap = m.e;
    });
  });
  g.send = o => g.ws.send(JSON.stringify(o));
  return g;
}

try {
  const a = guardian('Tyler', 'warden');
  await a.ready;
  check('first guardian joins', a.id != null, `id ${a.id}`);
  check('first guardian is the shard host', a.host === true);

  const b = guardian('Friend', 'phantom');
  await b.ready;
  check('second guardian joins the same shard', b.id != null && b.id !== a.id, `id ${b.id}`);
  check('second guardian is not the host', b.host === false);
  check('joiner is told who is already here', (b.welcome.players || []).some(p => p.name === 'Tyler'),
    JSON.stringify(b.welcome.players || []));

  await sleep(250);
  check('host is told someone joined', a.joined && a.joined.name === 'Friend', a.joined ? a.joined.name : 'no join message');

  // Move, and make sure the other player is told about it.
  a.send({ t: 'state', x: 12.5, y: 3, z: -8, yaw: 1.2, h: 0.8, s: 0 });
  b.send({ t: 'state', x: -4, y: 3, z: 20, yaw: 0, h: 1, s: 0 });
  await sleep(350);
  const lastB = b.states[b.states.length - 1] || [];
  const seesA = lastB.find(p => p.id === a.id);
  check('players see each other move', !!seesA && Math.abs(seesA.x - 12.5) < 0.01,
    seesA ? `x=${seesA.x} z=${seesA.z}` : 'no state for the other guardian');

  a.send({ t: 'chat', text: 'raid tonight' });
  await sleep(250);
  check('chat reaches the fireteam', b.chats.some(c => c.text === 'raid tonight' && c.name === 'Tyler'),
    JSON.stringify(b.chats));

  // Only the host's world is authoritative: a client's enemy snapshot must not
  // be relayed, or two players would fight different worlds.
  b.send({ t: 'esnap', e: [[999, 'chitter', 0, 0, 0, 0, 1, 1]] });
  await sleep(250);
  check('non-host world state is ignored', !a.snap, a.snap ? 'host accepted a client snapshot' : '');

  a.send({ t: 'esnap', e: [[1, 'chitter', 5, 0, 5, 0, 1, 2]] });
  await sleep(250);
  check('host world state is relayed', !!b.snap && b.snap.length === 1, JSON.stringify(b.snap || null));

  // The host leaving must not end the shard for everyone else.
  a.ws.close();
  await sleep(400);
  check('host handover promotes the survivor', b.hostMsg && b.hostMsg.id === b.id,
    b.hostMsg ? `new host ${b.hostMsg.id}, me ${b.id}` : 'no host message');
  check('remaining player is told the host left', !!b.left, b.left ? b.left.name : 'no leave message');

  b.ws.close();
} catch (e) {
  bad.push(`FAIL  ${e.message}`);
}

console.log([...ok, ...bad].join('\n'));
console.log(`\n${ok.length} passed, ${bad.length} problems`);
process.exit(bad.length ? 1 : 0);
