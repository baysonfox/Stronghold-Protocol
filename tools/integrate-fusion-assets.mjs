#!/usr/bin/env node
// tools/integrate-fusion-assets.mjs — merge the Paper-Yuan fusion asset entries into the upstream manifest.
//
// The upstream build (npm run assets) stays the single authority of data/assets.json: every entry it
// carries — modules, per-unit SFX, enemy run/skills animations, token spineLocal overlays, the audio.voice /
// audio.voiceJp dub trees (0.2.3: 192 operators each, more complete than the fusion release's 120) — survives
// untouched. On top of that base this script injects, from the Paper-Yuan v0.2.1-fusion manifest
// (the release whose public/assets tree is shipped alongside it — its URLs and its files match):
//
//   1. chars[charId].skins        271 installed skins / 172 operators (front+back spine, avatar, name)
//   2. audio.sfx.units            per-unit SFX banks the upstream plan lacks (the 自选 picks)
//   3. skills / skillsById        skill icons the upstream plan lacks
//
// NOT injected: audio.voice.{jp,cn} — upstream 0.2.3's own voiceJp tree (audio.voiceJp, the voiceLang setting)
// supersedes the fusion release's bilingual restructure; the fusion files under public/assets/audio/voice/{jp,cn}/
// are a subset of what `npm run setup` downloads and simply sit alongside the upstream ones (tar -x kept them).
// Idempotent: re-running on an already-merged manifest produces the same output (entries re-copied, injections
// skipped). Entries whose files are missing on disk are reported (and skipped with --strict failing the run),
// so a manifest that claims a URL the server cannot serve is caught here, not in a player's browser.
//
// Usage: node tools/integrate-fusion-assets.mjs [--paper <path/to/paper-data-dir>] [--strict] [--dry-run]
//   --paper   the extracted fusion release `data/` directory (default: /tmp/sp-paper-data/data)

import { readFile, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'data', 'assets.json');
const ASSETS_DIR = join(ROOT, 'public', 'assets');

function parseArgs(argv) {
  const o = { paper: '/tmp/sp-paper-data/data', strict: false, dryRun: false };
  for (const a of argv) {
    const [k, v] = a.split('=');
    if (k === '--paper') o.paper = resolve(v);
    else if (k === '--strict') o.strict = true;
    else if (k === '--dry-run') o.dryRun = true;
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));

/** Collect every URL-ish string of a manifest fragment (walks arrays + nested objects). */
function collectUrls(obj, out = new Set()) {
  if (typeof obj === 'string') { if (obj.startsWith('/assets/')) out.add(obj); return out; }
  if (Array.isArray(obj)) { for (const v of obj) collectUrls(v, out); return out; }
  if (obj && typeof obj === 'object') { for (const v of Object.values(obj)) collectUrls(v, out); }
  return out;
}

async function exists(p) { try { await access(p, constants.F_OK); return true; } catch { return false; } }

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const paperPath = join(opts.paper, 'assets.json');
  if (!(await exists(paperPath))) throw new Error(`paper manifest not found: ${paperPath}`);

  const base = await readJson(MANIFEST);
  const paper = await readJson(paperPath);

  // defensive: drop a fusion-structured bilingual tree left by an earlier revision of this script (an
  // earlier merge wrote audio.voice.{jp,cn}); upstream 0.2.3's audio.voiceJp supersedes it
  if (base.audio?.voice && (base.audio.voice.jp || base.audio.voice.cn)) {
    delete base.audio.voice.jp;
    delete base.audio.voice.cn;
  }

  const report = { skins: 0, skinsChars: 0, voiceJp: 0, voiceCn: 0, sfxUnits: 0, skills: 0, skippedChars: [] };
  const injectedUrls = new Set();

  // ---- 1. chars[*].skins ----------------------------------------------------------------------------
  for (const [charId, pRec] of Object.entries(paper.chars || {})) {
    if (!pRec?.skins) continue;
    const bRec = base.chars?.[charId];
    if (!bRec) { report.skippedChars.push(charId); continue; } // paper id unknown upstream: keep the base intact
    bRec.skins = pRec.skins;
    report.skinsChars++;
    report.skins += Object.keys(pRec.skins).length;
    collectUrls(pRec.skins, injectedUrls);
  }

  // ---- 2. audio.sfx.units (paper-only ids) ------------------------------------------------------------
  const units = (base.audio.sfx = base.audio.sfx || {}).units = base.audio.sfx?.units || {};
  for (const [id, rec] of Object.entries(paper.audio?.sfx?.units || {})) {
    if (units[id]) continue; // upstream's own SFX entry wins
    units[id] = rec;
    report.sfxUnits++;
    collectUrls(rec, injectedUrls);
  }

  // ---- 4. skills / skillsById (paper-only ids) --------------------------------------------------------
  for (const [iconId, url] of Object.entries(paper.skills || {})) {
    if (base.skills?.[iconId]) continue;
    (base.skills = base.skills || {})[iconId] = url;
    report.skills++;
    injectedUrls.add(url);
  }
  for (const [skillId, iconId] of Object.entries(paper.skillsById || {})) {
    if (!base.skillsById) base.skillsById = {};
    if (!base.skillsById[skillId]) base.skillsById[skillId] = iconId;
  }

  // ---- stats ------------------------------------------------------------------------------------------
  base.stats = base.stats || {};
  base.stats.skins = report.skins;
  base.stats.charsWithSkins = report.skinsChars;
  base.stats.skills = Object.keys(base.skills || {}).length; // test/assets-diy.test.js cross-checks this
  base.generator = `${base.generator} + tools/integrate-fusion-assets.mjs (fusion ${paper.hash?.slice(0, 8) || '?'})`;

  // ---- disk verification --------------------------------------------------------------------------------
  const missing = [];
  for (const url of injectedUrls) {
    const rel = url.replace(/^\/assets\//, '');
    if (!(await exists(join(ASSETS_DIR, rel)))) missing.push(rel);
  }

  // ---- write / report -------------------------------------------------------------------------------------
  console.log(`[fusion] skins: ${report.skins} entries on ${report.skinsChars} operators` +
    (report.skippedChars.length ? ` (skipped ${report.skippedChars.length} ids unknown upstream: ${report.skippedChars.slice(0, 5).join(', ')}${report.skippedChars.length > 5 ? '…' : ''})` : ''));
  console.log(`[fusion] voice: none injected (upstream 0.2.3 voiceJp supersedes the fusion jp/cn trees)`);
  console.log(`[fusion] sfx units +${report.sfxUnits}, skills +${report.skills}`);
  console.log(`[fusion] injected urls: ${injectedUrls.size}, missing on disk: ${missing.length}`);
  for (const m of missing.slice(0, 20)) console.log(`  missing: ${m}`);
  if (missing.length > 20) console.log(`  … and ${missing.length - 20} more`);

  if (opts.strict && missing.length) { console.error('[fusion] --strict: failing, files missing'); process.exit(1); }
  if (opts.dryRun) { console.log('[fusion] dry run, manifest untouched'); return; }

  const text = JSON.stringify(base);
  await writeFile(MANIFEST, text, 'utf8');
  console.log(`[fusion] wrote ${MANIFEST} (${(text.length / 1048576).toFixed(1)} MB, sha256 ${createHash('sha256').update(text).digest('hex').slice(0, 12)})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
