// test/lobby-skins.test.js — room.skins end to end over WebSocket (干员皮肤, docs/SKINS.md): a plain
// { [baseChessId]: skinId } map (skin ids carry @ and # — isSkinId, not isId), stored on the session (follows
// the player into rooms, survives a resume) and on the seat, handed to a running match through Match.setSkins
// (a stub records the call), seats[].skins at the match start (bots: none), and the pick is PUBLIC: nothing
// validates a skinId against the manifest here — a skin the data does not know simply never matches a piece.
import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';
import { ERR } from '../shared/constants.js';

const SKADI = 'char_263_skadi';
const MARTHE = 'char_263_skadi@marthe#5'; // the @ / # a chess id may not carry (shared/protocol.js isSkinId)

class RecordingStub extends StubMatch {
  static instances = [];
  static skinCalls = [];
  constructor(opts) { super(opts); this.opts = opts; RecordingStub.instances.push(this); }
  setSkins(playerId, skins) { RecordingStub.skinCalls.push([playerId, skins]); return { ok: true }; }
}

function clientPool(getUrl) {
  const open = new Set();
  return {
    async player(name, token) {
      const c = await TestClient.connect(getUrl());
      open.add(c);
      const w = await c.hello(name, token);
      c.id = w.playerId;
      c.token = w.token;
      c.welcome = w;
      return c;
    },
    async closeAll() {
      await Promise.all([...open].map((c) => c.terminate().catch(() => {})));
      open.clear();
    },
  };
}
const quietLog = () => {
  const errors = [];
  return { errors, log: { info() {}, warn() {}, debug() {}, error: (...a) => errors.push(a.map(String).join(' ')) } };
};
const ok = async (c, msg) => { const r = await c.request(msg); assert.equal(r.t, 'ok', `${msg.t}: ${JSON.stringify(r)}`); return r; };
const err = async (c, msg, code) => { const r = await c.request(msg); assert.equal(r.t, 'error', JSON.stringify(r)); assert.equal(r.code, code, JSON.stringify(r)); return r; };
async function createRoom(c, mode = 'coop', difficulty = 'NORMAL') {
  await ok(c, { t: 'room.create', mode, difficulty });
  return c.waitFor('room.state', (s) => s.hostId === c.id && s.mode === mode);
}

describe('room.skins (lobby, stub match)', () => {
  let srv;
  let pool;
  const cap = quietLog();
  before(async () => {
    srv = await startServer({ port: 0, host: '127.0.0.1', log: cap.log, MatchClass: RecordingStub, heavyBurst: 12, heavyPerSec: 4 });
    pool = clientPool(() => `ws://127.0.0.1:${srv.port}/ws`);
  });
  afterEach(async () => { RecordingStub.instances = []; RecordingStub.skinCalls = []; await pool.closeAll(); });
  after(async () => { await srv?.close(); });

  test('skin ids carry @ and # (not isId): accepted, stored per session, follow into a room; malformed maps are BAD_MSG', async () => {
    const c = await pool.player('Skins');
    await err(c, { t: 'room.skins', skins: [MARTHE] }, ERR.BAD_MSG); // an array, not a map
    await err(c, { t: 'room.skins', skins: { [SKADI]: 5 } }, ERR.BAD_MSG); // a number
    await err(c, { t: 'room.skins', skins: { [`x`.repeat(65)]: MARTHE } }, ERR.BAD_MSG); // a too-long key (isId)
    await err(c, { t: 'room.skins', skins: { [SKADI]: 'no spaces allowed' } }, ERR.BAD_MSG); // a space in the id
    await ok(c, { t: 'room.skins', skins: { [SKADI]: MARTHE } });
    await createRoom(c);
    await c.request({ t: 'room.start' });
    const inst = RecordingStub.instances.at(-1);
    assert.ok(inst, 'the match started');
    assert.deepEqual(inst.opts.seats[0].skins, { [SKADI]: MARTHE }, 'seats[].skins at the start');
  });

  test('a running match takes a change through setSkins (no phase gate: a skin is cosmetic)', async () => {
    const host = await pool.player('Host');
    await createRoom(host);
    await host.request({ t: 'room.start' });
    const inst = RecordingStub.instances.at(-1);
    assert.ok(inst);
    await ok(host, { t: 'room.skins', skins: { [SKADI]: MARTHE } });
    const call = RecordingStub.skinCalls.at(-1);
    assert.ok(call, 'Match.setSkins was called');
    assert.equal(call[0], host.id);
    assert.deepEqual(call[1], { [SKADI]: MARTHE });
  });

  test('bots and an unknown chess: the freeze keeps known chess ids and char_* keys, drops the rest', async () => {
    const host = await pool.player('Host2');
    await ok(host, { t: 'room.skins', skins: { zzz_nope: 'whatever@x#1', [SKADI]: MARTHE } });
    await createRoom(host, 'coop');
    await ok(host, { t: 'room.addBot' });
    await host.request({ t: 'room.start' });
    const inst = RecordingStub.instances.at(-1);
    const human = inst.opts.seats.find((s) => !s.isBot);
    assert.ok(human, 'the host has a seat');
    // zzz_nope is not a chess the data knows and not a char_* key: dropped by the freeze
    assert.deepEqual(human.skins, { [SKADI]: MARTHE });
    const bot = inst.opts.seats.find((s) => s.isBot);
    assert.ok(bot, 'a coop room fills its empty seats with bots');
    assert.equal(bot.skins, null, 'a bot wears the default model');
  });
});
