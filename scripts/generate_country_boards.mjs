#!/usr/bin/env node
// scripts/generate_country_boards.mjs
//
// Fills every country board with real, correctly-classified people from
// Wikidata: humans with the board's occupation AND that country's citizenship,
// ranked by how many Wikipedia language editions have an article about them —
// a blunt but honest fame proxy, and the same signal that puts Tendulkar above
// a first-class journeyman.
//
// This exists because the source export could not fill the structure: India and
// the US are 150 boards x 50 = 7,500 slots each, but the export contained only
// ~500 distinct people per country, so it recycled the same names across every
// board. Generating is the only way to get 11,050 real contenders.
//
//   node scripts/generate_country_boards.mjs                 # all boards
//   node scripts/generate_country_boards.mjs --country=IN    # one country
//   node scripts/generate_country_boards.mjs --limit=5       # first 5 boards
//   node scripts/generate_country_boards.mjs --size=50       # contenders/board
//
// Hand-checked boards in data/curated-boards.json always win, so anything you
// have already verified is never overwritten.

import fs from 'fs';
import path from 'path';

const arg = (k, d) => (process.argv.find(a=> a.startsWith(`--${k}=`))||'').split('=')[1] || d;
const ONLY = arg('country', null);
const LIMIT = parseInt(arg('limit', '0'), 10);
const SIZE = parseInt(arg('size', '50'), 10);
const RESOLVE_ONLY = process.argv.includes('--resolve');

const ENDPOINT = 'https://query.wikidata.org/sparql';
const UA = 'TheTrueGOATBoardBuilder/1.0 (https://thetruegoat.com)';
const CACHE = path.resolve('data/wikidata-cache.json');
const OUT = path.resolve('data/generated-boards.json');

const COUNTRY_QID = { IN: 'Q668', US: 'Q30', GB: 'Q145' };

// A short list of QIDs I am confident about. Everything else is resolved
// against Wikidata at run time rather than guessed here — a wrong QID silently
// produces a wrong board, which is the failure this whole exercise exists to
// remove. Run --resolve first and read what it picked.
const SUBJECT_QID = {
  'cricketer':['Q12299841'], 'batsman':['Q12299841'], 'bowler':['Q12299841'],
  'all-rounder':['Q12299841'], 'cricket captain':['Q12299841'],
  'wicketkeeper':['Q12299841'], 'ipl player':['Q12299841'],
  'footballer':['Q937857'], 'basketball player':['Q3665646'],
  'baseball player':['Q10871364'], 'tennis player':['Q10833314'],
  'boxer':['Q11338576'], 'chess player':['Q10873124'], 'athlete':['Q2066131'],
  'actor':['Q33999'], 'actress':['Q33999'],
  'bollywood actor':['Q33999'], 'bollywood actress':['Q33999'],
  'film director':['Q2526255'], 'director':['Q2526255'],
  'singer':['Q177220'], 'playback singer':['Q177220'], 'rapper':['Q2252262'],
  'composer':['Q36834'], 'music composer':['Q36834'], 'musician':['Q639669'],
  'painter':['Q1028181'], 'painter / visual artist':['Q1028181'],
  'architect':['Q42973'], 'photographer':['Q33231'],
  'scientist':['Q901'], 'physicist':['Q169470'], 'mathematician':['Q170790'],
  'computer scientist':['Q82594'], 'ai researcher':['Q82594'],
  'inventor':['Q205375'], 'engineer':['Q81096'], 'economist':['Q188094'],
  'historian':['Q201788'], 'philosopher':['Q4964182'], 'journalist':['Q1930187'],
  'author':['Q36180'], 'author / writer':['Q36180'], 'poet':['Q49757'],
  'entrepreneur':['Q131524'], 'businessperson':['Q131524'], 'founder':['Q131524'],
  'tech founder':['Q131524'], 'politician':['Q82955'], 'leader':['Q82955'],
  'diplomat':['Q193391'], 'comedian':['Q245068'], 'chef':['Q3499072'],
  'fashion designer':['Q3501317'],
};

// Boards about things, not people. They need instance-of + country, not
// occupation + citizenship, so they are resolved and queried separately.
const ENTITY_BOARD = /\b(club|team|company|companies|startup|brand|film|movie|tv show|album|book|song|dish|cuisine|city|state|province|region|landmark|monument|university|restaurant|product|theme park|video game|superhero|character|destination|band|music group)\b/i;

// Ask Wikidata for the QID whose English label matches this subject. Restricted
// to things that are actually an occupation (or, for entity boards, a class),
// so "Bowler" resolves to the sport role and not the hat.
async function resolveQid(subject, entity){
  const key = (entity ? 'entity:' : 'occ:') + subject.toLowerCase();
  if (cache[key]) return cache[key];
  const term = subject.replace(/\s*\/.*$/,'').replace(/\s*\(.*\)/,'').trim();
  const url = 'https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en'
            + '&type=item&limit=8&origin=*&search=' + encodeURIComponent(term);
  try {
    const hits = (await (await fetch(url, { headers:{ 'User-Agent': UA } })).json()).search || [];
    for (const h of hits){
      const probe = entity
        ? `ASK { wd:${h.id} wdt:P279* wd:Q35120 . FILTER NOT EXISTS { wd:${h.id} wdt:P31 wd:Q5 } }`
        : `ASK { wd:${h.id} wdt:P279* wd:Q12737077 }`;
      const res = await fetch(ENDPOINT + '?format=json&query=' + encodeURIComponent(probe),
                              { headers:{ 'User-Agent': UA, 'Accept':'application/sparql-results+json' } });
      if (res.ok && (await res.json()).boolean){
        cache[key] = [h.id];
        fs.writeFileSync(CACHE, JSON.stringify(cache, null, 0));
        return cache[key];
      }
      await new Promise(r=> setTimeout(r, 300));
    }
  } catch(e){ console.warn(`  resolve "${subject}" failed: ${e.message}`); }
  cache[key] = null;
  fs.writeFileSync(CACHE, JSON.stringify(cache, null, 0));
  return null;
}

let cache = {};
if (fs.existsSync(CACHE)) { try { cache = JSON.parse(fs.readFileSync(CACHE,'utf8')); } catch(e){} }

async function sparql(query){
  const res = await fetch(ENDPOINT + '?format=json&query=' + encodeURIComponent(query),
                          { headers: { 'User-Agent': UA, 'Accept':'application/sparql-results+json' } });
  if (res.status === 429){                       // WDQS throttles; wait it out
    await new Promise(r=> setTimeout(r, 30000));
    return sparql(query);
  }
  if (!res.ok) throw new Error('WDQS ' + res.status);
  return (await res.json()).results.bindings;
}

// Most-linked first: sitelink count across Wikipedias is the fame proxy, and
// the same signal that puts Tendulkar above a first-class journeyman.
function buildQuery(qids, countryQid, size, entity){
  const values = qids.map(q=> `wd:${q}`).join(' ');
  return entity
    ? `SELECT ?name ?sitelinks WHERE {
  VALUES ?class { ${values} }
  ?item wdt:P31/wdt:P279* ?class ; wdt:P17 wd:${countryQid} ;
        wikibase:sitelinks ?sitelinks ; rdfs:label ?name .
  FILTER(LANG(?name) = "en")
} ORDER BY DESC(?sitelinks) LIMIT ${size}`
    : `SELECT ?name ?sitelinks WHERE {
  VALUES ?occ { ${values} }
  ?person wdt:P31 wd:Q5 ; wdt:P106/wdt:P279* ?occ ; wdt:P27 wd:${countryQid} ;
          wikibase:sitelinks ?sitelinks ; rdfs:label ?name .
  FILTER(LANG(?name) = "en")
} ORDER BY DESC(?sitelinks) LIMIT ${size}`;
}

const boardsFile = JSON.parse(fs.readFileSync(path.resolve('data/board-names.json'),'utf8'));
const curated = fs.existsSync(path.resolve('data/curated-boards.json'))
  ? JSON.parse(fs.readFileSync(path.resolve('data/curated-boards.json'),'utf8')) : {};
const curatedNames = {};
for (const [code,c] of Object.entries(curated))
  curatedNames[code] = new Set(c.boards.map(b=> b.name.toLowerCase()));

const out = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT,'utf8')) : {};
let done = 0, filled = 0, empty = 0, skipped = 0, unmapped = [];

for (const [code, c] of Object.entries(boardsFile)){
  if (ONLY && code !== ONLY) continue;
  const qid = COUNTRY_QID[code];
  if (!qid){ console.warn(`no country QID for ${code}, skipping`); continue; }
  out[code] ||= { code, country: c.country, boards: [] };
  const have = new Set(out[code].boards.map(b=> b.name.toLowerCase()));

  for (const b of c.boards){
    if (LIMIT && done >= LIMIT) break;
    if (curatedNames[code]?.has(b.name.toLowerCase())) { skipped++; continue; }  // hand-checked wins
    if (have.has(b.name.toLowerCase())) { skipped++; continue; }                 // already generated
    const key = b.subject.toLowerCase();
    const entity = ENTITY_BOARD.test(b.subject);
    const occ = SUBJECT_QID[key] || await resolveQid(b.subject, entity);
    if (!occ){ unmapped.push(`${code}: ${b.subject}`); continue; }
    if (RESOLVE_ONLY){ console.log(`  ${b.subject.padEnd(30)} -> ${occ.join(',')}${entity?' (thing)':''}`); continue; }

    done++;
    try {
      const rows = await sparql(buildQuery(occ, qid, SIZE, entity));
      const names = [...new Set(rows.map(r=> r.name.value.trim()))].slice(0, SIZE);
      if (names.length){
        out[code].boards.push({ name: b.name, contenders: names });
        filled++;
        console.log(`  ${b.name.padEnd(46)} ${names.length} — ${names.slice(0,3).join(', ')}`);
      } else { empty++; console.log(`  ${b.name.padEnd(46)} EMPTY`); }
    } catch(err){
      console.warn(`  ${b.name.padEnd(46)} FAILED ${err.message}`);
    }
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));   // checkpoint every board
    await new Promise(r=> setTimeout(r, 900));             // be polite to WDQS
  }
}

console.log(`\nfilled ${filled} | empty ${empty} | skipped (curated/done) ${skipped}`);
if (unmapped.length) console.log(`unmapped subjects (${unmapped.length}):\n  ` + unmapped.join('\n  '));
console.log(`written to ${OUT}`);
