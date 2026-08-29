#!/usr/bin/env node
// scripts/fix_country_boards.mjs
//
// The country export placed people on boards at random: 96% of entries were
// someone appearing on more than five boards in their own country, and rank
// carried no signal. This rebuilds the boards from the same names, but puts
// each person only on boards that match what they actually did.
//
// Occupation comes from two sources:
//   1. data/canonical-top20.json — the clean global 147-board set. Free, offline.
//   2. Wikidata (P106 occupation / P31 instance-of) for everyone else.
// Results are cached in data/occupations.json, so re-runs cost nothing.
//
//   node scripts/fix_country_boards.mjs            # use cache + Wikidata
//   node scripts/fix_country_boards.mjs --offline  # cache + global set only
//   node scripts/fix_country_boards.mjs --report   # classify, change nothing

import fs from 'fs';
import path from 'path';

const OFFLINE = process.argv.includes('--offline');
const REPORT  = process.argv.includes('--report');
const DIR = path.resolve('data/boards');
const CACHE = path.resolve('data/occupations.json');
const MIN_BOARD = 3;          // a board with fewer than this is not a ranking

const norm = s => String(s||'').toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();

// Board name -> the words an occupation must contain to belong on it.
// Order matters: the first rule that matches the board name wins.
const RULES = [
  [/football club|sports team|basketball team|f1 team|club$/i, ['__entity__']],
  [/american football/i, ['american football']],
  [/foot ?ball|soccer/i, ['football','soccer']],
  [/cricket|batsman|bowler|all.?rounder|wicketkeeper|ipl/i, ['cricket']],
  [/basketball/i, ['basketball']],
  [/tennis/i, ['tennis']],
  [/badminton/i, ['badminton']],
  [/hockey/i, ['hockey']],
  [/boxer|boxing/i, ['boxer','boxing']],
  [/mma|combat|wrestl|martial/i, ['martial','wrestl','fighter','judo','karate']],
  [/f1|formula|motorsport|racing driver/i, ['racing','formula','motorcycle']],
  [/swimmer|swimming/i, ['swimm']],
  [/track|sprinter|athletics|olympian|athlete/i, ['athlet','runner','sprint','olympic']],
  [/chess/i, ['chess']],
  [/golf/i, ['golf']],
  [/actress/i, ['actor','actress']],
  [/actor|film star/i, ['actor','actress']],
  [/film director|director/i, ['director','filmmaker']],
  [/screenwriter/i, ['screenwriter','writer']],
  [/singer|playback|vocalist/i, ['singer','vocalist']],
  [/rapper|hip hop/i, ['rapper']],
  [/composer/i, ['composer']],
  [/guitarist/i, ['guitarist']],
  [/dj\b/i, ['disc jockey','dj']],
  [/musician|band|music group/i, ['musician','singer','composer','guitarist','band']],
  [/comedian/i, ['comedian','comic']],
  [/author|writer|novelist|poet/i, ['writer','author','novelist','poet']],
  [/journalist/i, ['journalist']],
  [/historian/i, ['historian']],
  [/philosoph/i, ['philosoph']],
  [/physicist/i, ['physicist']],
  [/mathematic/i, ['mathematic']],
  [/chemist/i, ['chemist']],
  [/biologist/i, ['biologist']],
  [/scientist|medical pioneer|researcher/i, ['scientist','physicist','chemist','biologist','researcher','physician']],
  [/engineer/i, ['engineer']],
  [/inventor/i, ['inventor']],
  [/architect/i, ['architect']],
  [/painter|visual artist|artist/i, ['painter','artist','sculptor']],
  [/photograph/i, ['photograph']],
  [/designer|fashion/i, ['designer','fashion']],
  [/chef/i, ['chef','cook']],
  [/entrepreneur|founder|ceo|business/i, ['entrepreneur','businessperson','executive','founder']],
  [/investor/i, ['investor','financier']],
  [/president|prime minister|head of government|political|statesman|world leader|national leader/i,
     ['politician','statesperson','head of','president','prime minister','diplomat']],
  [/diplomat/i, ['diplomat','politician']],
  [/revolutionary|independence|freedom fighter|national hero/i, ['revolutionary','activist','politician']],
  [/military|general|admiral|commander/i, ['military','officer','general','commander']],
  [/monarch|king|queen|emperor|maharaja/i, ['monarch','king','queen','emperor','sovereign']],
  [/youtuber|streamer|influencer|internet creator|podcaster/i,
     ['youtuber','streamer','influencer','podcaster','blogger']],
  [/astronaut/i, ['astronaut','cosmonaut']],
  [/spiritual|saint|religious/i, ['religious','theologian','saint','guru']],
];

// Boards about things, not people — a person never belongs on them.
const ENTITY_BOARD = /\b(club|team|company|brand|startup|film|movie|album|book|song|dish|cuisine|city|state|province|region|landmark|monument|temple|university|newspaper|tv show|hypercar|car|airline|bank|festival|beach|mountain|park|museum|stadium|app|game)\b/i;

function rulesFor(boardName){
  for (const [re, keys] of RULES) if (re.test(boardName)) return keys;
  return null;
}

// ---- occupation sources ----
let cache = {};
if (fs.existsSync(CACHE)) { try { cache = JSON.parse(fs.readFileSync(CACHE,'utf8')); } catch(e){ cache = {}; } }

// The clean global set: a board a person appears on IS their domain.
const globalDomain = {};
try {
  const g = JSON.parse(fs.readFileSync(path.resolve('data/canonical-top20.json'),'utf8'));
  for (const v of Object.values(g))
    for (const n of v.top20) (globalDomain[norm(n)] ||= []).push(v.name);
} catch(e){ console.warn('global set unavailable:', e.message); }

async function wikidataOccupations(names){
  const out = {};
  const url = 'https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&limit=1&origin=*&search=';
  for (const n of names){
    try {
      const s = await (await fetch(url + encodeURIComponent(n))).json();
      const id = s.search?.[0]?.id;
      if (!id) { out[n] = []; continue; }
      const e = await (await fetch(`https://www.wikidata.org/wiki/Special:EntityData/${id}.json`)).json();
      const ent = e.entities[id];
      const ids = [...(ent.claims?.P106||[]), ...(ent.claims?.P31||[])]
        .map(c=> c.mainsnak?.datavalue?.value?.id).filter(Boolean);
      const labels = [];
      for (const q of ids.slice(0,8)){
        try {
          const d = await (await fetch(`https://www.wikidata.org/wiki/Special:EntityData/${q}.json`)).json();
          const l = d.entities[q]?.labels?.en?.value; if (l) labels.push(l.toLowerCase());
        } catch(_){}
      }
      out[n] = labels;
      await new Promise(r=> setTimeout(r, 60));
    } catch(err){ out[n] = []; }
  }
  return out;
}

// ---- load boards ----
const files = fs.readdirSync(DIR).filter(f=> f !== 'index.json');
const countries = files.map(f=> JSON.parse(fs.readFileSync(path.join(DIR,f),'utf8')));
const people = new Set();
for (const c of countries) for (const b of c.boards) for (const p of b.contenders) people.add(p.name);

// Seed the cache from the global set, then fill gaps from Wikidata.
for (const n of people){
  if (cache[n]) continue;
  const d = globalDomain[norm(n)];
  if (d) cache[n] = d.map(x=> x.toLowerCase());
}
const missing = [...people].filter(n=> !cache[n]);
console.log(`distinct people ${people.size} | known from global set ${people.size - missing.length} | to look up ${missing.length}`);
if (!OFFLINE && missing.length){
  console.log('querying Wikidata…');
  Object.assign(cache, await wikidataOccupations(missing));
  fs.writeFileSync(CACHE, JSON.stringify(cache, null, 0));
}

// ---- rebuild ----
function belongs(name, boardName){
  const keys = rulesFor(boardName);
  if (!keys) return null;                       // unknown board type -> undecidable
  if (keys[0] === '__entity__') return null;
  const occ = cache[name];
  if (!occ || !occ.length) return null;         // unclassified -> undecidable
  const blob = ' ' + occ.join(' ; ') + ' ';
  return keys.some(k=> blob.includes(k));
}

const stats = { kept:0, dropped:0, undecided:0, entityBoards:0, boardsDropped:0 };
for (const c of countries){
  const boards = [];
  for (const b of c.boards){
    if (ENTITY_BOARD.test(b.name) && !/greatest (footballer|cricketer)/i.test(b.name)){
      stats.entityBoards++; boards.push(b); continue;   // things: leave alone
    }
    const keep = [];
    for (const p of b.contenders){
      const v = belongs(p.name, b.name);
      if (v === true) { keep.push(p); stats.kept++; }
      else if (v === false) stats.dropped++;
      else { stats.undecided++; }                        // dropped: unproven
    }
    if (keep.length >= MIN_BOARD){
      keep.forEach((p,i)=> p.rank = i+1);
      boards.push({ ...b, contenders: keep });
    } else stats.boardsDropped++;
  }
  c.boards = boards;
}

console.log(`kept ${stats.kept} | wrong-domain ${stats.dropped} | unclassified ${stats.undecided}`);
console.log(`entity boards left alone ${stats.entityBoards} | boards dropped (under ${MIN_BOARD}) ${stats.boardsDropped}`);
const surviving = countries.filter(c=> c.boards.length);
console.log(`countries with boards remaining: ${surviving.length} of ${countries.length}`);

if (REPORT){ console.log('\n--report: nothing written'); process.exit(0); }

for (const f of fs.readdirSync(DIR)) fs.unlinkSync(path.join(DIR,f));
const index = [];
for (const c of surviving.sort((a,b)=> a.country.localeCompare(b.country))){
  fs.writeFileSync(path.join(DIR, `${c.code}.json`), JSON.stringify(c));
  index.push({ code:c.code, country:c.country, boards:c.boards.length,
               contenders:c.boards.reduce((s,b)=> s+b.contenders.length, 0) });
}
// The site only shows country boards when this stamp is present, so raw
// unclassified data can never reach visitors.
fs.writeFileSync(path.join(DIR,'index.json'), JSON.stringify({
  verified: true,
  builtAt: new Date().toISOString(),
  stats: { kept: stats.kept, wrongDomain: stats.dropped, unclassified: stats.undecided },
  countries: index
}, null, 1));
console.log('rebuilt data/boards/ (stamped verified)');
