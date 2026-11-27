'use strict';
const {parseProduct,parseProductRecords}=require('./product-data');
const regions={UA:['ru-ua','UAH'],TR:['en-tr','TRY'],US:['en-us','USD'],PL:['pl-pl','PLN'],IN:['en-in','INR']};
const categories={
 all:'28c9c2b2-cecc-415c-9a08-482a605cb104',
 preorder:'3bf499d7-7acf-4931-97dd-2667494ee2c9',
 new:'e1699f77-77e1-43ca-a296-26d08abacb0f'
};
const operations={
 conceptRetrieveForUpsellWithCtas:'afa38e2e1ad7f940532edf20e5e6229c5637e79f2360c4c26b41615d0645694f',
 getAddOnProductsByConcept:'92b4a31c2c82c44168ec1dbebaab6b811a5407e34700f78220c3e1240a4f16a6',
 getAddOnProductsByProductId:'890653e562447731f4e9e9d6c010738fea0cf0f12ba00bd76c4505c51c2cb9dc',
 metGetConceptById:'cc90404ac049d935afbd9968aef523da2b6723abfb9d586e5f77ebf7c5289006',
 metGetProductById:'a128042177bd93dd831164103d53b73ef790d56f51dae647064cb8f9d9fc9d1a',
 metGetPricingDataByConceptId:'abcb311ea830e679fe2b697a27f755764535d825b24510ab1239a4ca3092bd09',
 categoryGridRetrieve:'4ce7d410a4db2c8b635a48c1dcec375906ff63b19dadd87e073f8fd0c0481d35'
};
const productId=/^[A-Z]{2}\d{4}-[A-Z0-9]{9}_\d{2}-[A-Z0-9]{16}$/;
async function query(op,variables,locale){
 const endpoint='https://web.np.playstation.com/api/graphql/v1/op';
 const extensions={persistedQuery:{version:1,sha256Hash:operations[op]}};
 const params=new URLSearchParams({operationName:op,variables:JSON.stringify(variables),extensions:JSON.stringify(extensions)});
 const headers={'accept':'application/json','content-type':'application/json','x-psn-store-locale-override':locale.slice(0,3)+locale.slice(3).toUpperCase()};
 let getError;
 for(const method of ['GET','POST']){
  try{
   const url=method==='GET'?endpoint+'?'+params:endpoint;
   const body=method==='POST'?JSON.stringify({operationName:op,variables,extensions}):undefined;
   const r=await fetch(url,{method,body,headers,signal:AbortSignal.timeout(18000)});
   if(!r.ok)throw Error('HTTP '+r.status);
   const text=(await r.text()).trim();
   if(!text)throw Error('пустой ответ (HTTP '+r.status+')');
   let json;
   try{json=JSON.parse(text)}catch{throw Error('неполный или некорректный JSON (HTTP '+r.status+')')}
   if(!json?.data)throw Error('в ответе нет данных операции '+op);
   return json.data;
  }catch(error){
   if(method==='GET'){getError=error.message;continue}
   throw Error('PS Store ('+locale+'): GET — '+getError+', POST — '+error.message);
  }
 }
}
async function page(locale,kind,id){
 const records={};let html='';
 try{const r=await fetch('https://store.playstation.com/'+locale+'/'+kind+'/'+id,{signal:AbortSignal.timeout(15000)});if(r.ok)html=await r.text();
 for(const m of html.matchAll(/<script id="env:[^"]+"[^>]*>([\s\S]*?)<\/script>/g))for(const [k,v] of Object.entries(JSON.parse(m[1]).cache||{}))if(v&&typeof v==='object')Object.assign(records[k]??={},v);
 }catch{}return {records,html}
}
async function product(locale,id,known){
 const data=await page(locale,'product',id);
 let p=data.records['Product:'+id];if(!p?.platforms?.length)p=known||(await query('metGetProductById',{productId:id},locale)).productRetrieve;
 if(!p?.platforms?.length||p.id!==id)return null;
 return {...data,p}
}
function sameEdition(a,b){
 if(!a||!b)return false;if(a.id===b.id)return true;
 if(!a.edition?.type||a.edition.type!==b.edition?.type||[...(a.platforms||[])].sort().join()!==[...(b.platforms||[])].sort().join())return false;
 const name=p=>String(p.edition?.invariantName||p.invariantName||p.name||'').trim().toLowerCase();
 return name(a)!==''&&name(a)===name(b)
}
async function listAddons(locale,fields){
 const byConcept=Boolean(fields.conceptId);
 const operation=byConcept?'getAddOnProductsByConcept':'getAddOnProductsByProductId';
 const resultKey=byConcept?'addOnProductsRetrieve':'addOnProductsByProductIdRetrieve';
 const items=new Map();
 for(let offset=0;;){
  const data=await query(operation,{...fields,pageArgs:{size:48,offset}},locale);
  const rows=data[resultKey]?.addOnProducts;
  if(!Array.isArray(rows))throw Error('PS Store не вернул список дополнений.');
  const previous=items.size;
  for(const row of rows)items.set(row.id,row);
  if(rows.length<48)return [...items.values()];
  if(items.size===previous)throw Error('PS Store повторил страницу дополнений.');
  offset+=rows.length;
 }
}
async function resolveRegion(locale,cid,source){
 const direct=await product(locale,source.id).catch(()=>null);if(direct)return direct;
 if(source.topCategory==='ADD_ON'){
  const candidates=await listAddons(locale,{conceptId:String(cid)});
  const matches=candidates.filter(p=>source.invariantName && p.invariantName===source.invariantName &&
   p.storeDisplayClassification===source.storeDisplayClassification &&
   [...(p.platforms||[])].sort().join()===[...(source.platforms||[])].sort().join());
  return matches.length===1?product(locale,matches[0].id):null;
 }
 const listing=await page(locale,'concept',cid),c=listing.records['Concept:'+cid];
 const hits=(c?.products||[]).map(x=>listing.records[x.__ref]).filter(p=>sameEdition(source,p));
 if(hits.length===1)return product(locale,hits[0].id);
 const cp=(await query('metGetConceptById',{conceptId:cid},locale)).conceptRetrieve,other=cp?.defaultProduct;
 if(sameEdition(source,other))return product(locale,other.id,other);
 return null
}
function amount(s,currency){
 const pattern={USD:/\$|USD/i,TRY:/TL|TRY|₺/i,INR:/Rs|₹|INR/i,UAH:/UAH|₴/i,PLN:/PLN|z[łl]/i}[currency];
 if(!pattern.test(s||''))return null;
 const raw=s.replace(/[^\d.,]/g,'');if(!raw)return null;
 const n=Number(['USD','INR'].includes(currency)?raw.replaceAll(',',''):raw.replaceAll('.','').replace(',','.'));return Number.isFinite(n)?n:null
}
async function offer(data,locale,currency,cid){
 const id=data.p.id;const cta=Object.entries(data.records).find(([key,v])=>key.startsWith('GameCTA:')&&key.includes(id)&&key.endsWith(':OUTRIGHT')&&v.local?.priceOrText)?.[1].local;
 let salePrice=amount(cta?.priceOrText,currency),originalPrice=amount(cta?.originalPrice,currency),discountedUntil=cta?.offerAvailability||null;
 const publicCta=Object.entries(data.records).find(([key,c])=>key.startsWith('GameCTA:ADD_TO_CART:') && key.includes(':'+id+'-') && c.price?.currencyCode===currency && !c.price.isExclusive && !c.price.isTiedToSubscription && !c.price.serviceBranding?.some(tag=>tag!=='NONE'));
 if(publicCta){
  const price=publicCta[1].price;
  salePrice=amount(price.discountedPrice,currency)??salePrice;
  originalPrice=amount(price.basePrice,currency)??originalPrice;
  discountedUntil=price.endTime||discountedUntil;
 }
 if(salePrice===null){const cp=(await query('metGetPricingDataByConceptId',{conceptId:cid},locale).catch(()=>({}))).conceptRetrieve;
 const match=[cp?.defaultProduct,...(Array.isArray(cp?.selectableProducts)?cp.selectableProducts:cp?.selectableProducts?.purchasableProducts||[])].find(p=>p?.id===id);
 const price=match?.mobilectas?.find(c=>c.action?.param?.some(p=>p.name==='rewardId'&&p.values?.includes('OUTRIGHT')))?.price||match?.price;
 if(price?.currencyCode===currency&&!price.isExclusive&&!price.isTiedToSubscription){const value=price.discountedValue??price.basePriceValue;if(Number.isFinite(value))salePrice=amount(price.discountedPrice,currency)??value/(currency==='INR'?1:100);if(Number.isFinite(price.basePriceValue))originalPrice=amount(price.basePrice,currency)??price.basePriceValue/(currency==='INR'?1:100);discountedUntil=price.endTime||null}}
 if(/^\d{13}$/.test(String(discountedUntil)))discountedUntil=new Date(Number(discountedUntil)).toISOString();
 const ctas=Object.entries(data.records).filter(([key])=>key.startsWith('GameCTA:') && key.includes(id)).map(([,v])=>v);
 for(const ref of [...(data.p.webctas||[]),...(data.p.mobilectas||[])])ctas.push(data.records[ref.__ref]||ref);
 ctas.push(data.p);
 return {eaPlayOffer:require('./ea-price').memberOffer(ctas,currency),salePrice,originalPrice,currency,discountedUntil,discPerc:originalPrice>0&&salePrice!==null&&salePrice<originalPrice?Math.round((1-salePrice/originalPrice)*100):0}
}
function details(data){
 const {p,html,records}=data;if(records['Product:'+p.id]?.platforms?.length)return parseProduct(html,p.id);
 const normalized={...p,compatibilityNoticesByPlatform:{Common:p.compatibilityNotices||[]}};
 return parseProductRecords({['Product:'+p.id]:normalized},p.id,[...(p.media||[]),...(p.concept?.media||[])])
}
function languageCode(rows){if(rows.some(l=>l.voice))return 'voice';if(rows.some(l=>l.text))return 'text';return rows.length&&rows.every(l=>l.voice===false&&l.text===false)?'none':'unknown'}
async function importGame(url){
 const u=new URL(url);const m=u.pathname.match(/^\/([a-z]{2}-[a-z]{2})\/(product|concept)\/([^/]+)\/?$/i);if(u.hostname!=='store.playstation.com'||!m)throw Error('Укажите ссылку на игру или издание в PS Store.');
 const [,locale,kind,key]=m;let cid,source,ua;
 if(kind==='concept'&&/^\d+$/.test(key)){
  cid=key;let concept=(await query('metGetConceptById',{conceptId:cid},'ru-ua').catch(()=>({}))).conceptRetrieve;
  source=concept?.defaultProduct;if(!source){const {records}=await page('ru-ua','concept',cid);source=records[records['Concept:'+cid]?.defaultProduct?.__ref]}
  if(source?.id)ua=await product('ru-ua',source.id,source).catch(()=>null)
 }else if(kind==='product'&&productId.test(key)){
  const initial=await product(locale,key);source=initial?.p;cid=source?.concept?.id||source?.concept?.__ref?.split(':')[1];
  if(cid)ua=locale==='ru-ua'?initial:await resolveRegion('ru-ua',cid,source).catch(()=>null)
 }
 let baseLocale='ru-ua';
 if(!ua && locale!=='ru-ua' && Object.values(regions).some(([loc])=>loc===locale)){
  baseLocale=locale;
  if(kind==='concept'){
   const local=(await query('metGetConceptById',{conceptId:cid},locale)).conceptRetrieve?.defaultProduct;
   if(local?.id)ua=await product(locale,local.id,local);
  }else ua=await product(locale,key);
 }
 if(!ua||!cid)throw Error('PS Store не вернул подтверждённую карточку игры.');
 const base=details(ua),offers={},ids={},titles={},editionNames={};await Promise.all(Object.entries(regions).map(async ([code,[loc,currency]])=>{
  offers[code]={currency,salePrice:null,originalPrice:null,discPerc:0,discountedUntil:null,ru:'unknown',languages:[],platforms:[]};ids[code]=null;
  try{const d=loc===baseLocale?ua:await resolveRegion(loc,cid,ua.p);if(!d)return;ids[code]=d.p.id;titles[code]=d.p.name;if(loc.startsWith("en-"))editionNames[code]=d.p.edition?.name;const languages=details(d).languages;Object.assign(offers[code],require("./subscription-access").subscriptionOffers(d,loc),{languages,ru:languageCode(languages),platforms:d.p.platforms},await offer(d,loc,currency,cid))}catch{}
 }));
 let nameEn=[titles.TR,titles.US,titles.IN].find(n=>n&&!/[а-яё]/i.test(n));
 if(!nameEn)nameEn=(await product('en-gb',ua.p.id).catch(()=>null))?.p?.name;
 if(!nameEn||/[а-яё]/i.test(nameEn))nameEn=ua.p.invariantName;
 if(!nameEn||/[а-яё]/i.test(nameEn))throw Error('PS Store не предоставил английское название издания.');
 const names={en:nameEn,ru:titles.UA||null};
 const g={psProductType:ua.p.topCategory==="ADD_ON" || ua.p.type==="ADD_ON"?"addon":"game",names,id:ids.TR||ua.p.id,conceptId:cid,productIds:ids,name:nameEn,platform:base.platforms.join(' / '),edition:require("./edition-name").englishEdition({editionEn:editionNames.US||editionNames.TR||editionNames.IN||ua.p.edition?.invariantName,edition:base.edition,names}),players:base.players?(Number(base.players)>1?'1 - '+base.players+' игроков':String(base.players)==='1'?'1 игрок':String(base.players)):null,cover:base.cover,description:base.description,rating:base.rating??null,ratingCount:base.count??null,publisher:ua.p.publisherName||null,releaseDate:base.release?.slice(0,10)||null,genres:(ua.p.localizedGenres||ua.p.combinedLocalizedGenres||[]).map(x=>x.value).join(', '),mediaGallery:[...base.videos.map(url=>({type:'video',url})),...base.screens.map(url=>({type:'image',url}))],editions:base.editions,addons:base.addons,regions:offers,importedAt:new Date().toISOString()};
 const {regions:regionalData,editions,addons,...common}=g;
 const parsed={};for(const code of Object.keys(regions))parsed[code]={...common,...offers[code],blocked:false};
 return {ok:true,game:g,productId:g.id,productIds:ids,parsed,status:Object.fromEntries(Object.entries(ids).map(([c,id])=>[c,id?200:null]))}
}
async function collection(url){
 const u=new URL(url);const m=u.pathname.match(/^\/[a-z]{2}-[a-z]{2}\/category\/([\da-f-]{36})(?:\/(\d+))?\/?$/i);if(u.hostname!=='store.playstation.com'||!m)throw Error('Нужна ссылка на страницу подборки PS Store.');
 const n=Number(m[2]||1);if(!Number.isSafeInteger(n)||n<1)throw Error('Некорректный номер страницы.');
 const grid=(await query('categoryGridRetrieve',{id:m[1],pageArgs:{size:24,offset:(n-1)*24}},'ru-ua')).categoryGridRetrieve;
 if(!grid)throw Error('PS Store не вернул подборку.');
 const concepts=grid.concepts?.length;return (concepts?grid.concepts:grid.products||[]).map(x=>({name:x.name,url:'https://store.playstation.com/ru-ua/'+(concepts?'concept':'product')+'/'+x.id}))
}
async function catalogPage(mode,offset,size=24){
 const limit=mode==='all'?50*24:Infinity;
 if(offset>=limit)return {items:[],next:null};
 const grid=(await query('categoryGridRetrieve',{
  id:categories[mode],pageArgs:{offset,size:Math.min(size,limit-offset)}
 },'ru-ua')).categoryGridRetrieve;
 if(!grid?.pageInfo || grid.pageInfo.offset!==offset)throw Error('PS Store не подтвердил страницу каталога.');
 const {totalCount,isLast}=grid.pageInfo;
 const concepts=Boolean(grid.concepts?.length);
 const entries=concepts?grid.concepts:grid.products||grid.concepts;
 if(!Array.isArray(entries)||(!entries.length && offset<totalCount))throw Error('PS Store вернул неполную страницу.');
 const items=entries.slice(0,limit-offset).map(g=>({url:'https://store.playstation.com/ru-ua/'+(concepts?'concept':'product')+'/'+g.id,name:g.name,role:'root'}));
 const end=offset+items.length;
 return {items,next:isLast||end>=Math.min(totalCount,limit)?null:end};
}
async function family(game){
 const id=game.productIds.UA;
 if(!id)throw Error('Не определено украинское издание для поиска дополнений.');
 const concept=(await query('conceptRetrieveForUpsellWithCtas',{conceptId:String(game.conceptId)},'ru-ua')).conceptRetrieve;
 if(!concept||!Array.isArray(concept.products))throw Error('PS Store не вернул список изданий.');
 const editions=new Map([...game.editions,...concept.products].map(p=>[p.id,{id:p.id,name:p.name,edition:p.edition?.name||p.edition,platforms:p.platforms}]));
 const addons=new Map(game.addons.map(p=>[p.id,p]));
 for(const product of new Set([id,...editions.keys()])){
  for(const p of await listAddons('ru-ua',{productId:product})){
   addons.set(p.id,{id:p.id,name:p.name,platforms:p.platforms});
  }
 }
 return {editions:[...editions.values()],addons:[...addons.values()]};
}
module.exports={query,importGame,collection,catalogPage,family};
