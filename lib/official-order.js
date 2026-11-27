const fs = require('fs');
const path = require('path');
const {query} = require('./ps-import');
const locales = {TR:'en-tr', UA:'ru-ua', PL:'pl-pl', IN:'en-in', US:'en-us'};
const categories = {browse:'28c9c2b2-cecc-415c-9a08-482a605cb104',best:'132bb05e-89dc-4e66-966d-1297b045e21d'};
const memory = new Map(), pending = new Map(), retries = new Map();
async function download(region, kind, fetchGrid = query){
  const entries = [];
  for(let offset=0;;){
    const {categoryGridRetrieve:grid} = await fetchGrid('categoryGridRetrieve',{id:categories[kind],pageArgs:{offset,size:100}},locales[region]);
    if(grid?.pageInfo?.offset!==offset)throw Error('PS Store: неверная страница рейтинга');
    const concepts = !!grid.concepts?.length;
    const rows = concepts ? grid.concepts : grid.products || [];
    for(const row of rows){
      const ids = concepts ? (row.products||[]).map(p=>p.id) : [row.id];
      const entry={id:String(row.id),products:ids};
      if(kind==='best'){
        entry.name=row.name;entry.cover=(row.media||[]).find(m=>m.role==='GAMEHUB_COVER_ART')?.url || (row.media||[]).find(m=>m.type==='IMAGE')?.url;
      }
      entries.push(entry);
    }
    offset+=rows.length;
    if(grid.pageInfo.isLast || offset>=grid.pageInfo.totalCount)break;
    if(!rows.length)throw Error('PS Store: неполный рейтинг');
  }
  if(!entries.length)throw Error('PS Store: пустой рейтинг');
  return {updatedAt:new Date().toISOString(),entries};
}
function load(region, kind){
  if(!Object.hasOwn(locales,region))region='TR';
  const key=kind+'-'+region;
  const file=path.join(__dirname,'../data','rank-'+key+'.json');
  function index(doc){
    const ranks=new Map();
    doc.entries.forEach((e,i)=>{for(const id of [e.id,...e.products])if(!ranks.has(id))ranks.set(id,i+1)});
    return {...doc,ranks};
  }
  if(!memory.has(key)){
    let doc;for(const p of [file,path.join(__dirname,'rankings',key+'.json')]){
      try{doc=JSON.parse(fs.readFileSync(p));if(doc.entries.length)break}catch{}
    }
    memory.set(key,index(doc?.entries?doc:{entries:[]}));
  }
  const cached=memory.get(key);
  if((!cached.updatedAt || Date.now()-Date.parse(cached.updatedAt)>86400000) && !pending.has(key) && Date.now()>(retries.get(key)||0)){
    const job=download(region,kind).then(doc=>{
      const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(doc));fs.renameSync(tmp,file);
      memory.set(key,index(doc));
    }).catch(()=>retries.set(key,Date.now()+300000)).finally(()=>pending.delete(key));
    pending.set(key,job);
  }
  return cached;
}
module.exports={download,load,locales};
