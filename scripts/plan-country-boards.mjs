// scripts/plan-country-boards.mjs — compose the board list for every country.
//
//   node scripts/plan-country-boards.mjs            # write data/board-names.json
//   node scripts/plan-country-boards.mjs --report   # print the plan, write nothing
//   node scripts/plan-country-boards.mjs --country=BR
//
// Produces the STRUCTURE only: which boards each country gets and what each is
// called. The contenders are filled afterwards by
// scripts/generate_country_boards.mjs, which pulls real people out of Wikidata
// by citizenship and occupation — so no contender on this site comes from a
// model's memory, which for 100,000 names across 198 countries is the only
// defensible way to build it.
//
// Boards already written by hand in data/board-names.json are kept exactly as
// they are. This adds what is missing rather than overwriting curation.
import fs from 'fs';
import path from 'path';

const arg = (k, d) => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1] || d;
const ONLY   = arg('country', null);
const REPORT = process.argv.includes('--report');

const T = JSON.parse(fs.readFileSync(path.resolve('data/category-templates.json'), 'utf8'));
const C = JSON.parse(fs.readFileSync(path.resolve('data/countries.json'), 'utf8'));
const OUT = path.resolve('data/board-names.json');

const existing = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};

// Tier 2 gets the long tail and 50 contenders a board; everyone else gets the
// core set plus whatever their region actually follows, at 10 apiece.
const TIER = code => C.tiers[code] || 1;
const SIZE = tier => (tier === 2 ? 50 : 10);
const TARGET = tier => (tier === 2 ? 150 : 50);

// "Greatest X of All Time" reads wrong for a few of these — a film is a film,
// not a person — so the shape is chosen per subject rather than glued on.
// The demonym, not the country name: "Greatest British Cricketer of All Time",
// which is how the hand-written boards already read, rather than "Greatest
// United Kingdom Cricketer of All Time".
function boardName(code, subject){
  const country = C.demonyms[code] || C.countries[code];
  if (/of All Time$/.test(subject)) return `Greatest ${country} ${subject.replace(/ of All Time$/, '')} of All Time`;
  return `Greatest ${country} ${subject} of All Time`;
}
const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function subjectsFor(code){
  // Regional first, then core, then the tail. A country's own sports are the
  // most country-specific boards it has, and a plain slice off the end of a
  // core-first list dropped every one of them — Britain with no cricket and no
  // rugby, which is the opposite of "what that country cares about".
  const subjects = [];
  for (const block of Object.values(T.regional)) {
    if (block.countries.includes(code)) subjects.push(...block.categories);
  }
  subjects.push(...T.core);
  if (TIER(code) === 2) subjects.push(...T.extended);

  // A country in several regional blocks can pass the target; a small one will
  // not reach it, and padding with boards nobody in that country follows is
  // exactly the "Apple and Samsung everywhere" problem in a new costume. So the
  // target is a ceiling, never a quota.
  const seen = new Set();
  return subjects.filter(s => {
    const k = s.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, TARGET(TIER(code)));
}

const plan = {};
let boards = 0, slots = 0;

for (const [code, country] of Object.entries(C.countries)) {
  if (ONLY && code !== ONLY) continue;

  const tier = TIER(code);
  const size = SIZE(tier);
  const already = existing[code]?.boards || [];
  const haveNames = new Set(already.map(b => String(b.name || '').toLowerCase()));

  // The target is the total, not an addition. Curated boards already count
  // towards it, or a country with 109 hand-written boards ends up with 259.
  const room = Math.max(0, TARGET(tier) - already.length);

  const added = [];
  for (const subject of subjectsFor(code)) {
    if (added.length >= room) break;
    const name = boardName(code, subject);
    if (haveNames.has(name.toLowerCase())) continue;
    added.push({
      id: `${code}-${String(already.length + added.length + 1).padStart(3, '0')}`,
      slug: slugify(`${code}-${name}`),
      name,
      subject,
      size
    });
  }

  plan[code] = { code, country, tier, boards: [...already, ...added] };
  boards += plan[code].boards.length;
  slots  += plan[code].boards.reduce((n, b) => n + (b.size || size), 0);
}

const countries = Object.keys(plan).length;
console.log(`${countries} countries · ${boards} boards · ${slots.toLocaleString('en-US')} contender slots`);
for (const code of ['US', 'IN', 'GB', 'BR', 'JP', 'NG'].filter(c => plan[c])) {
  console.log(`  ${code} ${plan[code].country.padEnd(22)} ${String(plan[code].boards.length).padStart(3)} boards × ${SIZE(plan[code].tier)}`);
}

if (REPORT) {
  console.log('\n--report: nothing written.');
} else {
  fs.writeFileSync(OUT, JSON.stringify({ ...existing, ...plan }, null, 0));
  console.log(`\nwrote ${path.relative(process.cwd(), OUT)}`);
  console.log('next: node scripts/generate_country_boards.mjs   (fills contenders from Wikidata)');
}
