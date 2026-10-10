// test/lobby-maintenance.test.js — tests for the maintenance announcement mechanism,
// in-game tickers, and 10-minute cutoff blocking room creation and match start.

import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { startServer } from '../server/index.js';
import { StubMatch as Match } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';
import { ERR } from '../shared/constants.js';

function httpReq(port, path, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    let payload = null;
    const reqHeaders = { ...headers };
    if (body) {
      payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = payload.length;
    }
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: reqHeaders, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, text });
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function clientPool(getUrl) {
  const open = new Set();
  return {
    async connect(opts) {
      const c = await TestClient.connect(getUrl(), opts);
      open.add(c);
      return c;
    },
    async closeAll() {
      for (const c of open) {
        try { await c.close(); } catch {}
      }
      open.clear();
    },
  };
}

describe('maintenance announcement & cutoff', () => {
  let srv;
  let pool;

  before(async () => {
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: Match });
    pool = clientPool(() => `ws://127.0.0.1:${srv.port}/ws`);
  });

  afterEach(async () => {
    // Reset maintenance if set
    await httpReq(srv.port, '/admin/maintenance', { method: 'POST', body: { cancel: true } });
    await pool.closeAll();
  });

  after(async () => {
    await srv?.close();
  });

  test('welcome frame carries notice state', async () => {
    const c = await pool.connect();
    const w = await c.hello('Doctor');
    assert.equal(w.t, 'welcome');
    assert.ok(w.notice);
    assert.equal(w.notice.active, false);
    assert.equal(w.notice.inCutoff, false);
  });

  test('POST /admin/maintenance schedules maintenance, broadcasts notice to connected clients and reflects in /healthz', async () => {
    const c = await pool.connect();
    await c.hello('Doctor');

    // Schedule maintenance in 30 minutes
    const res = await httpReq(srv.port, '/admin/maintenance', {
      method: 'POST',
      body: { inMinutes: 30, message: '升级维护' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.maintenance.active, true);
    assert.equal(res.body.maintenance.inCutoff, false);
    assert.equal(res.body.maintenance.message, '升级维护');
    assert.ok(res.body.maintenance.remainingSec > 1700);

    // Connected client receives the notice frame
    const noticeFrame = await c.waitFor('notice', () => true, 2000);
    assert.ok(noticeFrame);
    assert.equal(noticeFrame.notice.active, true);
    assert.equal(noticeFrame.notice.message, '升级维护');

    // GET /healthz reports maintenance
    const health = await httpReq(srv.port, '/healthz');
    assert.equal(health.status, 200);
    assert.equal(health.body.maintenance.active, true);
    assert.equal(health.body.maintenance.message, '升级维护');
  });

  test('maintenance broadcast sends m.ticker to active matches', async () => {
    const c = await pool.connect();
    await c.hello('Host');
    await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
    await c.request({ t: 'room.start' });

    // Wait for match public state
    await c.waitFor('m.public', () => true, 3000);

    // Schedule maintenance in 25 minutes
    await httpReq(srv.port, '/admin/maintenance', {
      method: 'POST',
      body: { inMinutes: 25, message: '请尽快完成' },
    });

    // In-game match should receive the custom high-priority m.ticker frame
    const ticker = await c.waitFor('m.ticker', (msg) => msg.type === 'CUSTOM' && msg.priority === 100, 3000);
    assert.ok(ticker);
    assert.match(ticker.text, /\[系统维护\].*25.*请尽快完成/);
  });

  test('within 10-minute cutoff: room.create and room.start are blocked with ERR.MAINTENANCE', async () => {
    // Schedule maintenance 8 minutes from now (inside the 10-minute cutoff)
    const res = await httpReq(srv.port, '/admin/maintenance', {
      method: 'POST',
      body: { inMinutes: 8 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.maintenance.inCutoff, true);

    const c = await pool.connect();
    await c.hello('Player');

    // Attempting to create a room is rejected
    const createRes = await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
    assert.equal(createRes.t, 'error');
    assert.equal(createRes.code, ERR.MAINTENANCE);
  });

  test('before cutoff (> 10 min remaining): room.create and room.start succeed', async () => {
    // Schedule maintenance 20 minutes from now (outside cutoff)
    const res = await httpReq(srv.port, '/admin/maintenance', {
      method: 'POST',
      body: { inMinutes: 20 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.maintenance.inCutoff, false);

    const c = await pool.connect();
    await c.hello('Player');

    // Room creation succeeds
    const createRes = await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
    assert.equal(createRes.t, 'ok');

    // Starting match succeeds
    const startRes = await c.request({ t: 'room.start' });
    assert.equal(startRes.t, 'ok');
  });

  test('cancel maintenance restores room.create and sends cancellation ticker', async () => {
    // Enter cutoff
    await httpReq(srv.port, '/admin/maintenance', { method: 'POST', body: { inMinutes: 5 } });

    const c = await pool.connect();
    await c.hello('Player');
    const blocked = await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
    assert.equal(blocked.code, ERR.MAINTENANCE);

    // Cancel maintenance
    const cancelRes = await httpReq(srv.port, '/admin/maintenance', { method: 'POST', body: { cancel: true } });
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.body.maintenance.active, false);

    // Notice update received by client
    const noticeFrame = await c.waitFor('notice', (msg) => msg.notice.active === false, 2000);
    assert.ok(noticeFrame);

    // Room creation is now allowed again
    const createRes = await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
    assert.equal(createRes.t, 'ok');
  });

  test('ADMIN_TOKEN authentication restricts unauthorized requests', async () => {
    process.env.ADMIN_TOKEN = 'secret-test-token-12345';
    try {
      // Unauthorized request (no token)
      const unauth = await httpReq(srv.port, '/admin/maintenance', {
        method: 'POST',
        body: { inMinutes: 30 },
      });
      assert.equal(unauth.status, 401);

      // Authorized request with Bearer token
      const auth = await httpReq(srv.port, '/admin/maintenance', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer secret-test-token-12345' },
        body: { inMinutes: 30 },
      });
      assert.equal(auth.status, 200);
      assert.equal(auth.body.maintenance.active, true);
    } finally {
      delete process.env.ADMIN_TOKEN;
    }
  });

  test('tools/maintenance.mjs CLI can schedule and query maintenance', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);

    // Schedule maintenance using CLI
    const { stdout: setOut } = await exec(process.execPath, [
      'tools/maintenance.mjs',
      '--port', String(srv.port),
      '--in', '20',
      '--msg', 'CLI维护测试',
    ]);
    assert.match(setOut, /维护计划生效中/);
    assert.match(setOut, /CLI维护测试/);

    // Query status using CLI
    const { stdout: statusOut } = await exec(process.execPath, [
      'tools/maintenance.mjs',
      '--port', String(srv.port),
      '--status',
    ]);
    assert.match(statusOut, /维护计划生效中/);

    // Cancel using CLI
    const { stdout: cancelOut } = await exec(process.execPath, [
      'tools/maintenance.mjs',
      '--port', String(srv.port),
      '--cancel',
    ]);
    assert.match(cancelOut, /当前未计划停服维护/);
  });
});
