#!/usr/bin/env node
// scripts/build-assets.mjs — assemble the static site into public/.
//
// Cloudflare's assets.directory used to be the repo root, which meant wrangler
// walked everything left on disk after npm install and refused the deploy over
// node_modules/workerd/bin/workerd (146 MiB against a 25 MiB per-file limit).
// A .assetsignore did not help — with the assets directory set to ".", the
// walk still picked those files up.
//
// So the assets directory is now a folder that contains only what the browser
// actually fetches. Nothing to ignore, nothing to get wrong.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'public');

// Directories copied wholesale.
const DIRS = ['css', 'js', 'downloads'];

// data/ is mostly seed material — .sql exports, source CSVs, working JSON — so
// only the files the site actually reads are copied.
const DATA_FILES = ['canonical-top20.json', 'wikidata-people.json'];
const DATA_DIRS = ['boards'];

function copyDir(from, to){
  if (!fs.existsSync(from)) return 0;
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) n += copyDir(src, dst);
    else { fs.copyFileSync(src, dst); n++; }
  }
  return n;
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let files = 0;

for (const name of fs.readdirSync(ROOT)) {
  if (name.endsWith('.html')) { fs.copyFileSync(path.join(ROOT, name), path.join(OUT, name)); files++; }
}
for (const dir of DIRS) files += copyDir(path.join(ROOT, dir), path.join(OUT, dir));

fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });
for (const name of DATA_FILES) {
  const src = path.join(ROOT, 'data', name);
  if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(OUT, 'data', name)); files++; }
}
for (const dir of DATA_DIRS) files += copyDir(path.join(ROOT, 'data', dir), path.join(OUT, 'data', dir));

// Fail the build rather than deploy something Cloudflare will reject.
const LIMIT = 25 * 1024 * 1024;
const oversized = [];
let bytes = 0;
(function walk(dir){
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else { const s = fs.statSync(p).size; bytes += s; if (s > LIMIT) oversized.push([p, s]); }
  }
})(OUT);

console.log(`build-assets: ${files} files, ${(bytes / 1e6).toFixed(1)} MB -> public/`);
if (oversized.length) {
  console.error('build-assets: these exceed Cloudflare\'s 25 MiB per-file limit:');
  for (const [p, s] of oversized) console.error(`  ${(s / 1e6).toFixed(1)} MB  ${path.relative(ROOT, p)}`);
  process.exit(1);
}
