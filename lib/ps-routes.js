const {importGame,collection,family}=require('./ps-import');

function attachImport(next,imported,edited={}){
 if(!imported||!imported.importedAt||!imported.productIds)return next;
 if(imported.names?.en){next.names={...imported.names};next.name=imported.names.en}
 next.psProductType=imported.psProductType||next.psProductType;
 next.productIds={...imported.productIds};next.conceptId=imported.conceptId;
 const family=next.psFamilyComplete&&!imported.psFamilyComplete?next.psStore:imported;
 next.editions=family?.editions||[];next.addons=family?.addons||[];
 if(imported.psFamilyComplete)next.psFamilyComplete=true;
 next.psStore={rating:imported.rating,ratingCount:imported.ratingCount,releaseDate:imported.releaseDate,publisher:imported.publisher,players:imported.players,updated:imported.importedAt,regions:imported.regions,editions:next.editions,addons:next.addons,mediaGallery:imported.mediaGallery||[]};
 for(const key of ['description','rating','ratingCount','publisher','releaseDate','players','mediaGallery'])
  if(next[key]==null||next[key]===''||(key==='ratingCount' && !next[key])||Array.isArray(next[key])&&!next[key].length)next[key]=imported[key];
 for(const [code,offer] of Object.entries(imported.regions)){
  const manual=edited[code]||{};
  next.regions[code]={...next.regions[code],...offer,...manual};
  if(offer.salePrice==null&&!(manual.salePrice>0))next.regions[code].salePrice=null;
  if(!Object.hasOwn(manual,'discountedUntil'))next.regions[code].discountedUntil=offer.discountedUntil;
 }
 return next
}

function register(app,{auth,read,readCached,write,files}){
 const admin=(route,operation)=>app.post('/api/admin/'+route,auth,async(req,res)=>{
  try{res.json(await operation(req.body||{}))}catch(e){res.status(400).json({ok:false,error:e.message||'Ошибка импорта'})}
 });
 admin('import',async({url})=>{
  const result=await importGame(url),game=result.game;
  if(game.psProductType!=='addon' && game.productIds.UA){
   Object.assign(game,await family(game),{psFamilyComplete:true});
  }
  return result;
 });
 admin('ps-collection',async({url})=>({ok:true,items:await collection(url)}));
 admin('ps-batch-item',async({url,refresh})=>{
  const {game}=await importGame(url);
  const doc=read(files.all,{items:[]});if(!Array.isArray(doc.items))throw Error('Некорректный файл каталога');
  const existing=doc.items.find(x=>x.id===game.id||Object.values(game.productIds).some(id=>id&&(x.id===id||Object.values(x.productIds||{}).includes(id))));
  if(existing&&!refresh)return {ok:true,name:existing.name,result:'Уже в каталоге'};
  const row={...existing,...game,id:existing?.id||game.id,regions:{...existing?.regions}};
  attachImport(row,game);if(existing)Object.assign(existing,row);else doc.items.unshift(row);
  write(files.all,{...doc,updatedAt:new Date().toISOString()});
  return {ok:true,name:game.name,result:existing?'Обновлено':'Добавлено',missing:Object.entries(game.regions).filter(([,v])=>v.salePrice==null).map(([c])=>c)}
 });
 require('./ps-catalog').registerCatalog(admin,files,attachImport);
}
module.exports={register,attachImport};
