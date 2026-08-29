#!/usr/bin/env node
// scripts/build_country_boards.mjs
// Turns the combined country dataset into normalised, per-country board files
// plus a seed migration. Re-runnable: outputs are derived, never hand-edited.
//
// Usage: node scripts/build_country_boards.mjs <path-to-combined.csv>

import fs from 'fs';
import path from 'path';

const SRC = process.argv[2];
if (!SRC || !fs.existsSync(SRC)) {
  console.error('Usage: node scripts/build_country_boards.mjs <combined.csv>');
  process.exit(1);
}
const OUT_DIR = path.resolve('data/boards');
const SEED = path.resolve('data/country-boards-seed.sql');

// "TN2" was invented to dodge a collision with Tunisia (TN); Tanzania is TZ.
const CODE_FIX = { TN2: 'TZ' };

// Minimal RFC4180 parser — names contain commas and quotes.
function parseCsv(text){
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++){
    const c = text[i];
    if (q){
      if (c === '"'){ if (text[i+1] === '"'){ field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ','){ row.push(field); field = ''; }
    else if (c === '\n'){ row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length){ row.push(field); rows.push(row); }
  return rows;
}

const slugify = s => String(s).toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const norm = s => String(s).toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();

// "Greatest British Greatest Boxer" -> "Greatest British Boxer"
function fixBoardName(n){
  let first = true;
  return String(n).replace(/\bGreatest\s+/gi, () => (first ? (first = false, 'Greatest ') : ''))
    .replace(/\s+/g,' ').trim();
}

const raw = parseCsv(fs.readFileSync(SRC, 'utf8'));
const header = raw.shift().map(h => h.trim());
const col = Object.fromEntries(header.map((h,i)=>[h,i]));

const stats = { input: 0, codeFixed: 0, nameFixed: 0, dropped: 0 };
const boards = new Map();   // boardId -> board

for (const r of raw){
  if (!r || r.length < header.length) continue;
  const name = (r[col.contender_name] || '').trim();
  if (!name) { stats.dropped++; continue; }
  stats.input++;

  let code = (r[col.country_code] || '').trim();
  let id   = (r[col.board_id] || '').trim();
  if (CODE_FIX[code]){ id = id.replace(new RegExp('^'+code+'-'), CODE_FIX[code]+'-'); code = CODE_FIX[code]; stats.codeFixed++; }

  const rawBoard = (r[col.board_name] || '').trim();
  const boardName = fixBoardName(rawBoard);
  if (boardName !== rawBoard) stats.nameFixed++;

  if (!boards.has(id)){
    boards.set(id, {
      id, code, country: (r[col.country] || '').trim(),
      name: boardName, slug: `${code.toLowerCase()}-${slugify(boardName)}`,
      contenders: [], seen: new Map()
    });
  }
  const b = boards.get(id);
  const key = norm(name);
  const rank = parseInt(r[col.rank_seed], 10) || 9999;
  // Same contender listed twice (merged source batches): keep the best rank.
  const prev = b.seen.get(key);
  if (prev){ if (rank < prev.rank) prev.rank = rank; stats.dropped++; continue; }
  const entry = { rank, name, type: (r[col.contender_type] || 'person').trim() };
  b.seen.set(key, entry);
  b.contenders.push(entry);
}

// Re-rank contiguously from 1 after dedup.
const byCountry = new Map();
for (const b of boards.values()){
  b.contenders.sort((x,y)=> x.rank - y.rank || x.name.localeCompare(y.name));
  b.contenders.forEach((c,i)=> c.rank = i + 1);
  delete b.seen;
  if (!byCountry.has(b.code)) byCountry.set(b.code, { code:b.code, country:b.country, boards:[] });
  byCountry.get(b.code).boards.push(b);
}

// Slugs must be unique: same board name twice in one country would collide.
const slugSeen = new Set();
for (const c of byCountry.values()){
  c.boards.sort((a,b)=> a.id.localeCompare(b.id, undefined, {numeric:true}));
  for (const b of c.boards){
    let s = b.slug, n = 2;
    while (slugSeen.has(s)) s = `${b.slug}-${n++}`;
    b.slug = s; slugSeen.add(s);
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const f of fs.readdirSync(OUT_DIR)) fs.unlinkSync(path.join(OUT_DIR, f));

const index = [];
for (const c of [...byCountry.values()].sort((a,b)=> a.country.localeCompare(b.country))){
  fs.writeFileSync(path.join(OUT_DIR, `${c.code}.json`), JSON.stringify({
    code: c.code, country: c.country,
    boards: c.boards.map(b=>({ id:b.id, slug:b.slug, name:b.name, contenders:b.contenders }))
  }));
  index.push({ code:c.code, country:c.country, boards:c.boards.length,
               contenders:c.boards.reduce((s,b)=> s + b.contenders.length, 0) });
}
fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify({ countries: index }, null, 1));

// ---- seed migration ----
const q = s => "'" + String(s).replace(/'/g, "''") + "'";
const catRows = [], personRows = [];
for (const c of byCountry.values()){
  for (const b of c.boards){
    catRows.push(`(${q(b.slug)},${q(b.name)},${q(c.country)},${q(c.code)},${q(b.id)})`);
    for (const p of b.contenders){
      personRows.push(`(${q(b.slug)},${p.rank},${q(p.name)},${q(p.type)})`);
    }
  }
}
fs.writeFileSync(SEED, `-- data/country-boards-seed.sql  (generated by scripts/build_country_boards.mjs)
-- ${catRows.length} country boards, ${personRows.length} contenders, ${index.length} countries.
--
-- Insert-only and re-runnable: existing categories and contenders are left
-- untouched, so nothing already on the site is overwritten or deleted.
-- Review the counts before running. This adds a LOT of boards.

alter table categories add column if not exists country text;
alter table categories add column if not exists country_code text;
alter table categories add column if not exists board_id text;
create index if not exists categories_country_idx on categories (country_code);

create temp table cb_cat (slug text, name text, country text, country_code text, board_id text) on commit drop;
insert into cb_cat values
${catRows.join(',\n')};

create temp table cb_person (cat_slug text, rank int, name text, kind text) on commit drop;
insert into cb_person values
${personRows.join(',\n')};

insert into categories (slug, name, group_name, country, country_code, board_id, sort_order)
select k.slug, k.name, k.country, k.country, k.country_code, k.board_id, 0
from cb_cat k
where not exists (select 1 from categories c where c.slug = k.slug);

insert into people (slug, category_id, name, wikipedia_url, total_cents)
select p.cat_slug || '-' || lower(regexp_replace(p.name,'[^a-zA-Z0-9]+','-','g')),
       c.id, p.name,
       'https://en.wikipedia.org/wiki/' || replace(p.name,' ','_'),
       0
from cb_person p
join categories c on c.slug = p.cat_slug
where not exists (
  select 1 from people x where x.category_id = c.id and lower(x.name) = lower(p.name)
);
`);

console.log(`input rows      ${stats.input}`);
console.log(`dropped (dupes) ${stats.dropped}`);
console.log(`country codes fixed ${stats.codeFixed}   board names fixed ${stats.nameFixed}`);
console.log(`countries ${index.length}  boards ${catRows.length}  contenders ${personRows.length}`);
