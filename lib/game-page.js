const {sonyVideo,sendTrailer}=require('./trailer');
const {englishEdition}=require('./edition-name');
const {addon}=require('./catalog-visibility');
function familyIds(game){
  return [game.conceptId,...String(game.additionalConceptIds || '').split(','),...(game.psParentConcepts||[])].map(v=>String(v||'').trim()).filter(Boolean);
}
function registerGamePage(app, deps) {
  const { files, read, signature, context, price, ruStatus, indexPage } = deps;
  let version, catalog;
  function records() {
    const next = signature(Object.values(files));
    if (next === version) return catalog;
    const byId = new Map(), families = new Map(), references = new Map();
    for (const [source,file] of Object.entries(files)) {
      for (const game of read(file,{items:[]}).items || []) {
        const ids = [game.id,...Object.values(game.productIds || {})].filter(Boolean).map(String);
        const entry = ids.map(id=>byId.get(id)).find(Boolean) || {game,source};
        for (const id of ids) byId.set(id,entry);
        for (const cid of familyIds(game)) {
          const key=String(cid);
          if (!families.has(key)) families.set(key,new Set());
          families.get(key).add(entry);
        }
        if (game.conceptId && (game.addons?.length || game.psStore?.addons?.length)) {
          const key=String(game.conceptId);
          if(!references.has(key)) references.set(key,new Set());
          for(const a of [...(game.addons||[]),...(game.psStore?.addons||[])]) references.get(key).add(String(a.id));
        }
      }
    }
    version=next;catalog={byId,families,references};return catalog;
  }
  app.get(['/game/:id','/ps95_optovik/game/:id'],(req,res)=>{
    if(!records().byId.has(req.params.id))res.status(404);
    res.sendFile(indexPage);
  });
  const gallery=g=>g?.mediaGallery || g?.psStore?.mediaGallery || [];
  app.get('/api/trailer/:id/:index',(req,res)=>{
    const g=records().byId.get(req.params.id)?.game;
    const item=gallery(g)[Number(req.params.index)];
    if(item?.type!=='video')return res.sendStatus(404);
    return sendTrailer(req,res,String(item.url).replace(/^http:/,'https:'));
  });
  app.get('/api/game-page/:id',(req,res)=>{
    const {byId,families,references}=records(),entry=byId.get(req.params.id);
    if(!entry)return res.status(404).json({error:'Игра не найдена'});
    const region=String(req.query.region || 'TR').toUpperCase(),ctx=context(region);
    const raw=entry.game,related=new Set(),addonIds=new Set();
    for(const cid of familyIds(raw)){
      for(const item of families.get(cid)||[])related.add(item);
      for(const id of references.get(cid)||[])addonIds.add(id);
    }
    for(const ref of [...(raw.editions||raw.psStore?.editions||[]),...addonIds]){
      const linked=byId.get(String(ref.id||ref));if(linked)related.add(linked);
    }
    function card(item){
      const g=item.game,offer=price(g,region,item.source,ctx);
      return {...offer,id:g.id,name:g.names?.en||g.name,cover:g.cover,edition:englishEdition(g),platform:g.platform,
        finalPriceRub:offer?.finalPriceRub||null};
    }
    const editions=[],addons=[];
    for(const item of related){
      if(item===entry)continue;
      const g=item.game,c=card(item);
      if(addon(g)||addonIds.has(String(g.id))||Object.values(g.productIds||{}).some(id=>addonIds.has(String(id)))){
        if(c.finalPriceRub>0 || (region==="US" && c.storePrice>0))addons.push(c);
      }else editions.push(c);
    }
    res.json({...card(entry),subscriptions:require("./subscription-access").labels(raw.regions?.[region]),isAddon:addon(raw)||addonIds.has(String(raw.id)),genres:raw.genres,description:raw.description,releaseDate:raw.releaseDate,publisher:raw.publisher,
      rating:raw.rating??raw.psStore?.rating,ratingCount:raw.ratingCount??raw.psStore?.ratingCount,
      players:raw.players,ru:ruStatus(raw,region),languages:raw.regions?.[region]?.languages||[],
      mediaGallery:gallery(raw).map((m,i)=>m.type==='video' && sonyVideo(String(m.url).replace(/^http:/,'https:'))?{...m,url:'/api/trailer/'+encodeURIComponent(raw.id)+'/'+i}:m),editions,addons});
  });
}
module.exports={registerGamePage};
