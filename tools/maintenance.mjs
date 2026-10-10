#!/usr/bin/env node
// tools/maintenance.mjs — CLI helper to schedule, check or cancel server maintenance.
// Usage:
//   node tools/maintenance.mjs --status
//   node tools/maintenance.mjs --in 30 [--msg "自定义公告"]
//   node tools/maintenance.mjs --cancel
// Options:
//   --host <host>    Default 127.0.0.1
//   --port <port>    Default 3000 (or PORT env)
//   --token <token>  Admin token (or ADMIN_TOKEN / SP_ADMIN_KEY env)

import http from 'node:http';

const args = process.argv.slice(2);
let host = '127.0.0.1';
let port = Number(process.env.PORT) || 3000;
let token = process.env.ADMIN_TOKEN || process.env.SP_ADMIN_KEY || null;
let mode = 'status';
let inMinutes = null;
let deadline = null;
let msg = null;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--status' || a === '-s') { mode = 'status'; }
  else if (a === '--cancel' || a === '-c') { mode = 'cancel'; }
  else if (a === '--in' || a === '-m') { mode = 'set'; inMinutes = Number(args[++i]); }
  else if (a === '--at') {
    mode = 'set';
    const timeStr = args[++i];
    const [hh, mm] = timeStr.split(':').map(Number);
    const d = new Date();
    d.setHours(hh, mm, 0, 0);
    if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
    deadline = d.getTime();
  }
  else if (a === '--deadline') { mode = 'set'; deadline = Number(args[++i]); }
  else if (a === '--msg') { msg = args[++i]; }
  else if (a === '--host') { host = args[++i]; }
  else if (a === '--port') { port = Number(args[++i]); }
  else if (a === '--token') { token = args[++i]; }
  else if (a === '--help' || a === '-h') {
    console.log(`用法: node tools/maintenance.mjs [options]
  --status, -s              查看当前维护状态
  --in <分钟>, -m <分钟>     设定在 N 分钟后停服维护 (如: --in 30)
  --at <HH:MM>              设定在指定时刻停服维护 (如: --at 01:57)
  --msg <文本>              公告附加信息
  --cancel, -c              取消维护计划
  --host <host>             服务器地址 (默认 127.0.0.1)
  --port <port>             服务器端口 (默认 3000)
  --token <token>           管理员密钥 (若配置了 ADMIN_TOKEN)`);
    process.exit(0);
  }
}

function request({ path, method = 'GET', body = null }) {
  return new Promise((resolve, reject) => {
    const headers = { 'Accept': 'application/json' };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
      headers['X-Admin-Token'] = token;
    }
    let data = null;
    if (body) {
      data = Buffer.from(JSON.stringify(body));
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = data.length;
    }
    const req = http.request({ host, port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: res.statusCode, body: JSON.parse(text) });
        } catch {
          resolve({ status: res.statusCode, text });
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function run() {
  let res;
  if (mode === 'status') {
    res = await request({ path: '/admin/maintenance', method: 'GET' });
  } else if (mode === 'cancel') {
    res = await request({ path: '/admin/maintenance', method: 'POST', body: { cancel: true } });
  } else if (mode === 'set') {
    if (!deadline && (!inMinutes || Number.isNaN(inMinutes) || inMinutes <= 0)) {
      console.error('错误: 请指定有效的时间，如 --in 30 或 --at 01:57');
      process.exit(1);
    }
    const body = deadline ? { deadline, message: msg } : { inMinutes, message: msg };
    res = await request({ path: '/admin/maintenance', method: 'POST', body });
  }

  if (res.status === 401 || res.status === 403) {
    console.error(`鉴权失败 (HTTP ${res.status}): 请提供正确的 --token 或在服务器环境变量配置 ADMIN_TOKEN。`);
    process.exit(1);
  }
  if (res.status !== 200) {
    console.error(`请求失败 (HTTP ${res.status}):`, res.body || res.text);
    process.exit(1);
  }

  const st = res.body?.maintenance;
  if (!st) {
    console.log(res.body);
    return;
  }

  if (!st.active) {
    console.log('【维护状态】当前未计划停服维护 (服务器正常运行中)');
    return;
  }

  const dl = new Date(st.deadline);
  const remMin = Math.ceil(st.remainingSec / 60);
  console.log('【维护状态】维护计划生效中：');
  console.log(`  计划停服时间: ${dl.toLocaleString()} (约 ${remMin} 分钟后 / 剩余 ${st.remainingSec} 秒)`);
  console.log(`  关闭开局状态: ${st.inCutoff ? '已关闭新房间与开局 ⛔' : `尚未到达 (将在停服前 ${Math.round(st.cutoffSec / 60)} 分钟生效)`}`);
  if (st.message) console.log(`  公告附加信息: ${st.message}`);
}

run().catch((err) => {
  console.error('连接失败:', err.message);
  process.exit(1);
});
