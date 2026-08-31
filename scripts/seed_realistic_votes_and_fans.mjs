// The service-role key used to be hardcoded in this file. It is read from the
// environment now — see .env.example.
function mustEnv(name){
  const v = process.env[name];
  if(!v){ console.error(name + ' is not set. Put it in .env (see .env.example) or export it before running this script.'); process.exit(1); }
  return v;
}

// scripts/seed_realistic_votes_and_fans.mjs
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const SUPABASE_URL = 'https://orzcszqpnvicreqvpncu.supabase.co';
const SERVICE_KEY = mustEnv('SUPABASE_SERVICE_ROLE_KEY');

const supa = createClient(SUPABASE_URL, SERVICE_KEY);

const SEED_FANS = [
  { id: '11111111-1111-4111-8111-111111111101', email: 'alex.voter@thetruegoat.com', display_name: 'Alex Rivera', social_handle: 'alex_goat', social_platform: 'x', photo_path: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=200&q=80' },
  { id: '11111111-1111-4111-8111-111111111102', email: 'elena.rodriguez@thetruegoat.com', display_name: 'Elena Rostova', social_handle: 'elena_r', social_platform: 'x', photo_path: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?auto=format&fit=crop&w=200&q=80' },
  { id: '11111111-1111-4111-8111-111111111103', email: 'marcus.chen@thetruegoat.com', display_name: 'Marcus Chen', social_handle: 'marcus_c', social_platform: 'x', photo_path: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=200&q=80' },
  { id: '11111111-1111-4111-8111-111111111104', email: 'sophia.laurent@thetruegoat.com', display_name: 'Sophia Laurent', social_handle: 'sophia_l', social_platform: 'instagram', photo_path: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=200&q=80' },
  { id: '11111111-1111-4111-8111-111111111105', email: 'vikram.patel@thetruegoat.com', display_name: 'Vikram Patel', social_handle: 'vikram_p', social_platform: 'x', photo_path: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=200&q=80' },
  { id: '11111111-1111-4111-8111-111111111106', email: 'david.beck@thetruegoat.com', display_name: 'David Beck', social_handle: 'beck_goat', social_platform: 'x', photo_path: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?auto=format&fit=crop&w=200&q=80' },
  { id: '11111111-1111-4111-8111-111111111107', email: 'chloe.kim@thetruegoat.com', display_name: 'Chloe Kim', social_handle: 'chloe_k', social_platform: 'instagram', photo_path: 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&w=200&q=80' },
  { id: '11111111-1111-4111-8111-111111111108', email: 'lucas.silva@thetruegoat.com', display_name: 'Lucas Silva', social_handle: 'lucas_s', social_platform: 'x', photo_path: 'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?auto=format&fit=crop&w=200&q=80' },
  { id: '11111111-1111-4111-8111-111111111109', email: 'amara.okafor@thetruegoat.com', display_name: 'Amara Okafor', social_handle: 'amara_o', social_platform: 'x', photo_path: 'https://images.unsplash.com/photo-1531746020798-e6953c6e8e04?auto=format&fit=crop&w=200&q=80' },
  { id: '11111111-1111-4111-8111-111111111110', email: 'tariq.almansoor@thetruegoat.com', display_name: 'Tariq Al-Mansoor', social_handle: 'tariq_m', social_platform: 'x', photo_path: 'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?auto=format&fit=crop&w=200&q=80' },
  { id: '11111111-1111-4111-8111-111111111111', email: 'jessica.taylor@thetruegoat.com', display_name: 'Jessica Taylor', social_handle: 'jess_t', social_platform: 'instagram', photo_path: 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?auto=format&fit=crop&w=200&q=80' },
  { id: '11111111-1111-4111-8111-111111111112', email: 'kai.tanaka@thetruegoat.com', display_name: 'Kai Tanaka', social_handle: 'kai_t', social_platform: 'x', photo_path: 'https://images.unsplash.com/photo-1501196354995-cbb51c65aaea?auto=format&fit=crop&w=200&q=80' }
];

async function seed() {
  console.log('Seeding starter fans & votes...');
  
  // 1. Insert seed users
  for (const u of SEED_FANS) {
    const { error } = await supa.from('users').upsert({
      id: u.id,
      email: u.email,
      display_name: u.display_name,
      is_anonymous: false,
      balance_cents: 25000,
      total_spent_cents: 0,
      photo_path: u.photo_path,
      social_handle: u.social_handle,
      social_platform: u.social_platform,
      photo_status: 'approved'
    }, { onConflict: 'id' });
    if (error) console.error('User upsert error:', u.display_name, error.message);
  }
  console.log('Users created.');

  // 2. Load categories and canonical-top20
  const { data: cats } = await supa.from('categories').select('*');
  const canonicalData = JSON.parse(fs.readFileSync('data/canonical-top20.json', 'utf-8'));
  const { data: allPeople } = await supa.from('people').select('id,name,slug,category_id');

  const peopleByCatAndName = {};
  allPeople.forEach(p => {
    const k = p.category_id + ':' + p.name.toLowerCase().trim();
    peopleByCatAndName[k] = p;
  });

  // Target votes for top contenders
  const now = Date.now();
  const bidsToInsert = [];
  const fanTotalsMap = {}; // key: person_id:user_id => total_cents
  const personVoteTotals = {}; // key: person_id => total_cents

  let totalVotesCount = 0;

  // Let's give top duels realistic high votes and other boards good starter votes
  for (const cat of cats) {
    // find matching canonical entry
    let canonEntry = canonicalData[cat.slug];
    if (!canonEntry) {
      for (const k of Object.keys(canonicalData)) {
        if (canonicalData[k].name && (canonicalData[k].name.toLowerCase() === cat.name.toLowerCase() || canonicalData[k].name.toLowerCase().includes(cat.name.toLowerCase()))) {
          canonEntry = canonicalData[k];
          break;
        }
      }
    }
    const top20Names = canonEntry?.top20 || [];
    
    // Find contenders in this category
    const catContenders = allPeople.filter(p => p.category_id === cat.id);
    if (!catContenders.length) continue;

    // Order contenders: canonical names first, then others
    catContenders.sort((a, b) => {
      const ia = top20Names.findIndex(n => n.toLowerCase() === a.name.toLowerCase());
      const ib = top20Names.findIndex(n => n.toLowerCase() === b.name.toLowerCase());
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return 0;
    });

    const isTopCategory = ['footballers', 'tennis-men', 'basketball-players', 'directors', 'hollywood-actors', 'singers', 'us-presidents', 'scientists', 'founders', 'rappers', 'boxers', 'f1-drivers', 'bollywood-actors', 'batsmen'].includes(cat.slug);

    const baseTopVotes = isTopCategory ? 8000 + Math.floor(Math.random() * 4000) : 1500 + Math.floor(Math.random() * 2000);
    const gap = isTopCategory ? 120 + Math.floor(Math.random() * 300) : 40 + Math.floor(Math.random() * 120);

    for (let i = 0; i < Math.min(catContenders.length, 10); i++) {
      const contender = catContenders[i];
      let contenderVotes = 0;
      if (i === 0) contenderVotes = baseTopVotes;
      else if (i === 1) contenderVotes = baseTopVotes - gap;
      else if (i === 2) contenderVotes = Math.floor(baseTopVotes * 0.65);
      else if (i === 3) contenderVotes = Math.floor(baseTopVotes * 0.45);
      else contenderVotes = Math.max(15, Math.floor(baseTopVotes * (0.35 - i * 0.03)));

      const totalCents = contenderVotes * 100;
      personVoteTotals[contender.id] = totalCents;
      totalVotesCount += contenderVotes;

      // Distribute among fans
      const fan1 = SEED_FANS[i % SEED_FANS.length];
      const fan2 = SEED_FANS[(i + 3) % SEED_FANS.length];
      const fan3 = SEED_FANS[(i + 7) % SEED_FANS.length];

      const fan1Cents = Math.floor(totalCents * 0.55);
      const fan2Cents = Math.floor(totalCents * 0.30);
      const fan3Cents = totalCents - fan1Cents - fan2Cents;

      const ftKey1 = `${contender.id}:${fan1.id}`;
      const ftKey2 = `${contender.id}:${fan2.id}`;
      const ftKey3 = `${contender.id}:${fan3.id}`;

      fanTotalsMap[ftKey1] = (fanTotalsMap[ftKey1] || 0) + fan1Cents;
      fanTotalsMap[ftKey2] = (fanTotalsMap[ftKey2] || 0) + fan2Cents;
      fanTotalsMap[ftKey3] = (fanTotalsMap[ftKey3] || 0) + fan3Cents;

      // Create recent bid events for feed & ticker
      // Distribute timestamps over the last 24 hours
      const timeAgo1 = Math.floor(Math.random() * 3600 * 1000 * 4); // last 4 hours (today)
      const timeAgo2 = Math.floor(Math.random() * 3600 * 1000 * 12);
      const timeAgo3 = Math.floor(Math.random() * 3600 * 1000 * 24);

      bidsToInsert.push(
        { user_id: fan1.id, person_id: contender.id, amount_cents: fan1Cents, created_at: new Date(now - timeAgo1).toISOString() },
        { user_id: fan2.id, person_id: contender.id, amount_cents: fan2Cents, created_at: new Date(now - timeAgo2).toISOString() },
        { user_id: fan3.id, person_id: contender.id, amount_cents: fan3Cents, created_at: new Date(now - timeAgo3).toISOString() }
      );
    }
  }

  console.log(`Generated ${bidsToInsert.length} bids across contenders.`);

  // 3. Update people total_cents and first_backed_at in batches
  console.log('Updating people totals in DB...');
  const peopleUpdates = Object.entries(personVoteTotals);
  for (let i = 0; i < peopleUpdates.length; i += 100) {
    const chunk = peopleUpdates.slice(i, i + 100);
    await Promise.all(chunk.map(([pid, cents]) => 
      supa.from('people').update({ total_cents: cents, first_backed_at: new Date(now - 86400000 * 3).toISOString(), backer_count: 3 }).eq('id', pid)
    ));
  }
  console.log('People totals updated.');

  // 4. Insert bids in chunks
  console.log('Inserting bids...');
  for (let i = 0; i < bidsToInsert.length; i += 200) {
    const chunk = bidsToInsert.slice(i, i + 200);
    const { error } = await supa.from('bids').insert(chunk);
    if (error) console.error('Bids insert error chunk', i, error.message);
  }
  console.log('Bids inserted.');

  // 5. Insert fan_totals
  console.log('Inserting fan totals...');
  const fanTotalsRows = Object.entries(fanTotalsMap).map(([k, total]) => {
    const [person_id, user_id] = k.split(':');
    return { person_id, user_id, total_cents: total };
  });
  for (let i = 0; i < fanTotalsRows.length; i += 200) {
    const chunk = fanTotalsRows.slice(i, i + 200);
    const { error } = await supa.from('fan_totals').upsert(chunk, { onConflict: 'person_id,user_id' });
    if (error) console.error('Fan totals upsert chunk', i, error.message);
  }
  console.log('Fan totals inserted.');

  // 6. Update user total_spent_cents
  console.log('Updating users total spent...');
  const userSpent = {};
  fanTotalsRows.forEach(ft => {
    userSpent[ft.user_id] = (userSpent[ft.user_id] || 0) + ft.total_cents;
  });
  for (const [uid, total] of Object.entries(userSpent)) {
    await supa.from('users').update({ total_spent_cents: total }).eq('id', uid);
  }

  // 7. Update site_stats
  await supa.from('site_stats').upsert({ id: 1, visitor_count: 1420 }, { onConflict: 'id' });
  console.log('Site stats updated.');

  console.log('Seed completed successfully!');
}

seed().catch(console.error);
