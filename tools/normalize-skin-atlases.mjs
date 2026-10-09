#!/usr/bin/env node
// tools/normalize-skin-atlases.mjs — run the repo's atlas normalizer over the fusion skin models.
//
// The Paper-Yuan fusion release ships skin .atlas files that never went through the repo's fetch-assets
// normalization (tools/assets/atlas.mjs): pages may lack the `size: W,H` line (pixi-spine divides by 0
// upstream of a warning; the atlas QA test requires it) or carry one that disagrees with the real PNG.
// This runs normalizeAtlas over every atlas under public/assets/spine/op (idempotent: upstream-normalized
// files are unchanged) and reports what it touched.
//
// Usage: node tools/normalize-skin-atlases.mjs [--dry-run]

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeAtlas } from './assets/atlas.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPINE_OP = join(ROOT, 'public', 'assets', 'spine', 'op');
const DRY = process.argv.includes('--dry-run');

function pngSize(name) {
  if (!name.endsWith('.png')) return null;
  const p = join(dirname(atlasPath), name);
  if (!existsSync(p)) return null;
  const b = readFileSync(p);
  if (b.length < 24 || b.readUInt32BE(12) !== 0x49484452) return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

let atlasPath; // pngSize closes over it
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.atlas')) out.push(p);
  }
  return out;
}

let touched = 0, same = 0, missing = [];
for (atlasPath of walk(SPINE_OP)) {
  const text = readFileSync(atlasPath, 'utf8');
  const res = normalizeAtlas(text, { pageSize: pngSize });
  if (res.missingSize.length) missing.push(`${atlasPath}: ${res.missingSize.join(', ')}`);
  if (!res.changed) { same++; continue; }
  if (!DRY) writeFileSync(atlasPath, res.text, 'utf8');
  touched++;
}
console.log(`[norm-atlas] ${DRY ? '(dry run) ' : ''}rewrote ${touched}, unchanged ${same}, pages without a size source: ${missing.length}`);
for (const m of missing.slice(0, 10)) console.error(`  ${m}`);
