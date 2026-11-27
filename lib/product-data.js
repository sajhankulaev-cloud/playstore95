function parseProduct(html,id){
 const records={},media=new Map();
 for(const match of html.matchAll(/<script id="env:[^"]+"[^>]*>([\s\S]*?)<\/script>/g)){
  const data=JSON.parse(match[1]).cache||{};
  for(const [key,v] of Object.entries(data)){
   if(!v||typeof v!=='object')continue;
   Object.assign(records[key]??={},v);
   if(key==='Product:'+id)for(const m of v.media||[])media.set(m.url,m);
  }
 }
 return parseProductRecords(records,id,[...media.values()],html)
}
function parseProductRecords(records,id,images,html=''){
 const p=records['Product:'+id];if(!p?.name||!p.platforms)throw Error('Нет данных товара');
 const cp=records[p.concept?.__ref]||{}, root=records.ROOT_QUERY||{};
 const resolve=refs=>(refs||[]).map(r=>records[r.__ref]).filter(Boolean).map(v=>({id:v.id,name:v.name,edition:v.edition?.name,platforms:v.platforms||[],features:v.edition?.features||[]}));
 const addons=Object.entries(root).find(([k])=>k.startsWith('addOnProducts'))?.[1]?.addOnProducts;
 const art=role=>images.find(m=>m.role===role)?.url;
 const lang=(field,platform)=>{const row=p[field+'ByPlatform']?.find(x=>x.platform===platform);const langs=row?.[field]??(!p[field+'ByPlatform']?.length?p[field]:null);return langs?.length?langs.includes('ru'):null};
 const strip=s=>(s||'').replace(/<br\s*\/?\s*>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').trim();
 let deal=null;
 for(const m of html.matchAll(/data-qa="mfeCtaMain#(offer\d+)#discountBadge#text"[^>]*>([^<]*)</g)){
  const percent=m[2].match(/(\d+)\s*%/);const end=html.match(new RegExp('data-qa="mfeCtaMain#'+m[1]+'#discountDescriptor"[^>]*>[^<]*?(\\d+)\\.(\\d+)\\.(\\d{4}) (\\d+):(\\d+) (AM|PM) UTC'));
  if(percent&&end){let [,d,mo,y,h,mi,am]=end;deal={percent:Number(percent[1]),end:Date.UTC(+y,+mo-1,+d,+h%12+(am==='PM'?12:0),+mi)};break}
 }
 return {id,name:p.name,edition:p.edition?.name,platforms:p.platforms,rating:p.starRating?.averageRating,count:p.starRating?.totalRatingsCount,release:p.releaseDate,preorder:p.webctas?.some(c=>c.meta?.preOrder),deal,players:Object.values(p.compatibilityNoticesByPlatform||{}).flat().find(x=>x?.type==='NO_OF_PLAYERS')?.value,languages:p.platforms.map(platform=>({platform,voice:lang('spokenLanguages',platform),text:lang('screenLanguages',platform)})),description:strip(p.descriptions?.find(d=>d.type==='LONG')?.value||p.descriptions?.find(d=>d.type==='SHORT')?.value),cover:art('MASTER')||art('EDITION_KEY_ART'),banner:art('BACKGROUND')||art('GAMEHUB_COVER_ART'),screens:images.filter(m=>m.role==='SCREENSHOT').map(m=>m.url),videos:images.filter(m=>m.type==='VIDEO'&&m.url.includes('.mp4')).map(m=>m.url),editions:resolve(cp.products),addons:resolve(addons),updated:new Date().toISOString()}
}

module.exports={parseProduct,parseProductRecords};
