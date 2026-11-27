'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const {catalogPage, importGame, family} = require('./ps-import');

function load(file, fallback) {
  try {
    const text=fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'');
    try { return JSON.parse(text); }
    catch { throw Error('Файл '+path.basename(file)+(text.trim()?' содержит незавершённый или некорректный JSON.':' пуст.')+' Восстановите его из резервной копии.'); }
  }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function save(file, data) {
  const tmp = file + '.catalog-tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}
function ids(row) {
  return [row.id,...Object.values(row.productIds||{})].filter(Boolean);
}
function registerCatalog(admin, files, attachImport) {
  for(const mode of ['all','new','preorder']) registerJob(admin,files,attachImport,mode);
}
function registerJob(admin,files,attachImport,mode) {
  const prefix=mode==='all'?'ps-catalog':'ps-'+mode;
  const stateFile=path.join(path.dirname(files.all),'ps-import-'+mode+'-v2.json');
  let state=load(stateFile,{phase:'idle'}),active=false;
  const persist=()=>save(stateFile,state);
  const status=()=>({ok:true,phase:state.phase,pages:Math.ceil((state.position||0)/24),
    added:state.added||0,updated:state.updated||0,current:state.current||'',
    failed:Object.keys(state.errors||{}).length,error:state.error||''});

  // Keep the legacy section records in sync by exact product, including manually assigned IDs.
  function commit(products){
    if(!products.length)return;
    const canonical=new Map();
    for(const [section,file] of Object.entries({all:files.all,...files})){
      const doc=load(file,{items:[]});
      if(!Array.isArray(doc.items))throw Error('Некорректный формат '+path.basename(file));
      const byId=new Map();
      for(const row of doc.items)for(const id of ids(row))byId.set(id,row);
      let changed=false;
      for(const {game,item} of products){
        const existing=ids(game).map(id=>byId.get(id)).find(Boolean);
        if(section==='discount' && item.role!=='title'){
          const offers=Object.entries(game.regions).filter(([,r])=>r.salePrice!=null);
          if(!existing && !offers.some(([,r])=>r.discPerc>0))continue;
          const row=existing||{...game,id:canonical.get(game.id)||game.id,regions:{}};
          row.regions||={};
          for(const [region,offer] of offers)row.regions[region]={...row.regions[region],...offer};
          row.name=game.name;row.names=game.names;
          if(!existing)doc.items.push(row);
          for(const id of ids(row))byId.set(id,row);
          changed=true;continue;
        }
        const member=item.role!=='title' && (section==='all'||(section===mode && item.role==='root'));
        if(!member && !existing)continue;
        if(!member){
          if(existing.name===game.name && existing.names?.ru===game.names.ru && existing.names?.en===game.names.en)continue;
          existing.name=game.name;existing.names=game.names;changed=true;continue;
        }
        const row=existing||{...game,id:canonical.get(game.id)||game.id,regions:{}};
        if(section==='all')canonical.set(game.id,row.id);
        attachImport(row,game,existing?.regions||{});
        if(item.role!=='root'){
          row.psParentConcepts=[...new Set([...(row.psParentConcepts||[]),item.parent])];
          row.psProductType=item.role;
        }
        if(section===mode && mode!=='all'){row.psCollection=mode;row.psCollectionRun=state.runId}
        if(section==='new' && !row.addedToNewReleasesAt)row.addedToNewReleasesAt=new Date().toISOString();
        if(!existing)doc.items.push(row);
        for(const id of ids(row))byId.set(id,row);
        if(section==='all')state[existing?'updated':'added']++;
        changed=true;
      }
      if(changed){doc.updatedAt=new Date().toISOString();save(file,doc)}
    }
  }
  function key(item){return [item.role,item.parent||'',item.url].join('|')}
  async function processPending(){
    while(state.pending.length){
      const batch=state.pending.slice(0,6),products=[],children=[];
      for(const item of batch){
        const k=key(item);
        if(state.seen[k])continue;
        state.current=item.name||item.url;
        try{
          const {game}=await importGame(item.url);
          if(item.role==='root' && mode==='all'){
            Object.assign(game,await family(game));
            game.psFamilyComplete=true;
            const self=new Set(ids(game));
            for(const [role,related] of [['edition',game.editions],['addon',game.addons]]){
              for(const p of related)if(!self.has(p.id)){
                children.push({role,parent:String(game.conceptId),name:p.name,url:'https://store.playstation.com/ru-ua/product/'+p.id});
              }
            }
          }
          products.push({game,item});
          delete state.errors[k];
        }catch(error){state.errors[k]={...item,error:error.message}}
        await delay(150);
      }
      commit(products);
      for(const {item} of products)state.seen[key(item)]=true;
      state.pending.splice(0,batch.length);
      const queued=new Set(state.pending.map(key));
      for(const item of children){
        const k=key(item);
        if(!queued.has(k)&&!state.seen[k]){state.pending.push(item);queued.add(k)}
      }
      persist();
    }
  }
  function olderTitles(){
    const urls=new Map();
    const locales={UA:'ru-ua',TR:'en-tr',IN:'en-in',PL:'pl-pl',US:'en-us'};
    for(const file of Object.values(files))for(const row of load(file,{items:[]}).items){
      if(!/[а-яё]/i.test(row.name||''))continue;
      const entry=Object.entries(locales).find(([key])=>row.productIds?.[key]);
      const id=entry?row.productIds[entry[0]]:row.id;
      if(!/^[A-Z]{2}\d{4}-[A-Z0-9]{9}_\d{2}-[A-Z0-9]{16}$/.test(id))continue;
      const url='https://store.playstation.com/'+(entry?entry[1]:id.startsWith('UP')?'en-us':'ru-ua')+'/product/'+id;
      urls.set(id,{role:'title',url,name:row.name});
    }
    return [...urls.values()];
  }
  async function run(){
    if(active)return;
    active=true;
    try{
      while(true){
        await processPending();
        if(state.next==null){
          if(mode==='all' && !state.titlesChecked){
            state.pending=olderTitles();state.titlesChecked=true;persist();continue;
          }
          break;
        }
        let page;
        for(const size of [24,8,1]){
          try{page=await catalogPage(mode,state.next,size);break}
          catch(error){if(size===1)throw Error('Позиция '+(state.next+1)+': '+error.message);await delay(1500)}
        }
        state.position=state.next+page.items.length;
        state.next=page.next;state.pending=page.items;persist();
      }
      if(mode!=='all' && !Object.keys(state.errors).length){
        const doc=load(files[mode],{items:[]});
        const items=doc.items.filter(row=>row.psCollection!==mode || row.psCollectionRun===state.runId);
        if(items.length!==doc.items.length)save(files[mode],{...doc,items,updatedAt:new Date().toISOString()});
      }
      state.phase='done';state.current='';
    }catch(error){state.phase='paused';state.error=error.message}
    finally{active=false;persist()}
  }
  const launch=()=>setImmediate(()=>run().catch(error=>console.error(prefix,error.message)));
  admin(prefix+'-status',status);
  admin(prefix+'-start',({retry})=>{
    if(active||state.phase==='running')return status();
    if(state.phase!=='paused'){
      if(retry && state.phase==='done')state.pending=Object.values(state.errors);
      else state={runId:new Date().toISOString(),position:0,next:0,pending:[],seen:{},errors:{},added:0,updated:0};
    }
    state.phase='running';state.error='';persist();launch();return status();
  });
  if(state.phase==='running')launch();
}
module.exports={registerCatalog};
