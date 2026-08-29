
import { createClient } from '@supabase/supabase-js'
const old = createClient('https://iuvmzlrnbwptgrbkdbbn.supabase.co', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1dm16bHJuYndwdGdyYmtkYmJuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NzU5NzcyOSwiZXhwIjoyMTAzMTczNzI5fQ.XX378u9ceV2zf8urOZoHN4wwRwlsEgkb1nJF9TG1DQU')
const neo = createClient('https://orzcszqpnvicreqvpncu.supabase.co', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9yemNzenFwbnZpY3JlcXZwbmN1Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NzY0MjA0MiwiZXhwIjoyMTAzMjE4MDQyfQ.ox7ew17e3rm4QlNWNeglDJB_b1KFP55S3053B5uAadM')
async function copy() {
  console.log('fetching old people with photos...')
  let allOld=[]
  let from=0
  while(true){
    const {data, error} = await old.from('people').select('name,photo_path,photo_credit,photo_license,slug').not('photo_path','is',null).range(from, from+999)
    if(error){ console.log('old fetch err', error.message); break }
    if(!data||!data.length) break
    allOld.push(...data)
    console.log('fetched', allOld.length)
    if(data.length<1000) break
    from+=1000
  }
  console.log('old with photos', allOld.length)
  // Build map by name lower
  const map=new Map()
  for(const p of allOld) map.set(p.name.toLowerCase(), p)
  console.log('fetching new people...')
  let allNew=[]
  from=0
  while(true){
    const {data} = await neo.from('people').select('id,name,photo_path').range(from, from+999)
    if(!data||!data.length) break
    allNew.push(...data)
    if(data.length<1000) break
    from+=1000
  }
  console.log('new total', allNew.length)
  let toUpdate=[]
  for(const n of allNew){
    const o=map.get(n.name.toLowerCase())
    if(o && o.photo_path && !n.photo_path) toUpdate.push({id:n.id, photo_path:o.photo_path, photo_credit:o.photo_credit, photo_license:o.photo_license})
  }
  console.log('toUpdate', toUpdate.length)
  for(let i=0;i<toUpdate.length;i+=100){
    const batch=toUpdate.slice(i,i+100)
    for(const row of batch){
      const {error} = await neo.from('people').update({photo_path:row.photo_path, photo_credit:row.photo_credit, photo_license:row.photo_license}).eq('id', row.id)
      if(error) console.log('update err', error.message.slice(0,80))
    }
    console.log(`batch ${Math.floor(i/100)+1}/${Math.ceil(toUpdate.length/100)} done`)
  }
  console.log('copy done')
}
copy()
