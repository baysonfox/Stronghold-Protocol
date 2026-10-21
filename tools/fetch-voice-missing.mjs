#!/usr/bin/env node
// tools/fetch-voice-missing.mjs — 补齐 data/assets.json 中缺失的英语、韩语和母语/方言语音素材

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ROOT = path.resolve(__dirname, '..');

const BASE_URL = 'https://raw.githubusercontent.com/ArknightsAssets/ArknightsAssets2/voice/assets/dyn/audio/sound_beta_2/';

function parseArgs(args) {
  const opts = {
    root: DEFAULT_ROOT,
    concurrency: 32,
    retries: 3,
    timeoutMs: 25000,
    dryRun: false,
    force: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--concurrency=')) opts.concurrency = parseInt(a.slice(14), 10) || 32;
    else if (a === '-c') opts.concurrency = parseInt(args[++i], 10) || 32;
    else if (a.startsWith('--root=')) opts.root = path.resolve(a.slice(7));
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--force') opts.force = true;
    else if (a.startsWith('--retries=')) opts.retries = parseInt(a.slice(10), 10) || 3;
    else if (a.startsWith('--timeout=')) opts.timeoutMs = parseInt(a.slice(10), 10) || 25000;
  }
  return opts;
}

export function planVoiceJobs(manifest, root) {
  const jobs = [];
  const assetsRoot = path.join(root, 'public', 'assets');

  function addJob(webPath, urlSubdir, relSubdir) {
    if (typeof webPath !== 'string' || !webPath) return;
    // e.g. webPath: /assets/audio/voice/en/char_102_texas/cn_019.mp3
    const prefix = `/assets/audio/voice/${relSubdir}/`;
    if (!webPath.startsWith(prefix)) return;
    const sub = webPath.slice(prefix.length); // e.g. char_102_texas/cn_019.mp3
    const diskPath = path.join(assetsRoot, 'audio', 'voice', relSubdir, sub);
    const ledgerKey = `audio/voice/${relSubdir}/${sub}`;
    const url = `${BASE_URL}${urlSubdir}/${sub}`;
    jobs.push({ webPath, diskPath, ledgerKey, url });
  }

  function walkTree(tree, urlSubdir, relSubdir) {
    if (!tree) return;
    for (const slots of Object.values(tree)) {
      if (!slots || typeof slots !== 'object') continue;
      for (const val of Object.values(slots)) {
        if (Array.isArray(val)) {
          for (const item of val) addJob(item, urlSubdir, relSubdir);
        } else {
          addJob(val, urlSubdir, relSubdir);
        }
      }
    }
  }

  walkTree(manifest.audio?.voiceEn, 'voice_en', 'en');
  walkTree(manifest.audio?.voiceKr, 'voice_kr', 'kr');
  walkTree(manifest.audio?.voiceNative, 'voice_custom', 'native');

  // Deduplicate by diskPath
  const map = new Map();
  for (const j of jobs) {
    if (!map.has(j.diskPath)) {
      map.set(j.diskPath, j);
    }
  }
  return Array.from(map.values());
}

async function downloadFileWithRetry(job, opts) {
  let lastErr = null;
  for (let attempt = 1; attempt <= opts.retries; attempt++) {
    try {
      const res = await fetch(job.url, {
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length < 64) {
        throw new Error(`Invalid audio file size: ${buffer.length} bytes`);
      }
      await fs.promises.mkdir(path.dirname(job.diskPath), { recursive: true });
      const tmpPath = `${job.diskPath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
      await fs.promises.writeFile(tmpPath, buffer);
      await fs.promises.rename(tmpPath, job.diskPath);
      return { success: true, bytes: buffer.length };
    } catch (err) {
      lastErr = err;
      if (attempt < opts.retries) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
  }
  return { success: false, error: lastErr?.message || 'unknown error' };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifestPath = path.join(opts.root, 'data', 'assets.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(`[voice-dl] manifest not found at ${manifestPath}`);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const allJobs = planVoiceJobs(manifest, opts.root);
  console.log(`[voice-dl] 全量计划语音任务: ${allJobs.length} 个文件`);

  const pendingJobs = [];
  for (const job of allJobs) {
    if (!opts.force && fs.existsSync(job.diskPath)) {
      try {
        const st = fs.statSync(job.diskPath);
        if (st.size > 64) continue;
      } catch {
        // file unreadable, re-download
      }
    }
    pendingJobs.push(job);
  }

  console.log(`[voice-dl] 已存在: ${allJobs.length - pendingJobs.length} 个，待下载: ${pendingJobs.length} 个 (并发度: ${opts.concurrency})`);

  if (opts.dryRun || pendingJobs.length === 0) {
    console.log('[voice-dl] 任务完成 (dry-run 或无需下载)');
    return;
  }

  const startTime = Date.now();
  let completed = 0;
  let totalBytes = 0;
  let failed = 0;
  const failedJobs = [];
  const ledgerUpdates = {};

  // Worker pool execution
  let cursor = 0;
  async function worker() {
    while (cursor < pendingJobs.length) {
      const idx = cursor++;
      const job = pendingJobs[idx];
      const result = await downloadFileWithRetry(job, opts);
      if (result.success) {
        completed++;
        totalBytes += result.bytes;
        ledgerUpdates[job.ledgerKey] = { url: job.url, bytes: result.bytes };
      } else {
        failed++;
        failedJobs.push({ job, error: result.error });
      }

      if ((completed + failed) % 100 === 0 || completed + failed === pendingJobs.length) {
        const percent = (((completed + failed) / pendingJobs.length) * 100).toFixed(1);
        const mb = (totalBytes / 1048576).toFixed(1);
        const elapsedSec = Math.max(1, (Date.now() - startTime) / 1000);
        const speed = (totalBytes / 1024 / elapsedSec).toFixed(1);
        console.log(`[voice-dl] [${completed + failed}/${pendingJobs.length}] (${percent}%) 下载量: ${mb} MB (${speed} KB/s) 失败: ${failed}`);
      }
    }
  }

  const workers = Array.from({ length: Math.min(opts.concurrency, pendingJobs.length) }, () => worker());
  await Promise.all(workers);

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[voice-dl] 下载流程结束，用时 ${durationSec} 秒。成功: ${completed}，失败: ${failed}`);

  // Merge into .cache/assets-ledger.json if exists or writable
  const cacheDir = path.join(opts.root, '.cache');
  const ledgerPath = path.join(cacheDir, 'assets-ledger.json');
  try {
    let ledger = { files: {} };
    if (fs.existsSync(ledgerPath)) {
      ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      if (!ledger.files) ledger.files = {};
    }
    Object.assign(ledger.files, ledgerUpdates);
    const tmpLedger = `${ledgerPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpLedger, JSON.stringify(ledger, null, 2));
    fs.renameSync(tmpLedger, ledgerPath);
    console.log(`[voice-dl] 已同步更新账本: ${ledgerPath} (+${Object.keys(ledgerUpdates).length} 条)`);
  } catch (err) {
    console.warn(`[voice-dl] 更新 ledger 失败 (非致命): ${err.message}`);
  }

  if (failedJobs.length > 0) {
    console.error(`[voice-dl] 存在 ${failedJobs.length} 个下载失败的文件:`);
    for (const f of failedJobs.slice(0, 10)) {
      console.error(`  ${f.job.ledgerKey}: ${f.error}`);
    }
    if (failedJobs.length > 10) console.error(`  ...以及另外 ${failedJobs.length - 10} 个`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch((err) => {
    console.error('[voice-dl] 致命错误:', err);
    process.exit(1);
  });
}
