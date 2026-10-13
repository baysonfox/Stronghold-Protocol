#!/usr/bin/env node
// tools/deploy-bluegreen.mjs — Zero-downtime blue-green deployment for Stronghold Protocol.
//
// Operates either locally on the server or remotely from a development machine via SSH.
//
// HOW IT WORKS:
// 1. Inspects Caddyfile to find the currently active upstream (3010: Blue, 3011: Green).
// 2. Selects the idle slot (Target) as the deployment destination.
// 3. (Optional with --sync) Syncs code and assets from the local repository to the server.
// 4. Builds the target Docker service (docker compose build stronghold-<color>).
// 5. Boots the target container (docker compose up -d --force-recreate stronghold-<color>).
// 6. Probes target /healthz until healthy.
//    SAFETY GATE: If target fails to start, deployment stops. Caddy is never modified.
// 7. Atomically updates Caddyfile upstream and triggers `caddy reload`.
//    Caddy immediately routes new connections to target while preserving existing
//    WebSocket connections to the old container (ongoing matches).
// 8. Draining phase:
//    Monitors old container's /healthz. The frontend buildGuard naturally reloads
//    players into the target container once their matches end.
//    When old container's sockets reach 0 (or timeout expires), stops old container.

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { execSync, spawn } from 'node:child_process';
import path from 'node:path';

const DEFAULTS = {
  domain: 'stronghold-protocol.priestess.icu',
  bluePort: 3010,
  greenPort: 3011,
  caddyfile: '/root/zoot-welfare/caddy/Caddyfile',
  caddyContainer: 'zoot-caddy',
  dir: '/root/Stronghold-Protocol',
  timeoutMin: 45,
  adminToken: process.env.ADMIN_TOKEN || 'sp-admin-priestess-2026',
  streamCloseDelay: '75m',
};

function parseArgs(args) {
  const opts = { ...DEFAULTS, mode: 'deploy', sync: false, wait: true, remote: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--status' || a === '-s') opts.mode = 'status';
    else if (a === '--matches' || a === '-m') opts.mode = 'matches';
    else if (a === '--rollback' || a === '-r') opts.mode = 'rollback';
    else if (a === '--remote') opts.remote = args[++i];
    else if (a === '--sync') opts.sync = true;
    else if (a === '--dir') opts.dir = args[++i];
    else if (a === '--caddyfile') opts.caddyfile = args[++i];
    else if (a === '--caddy-container') opts.caddyContainer = args[++i];
    else if (a === '--domain') opts.domain = args[++i];
    else if (a === '--blue-port') opts.bluePort = Number(args[++i]);
    else if (a === '--green-port') opts.greenPort = Number(args[++i]);
    else if (a === '--timeout') opts.timeoutMin = Number(args[++i]);
    else if (a === '--stream-close-delay') opts.streamCloseDelay = args[++i];
    else if (a === '--no-wait') opts.wait = false;
    else if (a === '--help' || a === '-h') {
      console.log(`用法: node tools/deploy-bluegreen.mjs [options]

  部署模式:
    --remote <user@host>       通过 SSH 远程执行 (如: root@origin.priestess.icu)
    --sync                     部署前自动通过 rsync 将本地代码和素材同步到远端
    --no-wait                  切换 Caddy 后立即返回，不阻塞等待旧容器排空
    --timeout <分钟>           旧容器排空最大等待时间 (默认: ${DEFAULTS.timeoutMin} 分钟)
    --stream-close-delay <dur> Caddy WebSocket 优雅排空延迟 (默认: ${DEFAULTS.streamCloseDelay})

  运维查询与回滚:
    --status, -s               查看当前蓝绿实例状态与 Caddy 路由
    --matches, -m              查看全服实时战况明细 (房间/难度/回合/阶段/玩家)
    --rollback, -r             快速回滚：将 Caddy 路由瞬间切回另一个颜色

  自定义配置:
    --dir <path>               项目工作目录 (默认: ${DEFAULTS.dir})
    --caddyfile <path>         Caddyfile 路径 (默认: ${DEFAULTS.caddyfile})
    --caddy-container <name>   Caddy 容器名称 (默认: ${DEFAULTS.caddyContainer})
    --domain <domain>          游戏域名 (默认: ${DEFAULTS.domain})
    --blue-port <port>         蓝色实例端口 (默认: ${DEFAULTS.bluePort})
    --green-port <port>        绿色实例端口 (默认: ${DEFAULTS.greenPort})
`);
      process.exit(0);
    }
  }
  return opts;
}

function runCmd(cmd, { cwd, quiet = false } = {}) {
  try {
    return execSync(cmd, { cwd, stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8' });
  } catch (err) {
    if (!quiet) console.error(`[cmd failed] ${cmd}:`, err.message);
    throw err;
  }
}

function runCmdOut(cmd, { cwd } = {}) {
  try {
    return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
  } catch (_err) {
    return '';
  }
}

function fetchJson(url, { headers = {}, timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const isHttps = url.startsWith('https://');
    const mod = isHttps ? https : http;
    const req = mod.get(url, { headers, rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: null });
        }
      });
    });
    req.on('error', () => resolve({ status: 0, body: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: null }); });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nowStr() {
  const d = new Date();
  return d.toTimeString().split(' ')[0];
}

function formatDurCompact(sec) {
  if (sec == null || !Number.isFinite(sec)) return '';
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem > 0 ? `${m}m${rem}s` : `${m}m`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

function formatDurCn(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}小时${String(m).padStart(2, '0')}分`;
  }
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}分${String(rem).padStart(2, '0')}秒`;
}

// ---------------------------------------------------------------------------------------------------
// Remote SSH & Rsync Orchestration (when --remote is supplied)
// ---------------------------------------------------------------------------------------------------

async function runRemote(opts) {
  const host = opts.remote;
  console.log(`[${nowStr()}] 🌐 正在连接远端服务器: ${host}...`);

  if (opts.sync) {
    console.log(`[${nowStr()}] 📦 正在增量同步本地资源与代码到 ${host}:${opts.dir}...`);
    // 1. Sync assets
    const localAssets = path.resolve('public/assets');
    if (fs.existsSync(localAssets)) {
      console.log(`  -> 同步 public/assets/...`);
      runCmd(`rsync -avz --progress "${localAssets}/" "${host}:${opts.dir}/public/assets/"`);
    }
    // 2. Sync code files
    console.log(`  -> 同步核心代码与配置...`);
    const excludes = [
      '--exclude=.git',
      '--exclude=.worktrees',
      '--exclude=node_modules',
      '--exclude=.cache',
      '--exclude=public/assets',
    ].join(' ');
    runCmd(`rsync -avz ${excludes} ./ "${host}:${opts.dir}/"`);
  }

  // Construct command to execute remotely
  const forwardedFlags = [];
  if (opts.mode === 'status') forwardedFlags.push('--status');
  if (opts.mode === 'matches') forwardedFlags.push('--matches');
  if (opts.mode === 'rollback') forwardedFlags.push('--rollback');
  if (!opts.wait) forwardedFlags.push('--no-wait');
  if (opts.timeoutMin !== DEFAULTS.timeoutMin) forwardedFlags.push(`--timeout ${opts.timeoutMin}`);
  if (opts.dir !== DEFAULTS.dir) forwardedFlags.push(`--dir "${opts.dir}"`);
  if (opts.caddyfile !== DEFAULTS.caddyfile) forwardedFlags.push(`--caddyfile "${opts.caddyfile}"`);
  if (opts.caddyContainer !== DEFAULTS.caddyContainer) forwardedFlags.push(`--caddy-container "${opts.caddyContainer}"`);
  if (opts.domain !== DEFAULTS.domain) forwardedFlags.push(`--domain "${opts.domain}"`);
  if (opts.streamCloseDelay !== DEFAULTS.streamCloseDelay) forwardedFlags.push(`--stream-close-delay "${opts.streamCloseDelay}"`);

  const remoteCmd = `cd "${opts.dir}" && node tools/deploy-bluegreen.mjs ${forwardedFlags.join(' ')}`;
  console.log(`[${nowStr()}] 🚀 在远端执行: ${remoteCmd}\n`);

  const child = spawn('ssh', ['-o', 'ConnectTimeout=10', host, remoteCmd], { stdio: 'inherit' });
  child.on('close', (code) => {
    process.exit(code ?? 0);
  });
}

// ---------------------------------------------------------------------------------------------------
// Local Execution (Runs directly on the host)
// ---------------------------------------------------------------------------------------------------

function updateCaddyConfig(caddyContent, { domain, fromPort, toPort, streamCloseDelay = '75m' }) {
  const domainIdx = caddyContent.indexOf(domain);
  const searchStart = domainIdx !== -1 ? domainIdx : 0;
  const prefix = caddyContent.slice(0, searchStart);
  const targetSlice = caddyContent.slice(searchStart);

  // 匹配带 { ... } 块的 reverse_proxy
  const blockRegex = new RegExp(
    `(reverse_proxy\\s+(?:127\\.0\\.0\\.1|localhost):)${fromPort}(\\s*\\{[^}]*\\})`,
    'm'
  );

  // 匹配单行 reverse_proxy
  const singleLineRegex = new RegExp(
    `(reverse_proxy\\s+(?:127\\.0\\.0\\.1|localhost):)${fromPort}`,
    'm'
  );

  let newSlice;
  if (blockRegex.test(targetSlice)) {
    newSlice = targetSlice.replace(blockRegex, (_match, p1) => {
      return `${p1}${toPort} {\n\t\tstream_close_delay ${streamCloseDelay}\n\t}`;
    });
  } else if (singleLineRegex.test(targetSlice)) {
    newSlice = targetSlice.replace(singleLineRegex, (_match, p1) => {
      return `${p1}${toPort} {\n\t\tstream_close_delay ${streamCloseDelay}\n\t}`;
    });
  } else {
    newSlice = targetSlice.replace(
      new RegExp(`(reverse_proxy\\s+(?:127\\.0\\.0\\.1|localhost):)${fromPort}`),
      `$1${toPort}`
    );
  }

  return prefix + newSlice;
}

function detectActivePort(opts) {
  if (!fs.existsSync(opts.caddyfile)) {
    throw new Error(`找不到 Caddyfile: ${opts.caddyfile}`);
  }
  const content = fs.readFileSync(opts.caddyfile, 'utf8');
  // Match domain block or reverse_proxy
  const domainIdx = content.indexOf(opts.domain);
  const searchSlice = domainIdx !== -1 ? content.slice(domainIdx, domainIdx + 800) : content;
  const m = searchSlice.match(/reverse_proxy\s+(?:127\.0\.0\.1|localhost):(\d+)/);
  if (!m) {
    throw new Error(`在 ${opts.caddyfile} 中未找到 ${opts.domain} 的 reverse_proxy 配置`);
  }
  const port = Number(m[1]);
  const color = port === opts.bluePort ? 'blue' : (port === opts.greenPort ? 'green' : 'unknown');
  return { port, color, content };
}

async function showStatus(opts) {
  console.log(`=== 蓝绿部署状态监控 (${opts.domain}) ===\n`);
  try {
    const { port, color } = detectActivePort(opts);
    console.log(`  Caddy 当前路由 upstream: 127.0.0.1:${port} (活跃状态: ${color.toUpperCase()})`);
  } catch (e) {
    console.log(`  Caddy 路由状态: 读取失败 (${e.message})`);
  }

  console.log('\n  实例运行状态:');
  const inspectInstance = async (name, port) => {
    const res = await fetchJson(`http://127.0.0.1:${port}/healthz`, { timeoutMs: 1500 });
    const ps = runCmdOut(`docker ps --filter "publish=${port}" --format "{{.Names}} ({{.Status}})"`);
    if (res.status === 200 && res.body?.ok) {
      const b = res.body;
      const activeM = b.activeMatches ?? b.matches;
      const suspM = b.suspendedMatches ?? 0;
      const hConn = b.humansConnected ?? b.humans;
      const hDisc = b.humansDisconnected ?? 0;
      const matchInfo = suspM > 0 ? `${activeM} 活跃 (+${suspM} 离线挂起)` : `${activeM}`;
      const humanInfo = hDisc > 0 ? `${hConn} 在线 (+${hDisc} 断线保留)` : `${hConn}`;
      console.log(`   * ${name.toUpperCase()} (:${port}) — ${ps || 'running'}`);
      console.log(`     版本: v${b.app} (build: ${b.build}), 在线长连接: ${b.sockets}, 房间: ${b.rooms}, 对局: ${matchInfo}, 玩家: ${humanInfo}`);
    } else {
      console.log(`   * ${name.toUpperCase()} (:${port}) — ${ps || '未运行 / 无响应'}`);
    }
  };

  await inspectInstance('blue', opts.bluePort);
  await inspectInstance('green', opts.greenPort);

  const publicHealth = await fetchJson(`https://${opts.domain}/healthz`, { timeoutMs: 2500 });
  if (publicHealth.status === 200 && publicHealth.body?.ok) {
    console.log(`\n  公网域名测试 (https://${opts.domain}/healthz): ✅ 响应正常 (build: ${publicHealth.body.build})`);
  } else {
    console.log(`\n  公网域名测试: ⚠️ 无法访问或返回非 200`);
  }
  console.log('');
}

async function doRollback(opts) {
  const { port, color, content } = detectActivePort(opts);
  const targetPort = color === 'blue' ? opts.greenPort : opts.bluePort;
  const targetColor = color === 'blue' ? 'green' : 'blue';

  console.log(`[${nowStr()}] 🔄 正在执行快速回滚: ${color.toUpperCase()} (:${port}) -> ${targetColor.toUpperCase()} (:${targetPort})...`);
  const probe = await fetchJson(`http://127.0.0.1:${targetPort}/healthz`);
  if (probe.status !== 200 || !probe.body?.ok) {
    console.error(`❌ 回滚目标 (:${targetPort}) 目前未在运行或健康检查失败，无法安全切回！`);
    process.exit(1);
  }

  // Swap port in Caddyfile
  const newContent = updateCaddyConfig(content, {
    domain: opts.domain,
    fromPort: port,
    toPort: targetPort,
    streamCloseDelay: opts.streamCloseDelay,
  });
  fs.writeFileSync(opts.caddyfile, newContent, 'utf8');
  runCmd(`docker exec ${opts.caddyContainer} caddy reload -c /etc/caddy/Caddyfile`);
  console.log(`[${nowStr()}] ✅ 回滚完成！Caddy 已切回 ${targetColor.toUpperCase()} (:${targetPort})`);
}

async function doDeploy(opts) {
  const { port: currentPort, color: currentColor, content: caddyContent } = detectActivePort(opts);
  const targetColor = currentColor === 'blue' ? 'green' : 'blue';
  const targetPort = targetColor === 'blue' ? opts.bluePort : opts.greenPort;
  const targetService = `stronghold-${targetColor}`;

  console.log(`=======================================================`);
  console.log(`[${nowStr()}] 🚀 启动蓝绿无缝部署`);
  console.log(`  当前线上活跃: ${currentColor.toUpperCase()} (端口 ${currentPort})`);
  console.log(`  本次部署目标: ${targetColor.toUpperCase()} (端口 ${targetPort})`);
  console.log(`=======================================================\n`);

  // Step 1: Build target container image
  console.log(`[${nowStr()}] 🛠️  步骤 1/4: 构建目标镜像 (${targetService})...`);
  runCmd(`docker compose build ${targetService}`, { cwd: opts.dir });

  // Step 2: Start target container
  console.log(`\n[${nowStr()}] 🚀 步骤 2/4: 启动目标容器 (${targetService} on :${targetPort})...`);
  runCmd(`docker compose up -d --force-recreate ${targetService}`, { cwd: opts.dir });

  // Safety Gate: Probe target container health
  console.log(`[${nowStr()}] 🩺 正在健康探测 http://127.0.0.1:${targetPort}/healthz...`);
  let healthy = false;
  let targetBuild = null;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const res = await fetchJson(`http://127.0.0.1:${targetPort}/healthz`);
    if (res.status === 200 && res.body?.ok) {
      healthy = true;
      targetBuild = res.body.build;
      console.log(`  -> 目标容器就绪！v${res.body.app} (build: ${targetBuild})`);
      break;
    }
  }

  if (!healthy) {
    console.error(`\n❌ 安全防线触发: 目标容器启动失败或 /healthz 探测超时！`);
    console.error(`  Caddy 未做任何变更，生产环境当前 ${currentColor.toUpperCase()} (:${currentPort}) 毫发无损。`);
    console.error(`  正在回滚并停止目标失败容器...`);
    runCmd(`docker compose stop ${targetService}`, { cwd: opts.dir, quiet: true });
    process.exit(1);
  }

  // Step 3: Switch Caddy upstream
  console.log(`\n[${nowStr()}] 🔀 步骤 3/4: 切换 Caddy 流量至 ${targetColor.toUpperCase()} (:${targetPort})...`);
  // Backup Caddyfile
  fs.copyFileSync(opts.caddyfile, `${opts.caddyfile}.bak`);
  const updatedCaddy = updateCaddyConfig(caddyContent, {
    domain: opts.domain,
    fromPort: currentPort,
    toPort: targetPort,
    streamCloseDelay: opts.streamCloseDelay,
  });
  fs.writeFileSync(opts.caddyfile, updatedCaddy, 'utf8');

  try {
    runCmd(`docker exec ${opts.caddyContainer} caddy reload -c /etc/caddy/Caddyfile`);
  } catch (_err) {
    console.error(`❌ Caddy 重载失败，正在恢复原配置文件...`);
    fs.copyFileSync(`${opts.caddyfile}.bak`, opts.caddyfile);
    runCmd(`docker exec ${opts.caddyContainer} caddy reload -c /etc/caddy/Caddyfile`);
    process.exit(1);
  }

  console.log(`  -> Caddy 热重载成功！所有新请求与新房间已接入 ${targetColor.toUpperCase()}。`);
  console.log(`  -> 已有 WebSocket 连接将继续由旧实例 (${currentColor.toUpperCase()}) 托管，直到对局结算。`);

  // Step 4: Drain monitoring
  if (!opts.wait) {
    console.log(`\n[${nowStr()}] ⏩ 用户指定了 --no-wait，跳过排空等待。旧实例 (:${currentPort}) 保持运行。`);
    process.exit(0);
  }

  console.log(`\n[${nowStr()}] ⏳ 步骤 4/4: 等待旧实例 (${currentColor.toUpperCase()}) 排空...`);
  const deadline = Date.now() + opts.timeoutMin * 60 * 1000;

  while (Date.now() < deadline) {
    await sleep(10000);
    const oldRes = await fetchJson(`http://127.0.0.1:${currentPort}/healthz`);
    if (oldRes.status !== 200 || !oldRes.body) {
      console.log(`[${nowStr()}] 旧实例已离线或无响应，判定排空完成。`);
      break;
    }
    const b = oldRes.body;
    const activeMatches = b.activeMatches ?? b.matches;
    const suspendedMatches = b.suspendedMatches ?? 0;
    const humansConnected = b.humansConnected ?? b.humans;
    const remMins = Math.round((deadline - Date.now()) / 60000);
    console.log(
      `[${nowStr()}] 旧实例排空中: sockets=${b.sockets}, activeMatches=${activeMatches}, suspendedMatches=${suspendedMatches}, humansConnected=${humansConnected} (超时剩余: ${remMins}m)`
    );

    if (activeMatches === 0 && b.sockets === 0) {
      const suspNote = suspendedMatches > 0 ? ` (已忽略 ${suspendedMatches} 局全员断线的离线挂起对局)` : '';
      console.log(`\n🎯 [${nowStr()}] 旧实例已完全排空 (activeMatches === 0 且 sockets === 0)${suspNote}！`);
      break;
    }
  }

  if (Date.now() >= deadline) {
    console.log(`\n⚠️ [${nowStr()}] 到达排空超时门槛 (${opts.timeoutMin} 分钟)，准备停止旧实例。`);
  }

  // Stop old container
  console.log(`[${nowStr()}] 🛑 停止旧容器释放资源...`);
  // Handle both stronghold (legacy) and stronghold-<color>
  runCmd(`docker stop stronghold-${currentColor} stronghold 2>/dev/null || true`, { quiet: true });

  console.log(`\n=======================================================`);
  console.log(`[${nowStr()}] 🎉 蓝绿部署圆满完成！`);
  console.log(`  当前提供服务的版本: ${targetColor.toUpperCase()} (端口 ${targetPort})`);
  console.log(`  代码指纹 (build tag): ${targetBuild}`);
  console.log(`=======================================================\n`);
}

async function showMatches(opts) {
  let activePort;
  let activeColor = 'blue';
  try {
    const { port, color } = detectActivePort(opts);
    activePort = port;
    activeColor = color;
  } catch (_e) {
    activePort = opts.bluePort;
  }

  const res = await fetchJson(`http://127.0.0.1:${activePort}/admin/matches`, {
    headers: { Authorization: `Bearer ${opts.adminToken}` },
    timeoutMs: 3000,
  });
  if (res.status !== 200 || !res.body?.ok) {
    console.error(`❌ 获取战况失败: http://127.0.0.1:${activePort}/admin/matches 返回 ${res.status}`);
    process.exit(1);
  }

  const data = res.body;
  const bd = data.breakdown || {};
  const rooms = data.rooms || [];
  const inMatchRooms = rooms.filter((r) => r.status === 'IN_MATCH');
  const activeMatchRooms = inMatchRooms.filter((r) => !r.suspended);
  const suspendedMatchRooms = inMatchRooms.filter((r) => r.suspended);
  const waitingRooms = rooms.filter((r) => r.status === 'WAITING');
  const hConn = data.humansConnected ?? data.humans ?? 0;
  const hDisc = data.humansDisconnected ?? 0;

  console.log(`================================================================================`);
  console.log(`🎮 全服实时战况监控 [${activeColor.toUpperCase()}:${activePort}] (${new Date().toLocaleTimeString()})`);
  console.log(`  房间总数: ${rooms.length} 个 | 活跃对局: ${activeMatchRooms.length} 局 | 离线挂起: ${suspendedMatchRooms.length} 局 | 组队等待: ${waitingRooms.length} 间`);
  console.log(`  在线长连接: ${data.sockets ?? '-'} Sockets | 在线真人: ${hConn} 人 (断线保留: ${hDisc} 人) | AI: ${data.bots ?? 0} 人 | 观战: ${data.spectators ?? 0} 人`);
  console.log(`================================================================================\n`);

  if (bd.byMode || bd.byDifficulty || bd.byPhase) {
    console.log(`📊 宏观分布汇总:`);
    if (bd.byMode) {
      const coopSusp = suspendedMatchRooms.filter((r) => r.mode === 'coop').length;
      const soloSusp = suspendedMatchRooms.filter((r) => r.mode === 'solo').length;
      const coopDetail = coopSusp > 0 ? ` (含离线挂起 ${coopSusp} 间)` : '';
      const soloDetail = soloSusp > 0 ? ` (含离线挂起 ${soloSusp} 间)` : '';
      console.log(`  • 模式分布: 多人联防 (coop) ${bd.byMode.coop || 0} 间${coopDetail}, 独立模拟 (solo) ${bd.byMode.solo || 0} 间${soloDetail}`);
    }
    if (bd.byDifficulty) {
      const diffStr = Object.entries(bd.byDifficulty).map(([k, v]) => `${k}: ${v}`).join(', ');
      console.log(`  • 难度分布: ${diffStr}`);
    }
    if (bd.byPhase) {
      const phaseStr = Object.entries(bd.byPhase).filter(([_, v]) => v > 0).map(([k, v]) => `${k}: ${v}`).join(', ');
      console.log(`  • 阶段分布: ${phaseStr}`);
    }
    console.log('');
  }

  const formatSeat = (s, { showResumeLeft = false } = {}) => {
    const botTag = s.isBot ? ' [AI]' : '';
    let connTag = '';
    if (!s.isBot) {
      if (s.left) {
        connTag = ' [已退出]';
      } else if (!s.connected) {
        const dur = formatDurCompact(s.disconnectedSec);
        const left = showResumeLeft && s.resumeLeftSec != null ? `, 剩${formatDurCompact(s.resumeLeftSec)}` : '';
        connTag = dur ? ` [断线 ${dur}${left}]` : ' [断线]';
      }
    }
    const lpTag = s.lp != null ? ` (LP: ${s.lp})` : '';
    return `P${s.seat + 1}: ${s.name}${botTag}${connTag}${lpTag}`;
  };

  if (activeMatchRooms.length > 0) {
    console.log(`⚔️  活跃对局 (${activeMatchRooms.length} 局):`);
    activeMatchRooms.forEach((r, idx) => {
      const m = r.match;
      const durStr = formatDurCn(m.durationSec || 0);
      const pauseStr = m.paused ? ' [暂停中 ⏸]' : '';
      console.log(`  [${idx + 1}] 房间 ${r.code} · ${r.mode === 'solo' ? '独立模拟' : '多人联防'} (${r.mode} / ${r.difficulty})${pauseStr}`);
      console.log(`      战局进度: 第 ${m.round}/${m.maxRound} 回合 · ${m.phase} · 已进行 ${durStr}`);
      const seatsStr = r.seats.map((s) => formatSeat(s)).join(' | ');
      console.log(`      席位玩家 (${r.connectedHumans ?? r.humans}在线/${r.humans}真人/${r.bots}AI): ${seatsStr}`);
      console.log('');
    });
  } else {
    console.log(`⚔️  当前暂无正在实时游玩的活跃对局。\n`);
  }

  if (suspendedMatchRooms.length > 0) {
    console.log(`💤 离线挂起中的对局 (${suspendedMatchRooms.length} 局 · 全员断线等待重连):`);
    suspendedMatchRooms.forEach((r, idx) => {
      const m = r.match;
      const suspStr = r.suspendedSec != null ? `已挂起 ${formatDurCn(r.suspendedSec)}` : '全员断线';
      const durStr = formatDurCn(m.durationSec || 0);
      console.log(`  [${idx + 1}] 房间 ${r.code} · ${r.mode === 'solo' ? '独立模拟' : '多人联防'} (${r.mode} / ${r.difficulty}) [${suspStr}]`);
      console.log(`      停留进度: 第 ${m.round}/${m.maxRound} 回合 · ${m.phase} · 开局至今 ${durStr}`);
      const seatsStr = r.seats.map((s) => formatSeat(s, { showResumeLeft: true })).join(' | ');
      console.log(`      席位玩家 (${r.humans}真人/${r.bots}AI): ${seatsStr}`);
      console.log('');
    });
  }

  if (waitingRooms.length > 0) {
    console.log(`⏳ 组队等待中的房间 (${waitingRooms.length} 间):`);
    waitingRooms.forEach((r, idx) => {
      const ageMin = Math.floor((r.ageSec || 0) / 60);
      const seatsStr = r.seats.map((s) => {
        const readyTag = s.ready ? ' [已准备]' : ' [未准备]';
        const botTag = s.isBot ? ' [AI]' : '';
        const discDur = (!s.isBot && !s.connected && s.disconnectedSec != null) ? ` [断线 ${formatDurCompact(s.disconnectedSec)}]` : '';
        return `P${s.seat + 1}: ${s.name}${botTag}${readyTag}${discDur}`;
      }).join(' | ');
      console.log(`  [${idx + 1}] 房间 ${r.code} · ${r.mode} / ${r.difficulty} (已等待 ${ageMin}分钟)`);
      console.log(`      席位: ${seatsStr || '暂无玩家'}`);
    });
    console.log('');
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.remote) {
    await runRemote(opts);
    return;
  }

  if (opts.mode === 'status') {
    await showStatus(opts);
  } else if (opts.mode === 'matches') {
    await showMatches(opts);
  } else if (opts.mode === 'rollback') {
    await doRollback(opts);
  } else {
    await doDeploy(opts);
  }
}

main().catch((err) => {
  console.error('\n致命错误:', err.message);
  process.exit(1);
});
