// The service-role key used to be hardcoded in this file. It is read from the
// environment now — see .env.example.
function mustEnv(name){
  const v = process.env[name];
  if(!v){ console.error(name + ' is not set. Put it in .env (see .env.example) or export it before running this script.'); process.exit(1); }
  return v;
}

import { createClient } from '@supabase/supabase-js'
const old = createClient('https://iuvmzlrnbwptgrbkdbbn.supabase.co', mustEnv('OLD_SUPABASE_SERVICE_ROLE_KEY'))
const neo = createClient('https://orzcszqpnvicreqvpncu.supabase.co', mustEnv('SUPABASE_SERVICE_ROLE_KEY'))
async function copyFast(){
  console.log('fetch old with photos')
  let allOld=[]
  let from=0
  while(true){
    const {data,error}=await old.from('people').select('name,photo_path,photo_credit,photo_license').not('photo_path','is',null).range(from,from+999)
    if(error){ console.log(error.message); break }
    if(!data.length) break
    allOld.push(...data)
    console.log('old fetched',allOld.length)
    if(data.length<1000) break
    from+=1000
  }
  const map=new Map()
  for(const p of allOld) map.set(p.name.toLowerCase(), p)
  console.log('fetch new')
  let allNew=[]
  from=0
  while(true){
    const {data}=await neo.from('people').select('id,name,photo_path').range(from,from+999)
    if(!data.length) break
    allNew.push(...data)
    if(data.length<1000) break
    from+=1000
  }
  console.log('new',allNew.length)
  let todo=[]
  for(const n of allNew){
    const o=map.get(n.name.toLowerCase())
    if(o && o.photo_path && !n.photo_path) todo.push({id:n.id, pp:o.photo_path, pc:o.photo_credit, pl:o.photo_license})
  }
  console.log('todo',todo.length)
  let done=0
  const conc=20
  for(let i=0;i<todo.length;i+=conc){
    const batch=todo.slice(i,i+conc)
    await Promise.all(batch.map(async row=>{
      const {error}=await neo.from('people').update({photo_path:row.pp, photo_credit:row.pc, photo_license:row.pl}).eq('id',row.id)
      if(!error) done++
    }))
    console.log(`done ${done}/${todo.length} ${Math.round(done/todo.length*100)}%`)
  }
  console.log('fast copy done',done)
}
copyFast()
