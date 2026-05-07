const fs = require("fs");
const https = require("https");
const path = require("path");
const express = require("express");
const crypto = require("crypto");
let sharp = null;
try{ sharp = require("sharp"); }catch(_e){ sharp = null; }

const app = express();

const IMAGE_CACHE_DIR = path.join(__dirname, "data", "image_cache");
try{ fs.mkdirSync(IMAGE_CACHE_DIR, { recursive:true }); }catch(_e){}

// --- PlayStation Browse rank ("All games" page order) helpers ---
// We assign popRank to match the ordering on https://store.playstation.com/<locale>/pages/browse
// by scraping browse pages and finding the game's position.

const PS_BROWSE_CACHE_PATH = path.join(__dirname, "data", "ps_browse_rank_cache.json");
const PS_BROWSE_PAGE_SIZE_GUESS = 24; // PS Store browse commonly shows 24 tiles per page
const PS_BROWSE_MAX_PAGES_HARD_LIMIT = 500; // safety

// --- PlayStation Pre-orders category rank helpers ---
// Category page example (TR):
// https://store.playstation.com/en-tr/category/3bf499d7-7acf-4931-97dd-2667494ee2c9/1
const PS_PREORDERS_CACHE_PATH = path.join(__dirname, "data", "ps_preorders_rank_cache.json");
const PS_PREORDERS_CATEGORY_ID = "3bf499d7-7acf-4931-97dd-2667494ee2c9";
const PS_PREORDERS_PAGE_SIZE_GUESS = 24;

// --- PlayStation New Releases category rank helpers ---
// Category page example (TR):
// https://store.playstation.com/en-tr/category/e1699f77-77e1-43ca-a296-26d08abacb0f/1
const PS_NEW_RELEASES_CACHE_PATH = path.join(__dirname, "data", "ps_new_releases_rank_cache.json");
const PS_NEW_RELEASES_CATEGORY_ID = "e1699f77-77e1-43ca-a296-26d08abacb0f";
const PS_NEW_RELEASES_PAGE_SIZE_GUESS = 24;
const PS_NEW_RELEASES_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// --- EA Play "The Play List" category rank helpers ---
// Category page example (TR):
// https://store.playstation.com/en-tr/category/74d4e266-5c64-4c61-a7e3-1b6e78f643e6/1
const PS_EAPLAY_CACHE_PATH = path.join(__dirname, "data", "ps_eaplay_rank_cache.json");
const VISITORS_PATH = path.join(__dirname, "data", "visitors.json");
const PS_EAPLAY_CATEGORY_ID = "74d4e266-5c64-4c61-a7e3-1b6e78f643e6";
const PS_EAPLAY_PAGE_SIZE_GUESS = 24;

// Normalize a title to the "base" game name (without edition/platform suffixes).
// This is critical to match PS Browse titles like "EA SPORTS FC™ 26" with
// internal items like "EA SPORTS FC™ 26 Standard Edition PS4 & PS5".
function baseTitleForRank(name){
  let s = String(name || "");
  // remove common platform suffixes
  s = s.replace(/\s*\(\s*playstation\s*\S*\s*\)\s*$/i, "");
  s = s.replace(/\s*\(?\s*ps\s*4\s*&\s*ps\s*5\s*\)?\s*$/i, "");
  s = s.replace(/\s*\(?\s*ps4\s*&\s*ps5\s*\)?\s*$/i, "");
  s = s.replace(/\s*\(?\s*ps4\s*and\s*ps5\s*\)?\s*$/i, "");
  s = s.replace(/\s*(PS4™\s*&\s*PS5™)\s*$/i, "");
  s = s.replace(/\s*\(?\s*ps4\s*\/\s*ps5\s*\)?\s*$/i, "");

  // remove common edition suffixes
  // (strip only at the end to avoid breaking titles like "Ultimate Chicken Horse")
  s = s.replace(/\s*[-–—:]?\s*(digital\s+deluxe|deluxe|ultimate|standard|premium|gold|complete|definitive|collector'?s|vault)\s+(edition|bundle)\s*$/i, "");
  s = s.replace(/\s*\((digital\s+deluxe|deluxe|ultimate|standard|premium|gold|complete|definitive|collector'?s|vault)\s+(edition|bundle)\)\s*$/i, "");
  s = s.replace(/\s*[-–—:]?\s*(cross-?gen\s+bundle|premium\s+bundle)\s*$/i, "");

  // trim separators
  s = s.replace(/[\s\-–—:]+$/g, "").trim();
  return s;
}

function readPsBrowseCache(){
  try{
    const raw = fs.readFileSync(PS_BROWSE_CACHE_PATH, "utf-8");
    const j = JSON.parse(raw);
    if(!j || typeof j !== "object") return { updatedAt:null, locale:"", ranksByName:{}, ranksById:{} };
    // Backward compatible: previously we stored only "ranks" keyed by normalized name.
    if(j.ranks && !j.ranksByName) j.ranksByName = j.ranks;
    if(!j.ranksByName || typeof j.ranksByName !== "object") j.ranksByName = {};
    if(!j.ranksById || typeof j.ranksById !== "object") j.ranksById = {};
    return j;
  }catch{
    return { updatedAt:null, locale:"", ranksByName:{}, ranksById:{} };
  }
}
function writePsBrowseCache(obj){
  try{ fs.writeFileSync(PS_BROWSE_CACHE_PATH, JSON.stringify(obj, null, 2), "utf-8"); }catch(_e){}
}

function readPsPreordersCache(){
  try{
    const raw = fs.readFileSync(PS_PREORDERS_CACHE_PATH, "utf-8");
    const j = JSON.parse(raw);
    if(!j || typeof j !== "object") return { updatedAt:null, locale:"", ranksByName:{}, ranksById:{} };
    if(j.ranks && !j.ranksByName) j.ranksByName = j.ranks;
    if(!j.ranksByName || typeof j.ranksByName !== "object") j.ranksByName = {};
    if(!j.ranksById || typeof j.ranksById !== "object") j.ranksById = {};
    return j;
  }catch{
    return { updatedAt:null, locale:"", ranksByName:{}, ranksById:{} };
  }
}
function writePsPreordersCache(obj){
  try{ fs.writeFileSync(PS_PREORDERS_CACHE_PATH, JSON.stringify(obj, null, 2), "utf-8"); }catch(_e){}
}

function readPsEaPlayCache(){
  try{
    const raw = fs.readFileSync(PS_EAPLAY_CACHE_PATH, "utf-8");
    const j = JSON.parse(raw);
    if(!j || typeof j !== "object") return { updatedAt:null, locale:"", ranksByName:{}, ranksById:{} };
    if(j.ranks && !j.ranksByName) j.ranksByName = j.ranks;
    if(!j.ranksByName || typeof j.ranksByName !== "object") j.ranksByName = {};
    if(!j.ranksById || typeof j.ranksById !== "object") j.ranksById = {};
    return j;
  }catch{
    return { updatedAt:null, locale:"", ranksByName:{}, ranksById:{} };
  }
}
function writePsEaPlayCache(obj){
  try{ fs.writeFileSync(PS_EAPLAY_CACHE_PATH, JSON.stringify(obj, null, 2), "utf-8"); }catch(_e){}
}

function readPsNewReleasesCache(){
  try{
    const raw = fs.readFileSync(PS_NEW_RELEASES_CACHE_PATH, "utf-8");
    const j = JSON.parse(raw);
    if(!j || typeof j !== "object") return { updatedAt:null, locale:"", order:[] };
    if(!Array.isArray(j.order)) j.order = Array.isArray(j.ids) ? j.ids : [];
    return j;
  }catch{
    return { updatedAt:null, locale:"", order:[] };
  }
}
function writePsNewReleasesCache(obj){
  try{ fs.writeFileSync(PS_NEW_RELEASES_CACHE_PATH, JSON.stringify(obj, null, 2), "utf-8"); }catch(_e){}
}
function sameDayIso(a, b){
  if(!a || !b) return false;
  try{
    return String(a).slice(0,10) === String(b).slice(0,10);
  }catch{ return false; }
}

async function fetchText(url, opts = {}){
  const headers = Object.assign({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": opts.acceptLanguage || "ru-UA,ru;q=0.9,en;q=0.8",
  }, opts.headers || {});
  // Prevent hanging requests (e.g. slow/blocked networks) from freezing "Add" in admin.
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 8000;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error("fetch_timeout")), timeoutMs);
  let r;
  try{
    r = await fetch(url, { method:"GET", headers, signal: ac.signal });
  }finally{
    clearTimeout(t);
  }
  if(!r.ok) throw new Error("HTTP " + r.status);
  return await r.text();
}

function withTimeout(promise, ms){
  const timeoutMs = Math.max(0, Number(ms) || 0);
  if(timeoutMs <= 0) return promise;
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs))
  ]);
}


// --- PS Store RU-UA descriptions ---
function decodeHtmlEntities(s){
  return String(s||'')
    .replace(/&nbsp;/g,' ')
    .replace(/&amp;/g,'&')
    .replace(/&quot;/g,'"')
    .replace(/&#39;/g,"'")
    .replace(/&lt;/g,'<')
    .replace(/&gt;/g,'>')
    .replace(/&#x([0-9a-f]+);/gi, (_,h)=>{ try{return String.fromCharCode(parseInt(h,16));}catch{return _;} })
    .replace(/&#(\d+);/g, (_,d)=>{ try{return String.fromCharCode(parseInt(d,10));}catch{return _;} });
}
function cleanPsDescriptionText(v){
  let s = String(v||'');
  try{ s = JSON.parse('"' + s.replace(/"/g,'\\"') + '"'); }catch(_e){}
  s = decodeHtmlEntities(s);
  s = s.replace(/<br\s*\/?>/gi,'\n');
  s = s.replace(/<\/p>/gi,'\n\n');
  s = s.replace(/<[^>]+>/g,' ');
  s = s.replace(/\\n/g,'\n').replace(/\\r/g,'');
  s = s.replace(/[ \t]+/g,' ');
  s = s.replace(/\n[ \t]+/g,'\n').replace(/[ \t]+\n/g,'\n');
  s = s.replace(/\n{3,}/g,'\n\n').trim();
  return s;
}

function preserveAdminDescriptionText(v){
  let s = String(v||'');
  try{ s = JSON.parse('"' + s.replace(/"/g,'\\"') + '"'); }catch(_e){}
  s = decodeHtmlEntities(s);
  s = s.replace(/<br\s*\/?>/gi,'\n');
  s = s.replace(/<\/p>/gi,'\n\n');
  s = s.replace(/<[^>]+>/g,'');
  s = s.replace(/\\n/g,'\n').replace(/\\r/g,'');
  s = s.replace(/\r\n?/g,'\n');
  s = s.replace(/\n{4,}/g,'\n\n\n');
  return s.trim();
}
function isGoodPsDescription(s){
  s = cleanPsDescriptionText(s);
  if(!s || s.length < 60 || s.length > 5000) return false;
  if(!/[А-Яа-яЁё]/.test(s)) return false;
  const bad = [
    '__typename','priceCurrencyCode','Product:','ROOT_QUERY','ADD_TO_CART','UAH','TRY',
    'Добавить в корзину','Добавить в список пожеланий','Издания:','Скидка с исходной цены',
    'Минимальная цена за последние 30','Предложение заканчивается',
    'Условия использования программного обеспечения','Политика отмены PS Store','Меры предосторожности','О рейтингах',
    'Facebook','Instagram','Приложение для Android','Приложение для iOS','© 2026 Sony',
    'Центр настроек конфиденциальности','Ваша конфиденциальность','файлы cookie','cookie',
    'YouTube is a Google owned platform'
  ];
  const low = s.toLowerCase();
  if(bad.some(x => low.includes(String(x).toLowerCase()))) return false;
  // reject obvious JSON / page dump
  const jsonPunct = (s.match(/[{}\[\]"]/g)||[]).length;
  if(jsonPunct > 20) return false;
  return true;
}
function extractJsonStringValuesByKey(html, keys){
  const out = [];
  const keyRe = keys.map(k=>k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
  const re = new RegExp('"(' + keyRe + ')"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"','gi');
  let m;
  while((m = re.exec(String(html||''))) !== null){
    try{
      const val = JSON.parse('"' + m[2] + '"');
      out.push({ key:m[1], value:val });
    }catch(_e){
      out.push({ key:m[1], value:m[2] });
    }
  }
  return out;
}
function extractPsDescriptionFromHtml(html){
  const candidates = [];
  const push = (value, source)=>{
    const text = cleanPsDescriptionText(value);
    if(isGoodPsDescription(text)) candidates.push({ text, source });
  };

  // 1) JSON-LD description: useful when PS exposes it, but still filtered strictly.
  try{
    const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while((m = re.exec(String(html||''))) !== null){
      const raw = decodeHtmlEntities(m[1]||'').trim();
      const j = JSON.parse(raw);
      const arr = Array.isArray(j) ? j : [j];
      for(const it of arr){
        if(it && typeof it === 'object' && it.description) push(it.description, 'jsonld.description');
      }
    }
  }catch(_e){}

  // 2) Embedded PS/Apollo JSON values. Never take plain page text, otherwise footer/cookie text is captured.
  for(const c of extractJsonStringValuesByKey(html, [
    'longDescription','description','shortDescription','productDescription','overview','about'
  ])){
    push(c.value, c.key);
  }

  // Prefer the longest clean Russian description. Short meta descriptions lose to full text.
  candidates.sort((a,b)=> b.text.length - a.text.length);
  return candidates.length ? candidates[0].text : '';
}
function hasUsableDescription(g){
  return isGoodPsDescription(g && g.description ? g.description : '');
}

function publicDescriptionFromValue(v){
  const text = cleanPsDescriptionText(v || '');
  if(!text) return '';
  // Keep admin-entered short descriptions, but never allow PS page dumps/footer/cookies.
  const low = text.toLowerCase();
  const bad = [
    '__typename','pricecurrencycode','product:','root_query','add_to_cart','uah','try',
    'добавить в корзину','добавить в список пожеланий','издания:','скидка с исходной цены',
    'минимальная цена за последние 30','предложение заканчивается',
    'условия использования программного обеспечения','политика отмены ps store','меры предосторожности','о рейтингах',
    'facebook','instagram','приложение для android','приложение для ios','© 2026 sony',
    'центр настроек конфиденциальности','ваша конфиденциальность','файлы cookie','cookie',
    'youtube is a google owned platform'
  ];
  if(bad.some(x => low.includes(x))) return '';
  const jsonPunct = (text.match(/[{}\[\]"]/g)||[]).length;
  if(jsonPunct > 20) return '';
  return text;
}
function buildDescriptionIndex(){
  const idx = new Map();
  const add = (g)=>{
    if(!g) return;
    const desc = publicDescriptionFromValue(g.description || '');
    if(!desc) return;
    const keys = [];
    if(g.id) keys.push(String(g.id).trim());
    if(g.conceptId) keys.push('concept:' + String(g.conceptId).trim());
    if(g.productIds && typeof g.productIds === 'object'){
      for(const v of Object.values(g.productIds)){ if(v) keys.push(String(v).trim()); }
    }
    for(const k of keys){
      if(!k) continue;
      const prev = idx.get(k) || '';
      if(desc.length > prev.length) idx.set(k, desc);
    }
  };
  for(const file of [ALL_GAMES_PATH, PREORDERS_PATH, GAMES_PATH]){
    const doc = readJson(file, { items:[] });
    const arr = Array.isArray(doc) ? doc : (Array.isArray(doc.items) ? doc.items : []);
    arr.forEach(add);
  }
  return idx;
}
function descriptionForPublicGame(g, descIndex){
  const own = publicDescriptionFromValue(g && g.description ? g.description : '');
  if(own) return own;
  const idx = descIndex || buildDescriptionIndex();
  const keys = [];
  if(g && g.id) keys.push(String(g.id).trim());
  if(g && g.conceptId) keys.push('concept:' + String(g.conceptId).trim());
  if(g && g.productIds && typeof g.productIds === 'object'){
    for(const v of Object.values(g.productIds)){ if(v) keys.push(String(v).trim()); }
  }
  for(const k of keys){
    const v = idx.get(k);
    if(v) return v;
  }
  return '';
}
function buildConceptIndex(){
  const idx = new Map();
  const add = (g)=>{
    if(!g || !g.conceptId) return;
    const cid = String(g.conceptId).trim();
    if(!cid) return;
    if(g.id) idx.set(String(g.id).trim(), cid);
    if(g.productIds && typeof g.productIds === 'object'){
      for(const v of Object.values(g.productIds)){ if(v) idx.set(String(v).trim(), cid); }
    }
  };
  for(const file of [ALL_GAMES_PATH, PREORDERS_PATH, GAMES_PATH]){
    const doc = readJson(file, { items:[] });
    const arr = Array.isArray(doc) ? doc : (Array.isArray(doc.items) ? doc.items : []);
    arr.forEach(add);
  }
  return idx;
}
function conceptForGame(g, conceptIndex){
  const own = String((g && g.conceptId) || '').trim();
  if(own) return own;
  const idx = conceptIndex || buildConceptIndex();
  if(g && g.id && idx.get(String(g.id).trim())) return idx.get(String(g.id).trim());
  if(g && g.productIds && typeof g.productIds === 'object'){
    for(const v of Object.values(g.productIds)){
      const cid = idx.get(String(v||'').trim());
      if(cid) return cid;
    }
  }
  return '';
}
function normalizeAdditionalConceptIds(value){
  const raw = Array.isArray(value) ? value.join(',') : String(value || '');
  const seen = new Set();
  return raw
    .split(',')
    .map(x => String(x || '').trim())
    .filter(Boolean)
    .filter(x => { if(seen.has(x)) return false; seen.add(x); return true; });
}
function conceptIdsForGame(g, conceptIndex){
  const ids = [];
  const add = (v)=>{
    const s = String(v || '').trim();
    if(s && !ids.includes(s)) ids.push(s);
  };
  add(conceptForGame(g, conceptIndex));
  for(const cid of normalizeAdditionalConceptIds(g && g.additionalConceptIds)) add(cid);
  return ids;
}
function pickUaProductId(g){
  return String((g && g.productIds && (g.productIds.UA || g.productIds.TR)) || (g && g.id) || '').trim();
}
async function fetchGameDescriptionFromPs(productIdOrConceptId){
  const id = String(productIdOrConceptId||'').trim();
  if(!id) return '';
  const urls = /^\d+$/.test(id)
    ? [`https://store.playstation.com/ru-ua/concept/${encodeURIComponent(id)}`]
    : [`https://store.playstation.com/ru-ua/product/${encodeURIComponent(id)}`];
  for(const url of urls){
    try{
      const html = await fetchText(url, {
        acceptLanguage: 'ru-UA,ru;q=0.95,uk-UA;q=0.7,en;q=0.5',
        timeoutMs: 12000,
        headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
      });
      const desc = extractPsDescriptionFromHtml(html);
      if(desc) return desc;
    }catch(_e){}
  }
  return '';
}


// --- PlayStation Discounts category scraper (TR) ---
// Admin can trigger a refresh: we scrape the PS Store TR discounts category page,
// resolve discounted products, match them against our local "Всё игры" library, and rebuild games.json (Скидки).
// UA скидочная цена считается от UA базовой цены из базы (процент берём из TR), без запросов к UA стору.

const PS_TR_DISCOUNTS_CATEGORY_ID = "3f772501-f6f8-49b7-abac-874a88ca4897";
const PS_TR_DISCOUNTS_PAGE_SIZE_GUESS = 24;

function safeNum(v){
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function safeIsoDate(v){
  const s = String(v || "").trim();
  if(!s) return null;
  // accept YYYY-MM-DD or ISO datetime
  if(/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/\d{4}-\d{2}-\d{2}/);
  if(m) return m[0];
  // sometimes epoch ms
  const n = Number(s);
  if(Number.isFinite(n) && n > 1000000000){
    try{ return new Date(n).toISOString().slice(0,10); }catch{ return null; }
  }
  return null;
}
function extractProductIdsFromCategoryHtml(html){
  // Category pages contain links like /en-tr/product/<PRODUCT_ID>
  // We only need product IDs; discount percent/date/price are taken from product pages.
  const out = [];
  const seen = new Set();
  const re = /\/product\/([A-Z0-9_-]{10,})/gi;
  let m;
  while((m = re.exec(String(html||""))) !== null){
    const id = String(m[1]||"").toUpperCase().trim();
    if(!id) continue;
    // Typical PSN product id starts like EP9000- or UP0001-
    if(!/^[A-Z]{2}\d{4}-/.test(id)) continue;
    if(seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function parseTrProductHtmlForDiscount(html, expectedSku){
  // Reuse the same parsing helpers used by /api/admin/import.
  // Return discount meta for this exact product page only.
  if(!html || looksBlocked(html)) return { blocked:true };
  const jsonLd = extractJsonLd(html);
  const offer = extractOfferPrice(jsonLd, expectedSku);
  const discPerc = extractDiscountPercent(html);
  const until = (discPerc && discPerc > 0) ? (extractDiscountedUntil(html, jsonLd) || extractUntilDate(html)) : null;
  const sale = (offer && Number.isFinite(offer.price) ? offer.price : null);
  // A version is discounted only when it has its own sale price AND its own end date.
  if(!(discPerc > 0) || !until || sale == null){
    return { blocked:false, discPerc:0, discountedUntil:null, trDiscountPrice:sale };
  }
  return { blocked:false, discPerc: discPerc || 0, discountedUntil: until || null, trDiscountPrice: sale };
}

async function fetchTrDiscountCategoryPageHtml(pageNum, opts={}){
  const p = Math.max(1, Number(pageNum)||1);
  const url = `https://store.playstation.com/en-tr/category/${PS_TR_DISCOUNTS_CATEGORY_ID}/${p}`;
  return await fetchText(url, { acceptLanguage: "en-TR,en;q=0.9", timeoutMs: opts.timeoutMs ?? 10000 });
}

async function scrapeTrDiscountCategory(opts={}){
  // Strategy:
  // 1) Collect product IDs from the discounts category pages.
  // 2) For each product page, parse discount percent, end date and discounted price.
  // This is slower than parsing internal __NEXT_DATA__, but far more stable.

  const pages = Math.max(1, Math.min(80, Number(opts.pages || 12)));
  const timeoutMs = Number(opts.timeoutMs || 15000);
  const maxProducts = Math.max(1, Math.min(1200, Number(opts.maxProducts || 600)));
  const concurrency = Math.max(1, Math.min(6, Number(opts.concurrency || 4)));

  const ids = [];
  const seen = new Set();
  for(let p=1; p<=pages; p++){
    let html;
    try{
      html = await fetchTrDiscountCategoryPageHtml(p, { timeoutMs });
    }catch(_e){
      break;
    }
    if(looksBlocked(html)) break;
    const pageIds = extractProductIdsFromCategoryHtml(html);
    if(!pageIds.length) break;
    for(const id of pageIds){
      if(seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      if(ids.length >= maxProducts) break;
    }
    if(ids.length >= maxProducts) break;
    // heuristic: if few ids on a page, likely the end
    if(pageIds.length < (opts.pageSizeGuess || PS_TR_DISCOUNTS_PAGE_SIZE_GUESS)) break;
  }

  // Promise pool
  const results = [];
  let idx = 0;
  const workers = Array.from({ length: concurrency }, async ()=>{
    while(true){
      const i = idx++;
      if(i >= ids.length) break;
      const pid = ids[i];
      const url = `https://store.playstation.com/en-tr/product/${pid}`;
      let html = "";
      try{
        html = await fetchText(url, { acceptLanguage: "en-TR,en;q=0.9,tr-TR;q=0.8", timeoutMs });
      }catch(_e){
        continue;
      }
      const parsed = parseTrProductHtmlForDiscount(html, pid);
      if(parsed && !parsed.blocked && parsed.discPerc > 0 && parsed.trDiscountPrice != null){
        results.push({ productId: pid, discPerc: parsed.discPerc, discountedUntil: parsed.discountedUntil, trDiscountPrice: parsed.trDiscountPrice });
      }
    }
  });
  await Promise.all(workers);

  // Deduplicate by productId, prefer higher discount
  const byPid = new Map();
  for(const r of results){
    const key = String(r.productId||"").toUpperCase().trim();
    if(!key) continue;
    const prev = byPid.get(key);
    if(!prev || Number(r.discPerc||0) > Number(prev.discPerc||0)) byPid.set(key, r);
  }
  return Array.from(byPid.values());
}


function collectTrProductIdsFromGame(g){
  const out = [];
  const add = (v)=>{
    if(Array.isArray(v)){
      for(const x of v) add(x);
      return;
    }
    const s = String(v || "").toUpperCase().trim();
    if(s && /^[A-Z]{2}\d{4}-/.test(s) && !out.includes(s)) out.push(s);
  };
  add(g && g.productIds && g.productIds.TR);
  // fallback for older items where id itself is the TR product id
  add(g && g.id);
  return out;
}

function mergeDiscountListsExact(lists){
  const byPid = new Map();
  for(const list of lists || []){
    for(const it of (Array.isArray(list) ? list : [])){
      const key = String(it && it.productId || "").toUpperCase().trim();
      if(!key) continue;
      const cur = Object.assign({}, it, { productId:key });
      const prev = byPid.get(key);
      if(!prev){ byPid.set(key, cur); continue; }
      const prevScore =
        (Number(prev.trDiscountPrice) > 0 ? 4 : 0) +
        (Number(prev.discPerc) > 0 ? 3 : 0) +
        (prev.discountedUntil ? 1 : 0);
      const curScore =
        (Number(cur.trDiscountPrice) > 0 ? 4 : 0) +
        (Number(cur.discPerc) > 0 ? 3 : 0) +
        (cur.discountedUntil ? 1 : 0);
      if(curScore > prevScore || Number(cur.discPerc||0) > Number(prev.discPerc||0)) byPid.set(key, cur);
    }
  }
  return Array.from(byPid.values());
}

async function scrapeKnownTrProductDiscounts(baseItems, opts={}){
  // Extra safe pass: check exact product pages from our own base.
  // This does NOT use conceptId, so Standard/Deluxe/Ultimate cannot be mixed.
  // It only adds a discount when the exact productId stored in all_games.json has an active discount.
  const timeoutMs = Number(opts.timeoutMs || 8000);
  const concurrency = Math.max(1, Math.min(8, Number(opts.concurrency || 5)));
  const maxProducts = Math.max(1, Math.min(3000, Number(opts.maxProducts || 1200)));

  const ids = [];
  const seen = new Set();
  for(const g of (Array.isArray(baseItems) ? baseItems : [])){
    for(const pid of collectTrProductIdsFromGame(g)){
      if(seen.has(pid)) continue;
      seen.add(pid);
      ids.push(pid);
      if(ids.length >= maxProducts) break;
    }
    if(ids.length >= maxProducts) break;
  }

  const results = [];
  let idx = 0;
  const workers = Array.from({ length: concurrency }, async ()=>{
    while(true){
      const i = idx++;
      if(i >= ids.length) break;
      const pid = ids[i];
      const url = `https://store.playstation.com/en-tr/product/${pid}`;
      try{
        const html = await fetchText(url, { acceptLanguage: "en-TR,en;q=0.9,tr-TR;q=0.8", timeoutMs });
        const parsed = parseTrProductHtmlForDiscount(html, pid);
        if(parsed && !parsed.blocked && Number(parsed.discPerc||0) > 0 && parsed.trDiscountPrice != null){
          results.push({
            productId: pid,
            discPerc: Number(parsed.discPerc || 0),
            discountedUntil: parsed.discountedUntil || null,
            trDiscountPrice: Number(parsed.trDiscountPrice || 0),
            source: "known_product_page"
          });
        }
      }catch(_e){}
    }
  });
  await Promise.all(workers);
  return mergeDiscountListsExact([results]);
}

function computeDiscountedPrice(basePrice, discPerc){
  const b = Number(basePrice);
  const d = Number(discPerc);
  if(!Number.isFinite(b) || b <= 0) return 0;
  if(!Number.isFinite(d) || d <= 0) return b;
  const v = b * (1 - (d/100));
  // keep 2 decimals max (UAH/TRY can be .5 sometimes)
  return Math.round(v * 100) / 100;
}

function computeDiscountPercentFromPrices(basePrice, salePrice){
  const b = Number(basePrice);
  const s = Number(salePrice);
  if(!Number.isFinite(b) || b <= 0 || !Number.isFinite(s) || s <= 0 || s >= b) return 0;
  const pct = Math.round(((b - s) / b) * 100);
  return (Number.isFinite(pct) && pct > 0 && pct <= 100) ? pct : 0;
}

// --- Subscription helpers (PS Plus Extra / EA Play) ---
// In some environments Playwright browsers may be missing and we fall back to plain HTTP.
// Subscription badges are usually still present in the server-rendered HTML / __NEXT_DATA__,
// so we can detect them without a browser.
function extractSubFromHtml(html){
  if(!html || typeof html !== "string") return "";
  // Use a small, decoded text surface to improve robustness across locales.
  const txt = decodeHtml(String(html))
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // EA Play
  if(/\bea\s*play\b/i.test(txt)) return "eaplay";

  // PS Plus Extra (different locales can spell Extra differently)
  const hasPsPlus = /(playstation\s*plus|ps\s*plus)/i.test(txt);
  const hasExtra = /(\bextra\b|\bekstra\b|экстра)/i.test(txt);
  if(hasPsPlus && hasExtra) return "psplus_extra";

  return "";
}

// Extract PlayStation conceptId from a /product/... HTML page.
// We mainly rely on data-telemetry-meta blocks which contain JSON like:
// {"conceptId":"209441","productId":"EP..."}
function extractConceptIdFromProductHtml(html, expectedProductId){
  if(!html || typeof html !== 'string') return null;
  const exp = expectedProductId ? String(expectedProductId).toUpperCase() : "";

  let best = null;
  let bestScore = -1;

  const reMeta = /data-telemetry-meta="([^"]+)"/gi;
  let m;
  while((m = reMeta.exec(html))){
    const raw = String(m[1]||"");
    const decoded = decodeHtml(raw);
    let obj = null;
    try{ obj = JSON.parse(decoded); }catch(_e){
      // fallback: try to pull conceptId/productId via regex from decoded fragment
      const cidM = decoded.match(/"conceptId"\s*:\s*"?(\d{4,12})"?/i);
      const pidM = decoded.match(/"productId"\s*:\s*"?([A-Z0-9_-]{10,})"?/i);
      obj = { conceptId: cidM ? cidM[1] : null, productId: pidM ? pidM[1] : null };
    }
    const cid = obj && (obj.conceptId || obj.conceptID || obj.topConceptId);
    if(!cid || !/^\d{4,12}$/.test(String(cid))) continue;
    const pid = obj && obj.productId ? String(obj.productId).toUpperCase() : "";
    let score = 1;
    if(exp && pid && pid === exp) score += 1000;
    if(pid) score += 10;
    if(score > bestScore){
      bestScore = score;
      best = String(cid);
    }
  }

  if(best) return best;

  // Fallback: scan the page for a JSON field
  const mm = html.match(/"conceptId"\s*:\s*"?(\d{4,12})"?/i);
  if(mm) return String(mm[1]);

  // Fallback: sometimes /concept/<id> appears in canonical links
  const mc = html.match(/\/concept\/(\d{4,12})/i);
  if(mc) return String(mc[1]);

  return null;
}

// --- RU localization helpers (TR only for now) ---
// When Playwright isn't available we only have raw HTML, so we parse the server-rendered
// "Voice" and "Screen Languages" sections.
function extractRuFromHtmlTR(html){
  if(!html || typeof html !== "string") return { ru:"none", ruVoice:false, ruText:false };

  // Build a readable text surface: remove scripts/styles, convert <br> to newlines, strip tags.
  let txt = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  txt = decodeHtml(txt)
    .replace(/\u00A0/g, " ")
    .replace(/[\t\r]+/g, " ")
    .replace(/\n[ \f\v\u00A0]+/g, "\n")
    .replace(/[ \f\v\u00A0]+\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .replace(/ {2,}/g, " ")
    .trim();

  // Ensure labels start at a new line even if the markup renders them inline.
  txt = txt.replace(/(ps[45]\s*)?(voice|screen\s*languages?|audio|subtitles?|interface|ses|ekran\s*dilleri?|ekran\s*dili|altyaz[ıi]lar)\s*:/gi, "\n$&");

  const RU_TOKEN = /(\brussian\b|русск(?:ий|ая|ое|ие)?|\brusça\b|\brusca\b|\brusse\b)/i;

  // We parse sections with a small state machine so we don't confuse Screen Languages with Voice.
  const lines = txt.split("\n").map(s=>s.trim()).filter(Boolean);

  const isVoiceLabel = (s)=>/^(ps[45]\s*)?(voice|audio|ses|dublaj|dub)\s*:/i.test(s);
  const isScreenLabel = (s)=>/^(ps[45]\s*)?(screen\s*languages?|interface|subtitles?|ekran\s*dilleri?|ekran\s*dili|altyaz[ıi]lar)\s*:/i.test(s);
  const isAnyLabel = (s)=>isVoiceLabel(s) || isScreenLabel(s);

  const collectAfterColonOrNextLine = (line, i)=>{
    // return { value, nextIndex }
    const parts = line.split(":");
    const after = parts.slice(1).join(":").trim();
    if(after) return { value: after, nextIndex: i+1 };
    // if nothing after colon, take next non-label line as value
    let j = i+1;
    while(j < lines.length){
      const ln = lines[j];
      if(isAnyLabel(ln)) break;
      if(ln) return { value: ln, nextIndex: j+1 };
      j++;
    }
    return { value: "", nextIndex: i+1 };
  };

  let ruVoice = false;
  let ruText = false;

  for(let i=0;i<lines.length;i++){
    const ln = lines[i];
    if(isVoiceLabel(ln)){
      const { value, nextIndex } = collectAfterColonOrNextLine(ln, i);
      if(value && RU_TOKEN.test(value)) ruVoice = true;
      i = nextIndex - 1;
      continue;
    }
    if(isScreenLabel(ln)){
      const { value, nextIndex } = collectAfterColonOrNextLine(ln, i);
      if(value && RU_TOKEN.test(value)) ruText = true;
      i = nextIndex - 1;
      continue;
    }
  }

  const ru = ruVoice ? "voice" : (ruText ? "text" : "none");
  return { ru, ruVoice, ruText };
}

function extractBrowseEntries(html){
  // Pull product/concept anchors in document order.
  // Return [{ id, title }]. "id" is the last segment in /product/<id> or /concept/<id>.
  const out = [];
  if(!html || typeof html !== "string") return out;
  const re = /<a\b[^>]*href=["']([^"']+\/(?:product|concept)\/[^"'?#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  const seen = new Set();
  while((m = re.exec(html)) !== null){
    const href = String(m[1] || "");
    const id = href.split("/").filter(Boolean).pop();

    let txt = m[2] || "";
    txt = txt.replace(/<[^>]+>/g, " ");
    txt = decodeHtml(txt).replace(/\s+/g, " ").trim();
    if(!txt) continue;
    if(txt.length < 2) continue;
    if(/^(image|ps plus|free|бесплатно)$/i.test(txt)) continue;

    const titleKey = normText(txt);
    const dedupeKey = (id ? ("id:" + id) : ("t:" + titleKey));
    if(seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({ id: id || "", title: txt });
  }
  return out;
}

function psBrowseUrl(locale, page){
  const loc = String(locale || "ru-ua").trim();
  if(!page || page === 1) return `https://store.playstation.com/${loc}/pages/browse`;
  // PS store uses /pages/browse/2/ style paging
  return `https://store.playstation.com/${loc}/pages/browse/${page}/`;
}

function psPreordersUrl(locale, page){
  const loc = String(locale || "en-tr").trim();
  const p = Math.max(1, Number(page) || 1);
  return `https://store.playstation.com/${loc}/category/${PS_PREORDERS_CATEGORY_ID}/${p}`;
}

function psEaPlayUrl(locale, page){
  const loc = String(locale || "en-tr").trim();
  const p = Math.max(1, Number(page) || 1);
  return `https://store.playstation.com/${loc}/category/${PS_EAPLAY_CATEGORY_ID}/${p}`;
}

function psNewReleasesUrl(locale, page){
  const loc = String(locale || "en-tr").trim();
  const p = Math.max(1, Number(page) || 1);
  return `https://store.playstation.com/${loc}/category/${PS_NEW_RELEASES_CATEGORY_ID}/${p}`;
}

function extractConceptOrderFromCategoryHtml(html){
  // Collect concept IDs in document order from category pages.
  // Prefer explicit /concept/<id> links; fallback to telemetry meta.
  const order = [];
  const seen = new Set();
  if(!html || typeof html !== 'string') return order;

  // 1) /concept/<digits>
  const reConcept = /\/concept\/(\d{4,12})/gi;
  let m;
  while((m = reConcept.exec(html))){
    const id = String(m[1]);
    if(!seen.has(id)){
      seen.add(id);
      order.push(id);
    }
  }

  // 2) telemetry meta (HTML-escaped JSON)
  const reMeta = /data-telemetry-meta="([^"]+)"/gi;
  while((m = reMeta.exec(html))){
    const raw = String(m[1]||'');
    const decoded = decodeHtml(raw);
    // decoded may still contain quotes if encoded differently; try parse + regex fallback
    try{
      const obj = JSON.parse(decoded);
      const cid = obj && (obj.conceptId || obj.conceptID || obj.topConceptId);
      if(cid && /^\d+$/.test(String(cid))){
        const id = String(cid);
        if(!seen.has(id)){
          seen.add(id);
          order.push(id);
        }
      }
    }catch(_e){
      const mm = decoded.match(/"conceptId"\s*:\s*"?(\d+)"?/i);
      if(mm){
        const id = String(mm[1]);
        if(!seen.has(id)){
          seen.add(id);
          order.push(id);
        }
      }
    }
  }

  return order;
}

async function refreshPsNewReleasesCache(locale, opts = {}){
  const loc = String(locale || 'en-tr').trim();
  const maxPages = Math.max(1, Math.min(50, Number(opts.pages || 12)));
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 4000;

  const all = [];
  const seen = new Set();
  for(let p=1; p<=maxPages; p++){
    let html;
    try{
      html = await fetchText(psNewReleasesUrl(loc, p), { acceptLanguage: loc.replace('-', '_'), timeoutMs });
    }catch(_e){
      break;
    }
    const ids = extractConceptOrderFromCategoryHtml(html);
    if(!ids.length) break;
    for(const id of ids){
      if(!seen.has(id)){
        seen.add(id);
        all.push(id);
      }
    }
    // heuristic: if page has very few entries, probably last page
    if(ids.length < 6) break;
  }

  const cache = { updatedAt: new Date().toISOString(), locale: loc, order: all };
  writePsNewReleasesCache(cache);
  return cache;
}

async function ensurePsNewReleasesCacheFresh(locale){
  const loc = String(locale || 'en-tr').trim();
  const c = readPsNewReleasesCache();
  const updated = c && c.updatedAt ? Date.parse(c.updatedAt) : 0;
  const stale = !updated || (Date.now() - updated) > PS_NEW_RELEASES_TTL_MS;
  if(!c || c.locale !== loc || stale || !Array.isArray(c.order) || !c.order.length){
    return await refreshPsNewReleasesCache(loc, { pages: 12 });
  }
  return c;
}

async function warmupPsPreordersCache(locale, pagesToFetch = 2){
  const loc = String(locale || "en-tr").trim();
  const today = new Date().toISOString();
  const cache = readPsPreordersCache();
  if(cache.locale === loc && cache.updatedAt && sameDayIso(cache.updatedAt, today)){
    if(cache.ranksById && Object.keys(cache.ranksById).length) return;
  }
  if(cache.locale !== loc){
    cache.locale = loc;
    cache.ranksByName = {};
    cache.ranksById = {};
    cache.updatedAt = null;
  }
  const n = Math.max(1, Math.min(25, Number(pagesToFetch) || 2));
  for(let page=1; page<=n; page++){
    let html;
    try{
      html = await fetchText(psPreordersUrl(loc, page), { acceptLanguage: loc.replace("-", "_"), timeoutMs: 2500 });
    }catch(_e){
      break;
    }
    const entries = extractBrowseEntries(html);
    if(!entries.length) break;
    for(let i=0;i<entries.length;i++){
      const e = entries[i];
      const rank = (page-1) * PS_PREORDERS_PAGE_SIZE_GUESS + (i+1);
      if(e.id && !cache.ranksById[e.id]) cache.ranksById[e.id] = rank;
      const tKey = normText(e.title);
      if(tKey && !cache.ranksByName[tKey]) cache.ranksByName[tKey] = rank;
      const bKey = normText(baseTitleForRank(e.title));
      if(bKey && !cache.ranksByName[bKey]) cache.ranksByName[bKey] = rank;
    }
  }
  cache.updatedAt = today;
  writePsPreordersCache(cache);
}

async function warmupPsEaPlayCache(locale, pagesToFetch = 2){
  // EA Play uses a dedicated category page ("The Play List"). We scrape it in
  // document order so our EA Play subscription page matches PS Store Turkey.
  const loc = String(locale || "en-tr").trim();
  const today = new Date().toISOString();
  const cache = readPsEaPlayCache();
  if(cache.locale === loc && cache.updatedAt && sameDayIso(cache.updatedAt, today)){
    if(cache.ranksById && Object.keys(cache.ranksById).length) return;
  }
  if(cache.locale !== loc){
    cache.locale = loc;
    cache.ranksByName = {};
    cache.ranksById = {};
    cache.updatedAt = null;
  }
  const n = Math.max(1, Math.min(25, Number(pagesToFetch) || 2));
  for(let page=1; page<=n; page++){
    let html;
    try{
      html = await fetchText(psEaPlayUrl(loc, page), { acceptLanguage: loc.replace("-", "_"), timeoutMs: 2500 });
    }catch(_e){
      break;
    }
    const entries = extractBrowseEntries(html);
    if(!entries.length) break;
    for(let i=0;i<entries.length;i++){
      const e = entries[i];
      const rank = (page-1) * PS_EAPLAY_PAGE_SIZE_GUESS + (i+1);
      if(e.id && !cache.ranksById[e.id]) cache.ranksById[e.id] = rank;
      const tKey = normText(e.title);
      if(tKey && !cache.ranksByName[tKey]) cache.ranksByName[tKey] = rank;
      const bKey = normText(baseTitleForRank(e.title));
      if(bKey && !cache.ranksByName[bKey]) cache.ranksByName[bKey] = rank;
    }
  }
  cache.updatedAt = today;
  writePsEaPlayCache(cache);
}

async function warmupPsBrowseCache(locale, pagesToFetch = 3){
  // Light, fast prefill of browse ranks so the first request already sorts correctly.
  // We only fetch a few pages to avoid slow startups / timeouts.
  const loc = String(locale || "en-tr").trim();
  const today = new Date().toISOString();
  const cache = readPsBrowseCache();
  if(cache.locale === loc && cache.updatedAt && sameDayIso(cache.updatedAt, today)){
    // If we already have some ids, don't refetch.
    if(cache.ranksById && Object.keys(cache.ranksById).length) return;
  }
  if(cache.locale !== loc){
    cache.locale = loc;
    cache.ranksByName = {};
    cache.ranksById = {};
    cache.updatedAt = null;
  }
  const n = Math.max(1, Math.min(25, Number(pagesToFetch) || 3));
  for(let page=1; page<=n; page++){
    let html;
    try{
      html = await fetchText(psBrowseUrl(loc, page), { acceptLanguage: loc.replace("-", "_"), timeoutMs: 2000 });
    }catch(_e){
      break;
    }
    const entries = extractBrowseEntries(html);
    if(!entries.length) break;
    for(let i=0;i<entries.length;i++){
      const e = entries[i];
      const rank = (page-1) * PS_BROWSE_PAGE_SIZE_GUESS + (i+1);
      if(e.id && !cache.ranksById[e.id]) cache.ranksById[e.id] = rank;
      const tKey = normText(e.title);
      if(tKey && !cache.ranksByName[tKey]) cache.ranksByName[tKey] = rank;
      const bKey = normText(baseTitleForRank(e.title));
      if(bKey && !cache.ranksByName[bKey]) cache.ranksByName[bKey] = rank;
    }
  }
  cache.updatedAt = today;
  writePsBrowseCache(cache);
}

function bestTitleMatchIndex(titles, query){
  const nq = normText(query);
  if(!nq) return { idx:-1, score:0 };
  let best = { idx:-1, score:0 };
  for(let i=0;i<titles.length;i++){
    const t = titles[i];
    const nt = normText(t);
    if(!nt) continue;
    // exact / containment wins
    if(nt === nq) return { idx:i, score:9999 };
    if(nt.includes(nq) || nq.includes(nt)){
      const sc = 5000 + Math.min(nt.length, nq.length);
      if(sc > best.score) best = { idx:i, score:sc };
      continue;
    }
    // fallback to existing fuzzy logic
    if(smartMatch(t, query)){
      const sc = relevanceScore(t, query);
      if(sc > best.score) best = { idx:i, score:sc };
    }
  }
  return best;
}

async function getPsBrowseRankById(id, locale){
  const pid = String(id || "").trim();
  if(!pid) return null;
  const today = new Date().toISOString();
  const cache = readPsBrowseCache();
  const loc = String(locale || "en-tr").trim();

  if(cache.locale === loc && cache.updatedAt && sameDayIso(cache.updatedAt, today)){
    const r = cache.ranksById[pid];
    if(Number.isFinite(r)) return r;
  }

  if(cache.locale !== loc){
    cache.locale = loc;
    cache.ranksByName = {};
    cache.ranksById = {};
    cache.updatedAt = null;
  }

  const maxPages = Math.min(PS_BROWSE_MAX_PAGES_HARD_LIMIT, 500);
  for(let page=1; page<=maxPages; page++){
    let html;
    try{
      html = await fetchText(psBrowseUrl(loc, page), { acceptLanguage: loc.replace("-", "_") });
    }catch(_e){
      break;
    }
    const entries = extractBrowseEntries(html);
    if(!entries.length) break;

    for(let i=0;i<entries.length;i++){
      const e = entries[i];
      const rank = (page-1) * PS_BROWSE_PAGE_SIZE_GUESS + (i+1);
      if(e.id && !cache.ranksById[e.id]) cache.ranksById[e.id] = rank;
      const tKey = normText(e.title);
      if(tKey && !cache.ranksByName[tKey]) cache.ranksByName[tKey] = rank;
      const bKey = normText(baseTitleForRank(e.title));
      if(bKey && !cache.ranksByName[bKey]) cache.ranksByName[bKey] = rank;
    }

    if(cache.ranksById[pid]){
      cache.updatedAt = today;
      writePsBrowseCache(cache);
      return cache.ranksById[pid];
    }
  }

  cache.updatedAt = today;
  writePsBrowseCache(cache);
  return null;
}

async function getPsBrowseRankByName(name, locale){
  // Returns a 1-based absolute rank (across pages) if found; otherwise null.
  const today = new Date().toISOString();
  const cache = readPsBrowseCache();
  const loc = String(locale || "en-tr").trim();
  const key = normText(name);
  if(!key) return null;

  // Use cache if it was updated today and locale matches.
  if(cache.locale === loc && cache.updatedAt && sameDayIso(cache.updatedAt, today)){
    const r = cache.ranksByName[key];
    if(Number.isFinite(r)) return r;
  }

  // Always (re)use cache map as we discover more titles.
  if(cache.locale !== loc){
    cache.locale = loc;
    cache.ranksByName = {};
    cache.ranksById = {};
    cache.updatedAt = null;
  }

  // Scan pages until we find the title.
  const maxPages = Math.min(PS_BROWSE_MAX_PAGES_HARD_LIMIT, 500);
  for(let page=1; page<=maxPages; page++){
    let html;
    try{
      html = await fetchText(psBrowseUrl(loc, page), { acceptLanguage: loc.replace("-","_") });
    }catch(e){
      // if page fetch fails, stop early
      break;
    }
    const entries = extractBrowseEntries(html);
    if(!entries.length){
      // stop if we can no longer parse
      break;
    }
    const titles = entries.map(e => e.title);
    // store ranks into cache
    for(let i=0;i<titles.length;i++){
      const tKey = normText(titles[i]);
      if(tKey && !cache.ranksByName[tKey]){
        cache.ranksByName[tKey] = (page-1) * PS_BROWSE_PAGE_SIZE_GUESS + (i+1);
      }
      const bKey = normText(baseTitleForRank(titles[i]));
      if(bKey && !cache.ranksByName[bKey]){
        cache.ranksByName[bKey] = (page-1) * PS_BROWSE_PAGE_SIZE_GUESS + (i+1);
      }
    }
    const best = bestTitleMatchIndex(titles, name);
    // 9999 means exact match
    if(best.idx >= 0 && (best.score >= 120 || best.score === 9999 || best.score >= 5000)){
      const rank = (page-1) * PS_BROWSE_PAGE_SIZE_GUESS + (best.idx+1);
      cache.ranksByName[key] = rank;
      cache.updatedAt = today;
      writePsBrowseCache(cache);
      return rank;
    }
  }

  // Persist what we learned today even if not found.
  cache.updatedAt = today;
  writePsBrowseCache(cache);
  return null;
}

function applyPsBrowseRanksToItems(items, locale){
  // best-effort: update popRank of existing items if cache knows their rank.
  const cache = readPsBrowseCache();
  const loc = String(locale || "en-tr").trim();
  const mapById = (cache.locale === loc && cache.ranksById) ? cache.ranksById : {};
  const mapByName = (cache.locale === loc && cache.ranksByName) ? cache.ranksByName : {};

  // First pass: set known ranks; unknown -> large number
  for(let i=0;i<items.length;i++){
    const it = items[i];
    const rid = mapById[String(it?.id || "").trim()];
    if(Number.isFinite(rid)) { it.popRank = rid; continue; }
    const k = normText(it?.name || "");
    const rn = k ? mapByName[k] : null;
    if(Number.isFinite(rn)) it.popRank = rn;
  }
  let bump = 0;
  for(let i=0;i<items.length;i++){
    const it = items[i];
    const r = Number(it?.popRank);
    if(!Number.isFinite(r) || r <= 0){
      it.popRank = 1000000000 + (++bump);
    }
  }
  // Resolve ties deterministically (keep known PS ranks first)
  const byRank = new Map();
  for(const it of items){
    const r = Number(it.popRank);
    const arr = byRank.get(r) || [];
    arr.push(it);
    byRank.set(r, arr);
  }
  for(const [r, arr] of byRank.entries()){
    if(arr.length <= 1) continue;
    arr.sort((a,b)=> String(a.name||"").localeCompare(String(b.name||"")));
    for(let i=0;i<arr.length;i++){
      arr[i].popRank = r + (i*0.001);
    }
  }
}

// Background rank & resort (non-blocking for admin "Add")
// ------------------------------------------------------
// We keep this extremely small and isolated so it doesn't affect other logic.
let _bgRankRunning = false;
const _bgRankPending = new Map(); // id -> { id, name, locale }

function scheduleBackgroundRankAndResort(id, name, locale){
  const gid = String(id || "").trim();
  if(!gid) return;
  _bgRankPending.set(gid, { id: gid, name: String(name||""), locale: String(locale||"en-tr") });
  if(_bgRankRunning) return;
  _bgRankRunning = true;
  setImmediate(async () => {
    try{
      // Process until queue is empty; collapse duplicates by keeping only the latest per id.
      while(_bgRankPending.size){
        const firstKey = _bgRankPending.keys().next().value;
        const job = _bgRankPending.get(firstKey);
        _bgRankPending.delete(firstKey);

        // Best-effort: scrape rank (may be slow or fail). Never throw.
        let rank = null;
        try{
          rank = await getPsBrowseRankById(job.id, job.locale);
          if(!Number.isFinite(rank)) rank = await getPsBrowseRankByName(job.name, job.locale);
        }catch(_e){ rank = null; }

        // Update game file if present.
        try{
          const doc = readJson(GAMES_PATH, { updatedAt:null, items:[] });
          const items = Array.isArray(doc.items) ? doc.items : [];
          const it = items.find(x => String(x?.id) === String(job.id));
          if(it && Number.isFinite(rank)) it.popRank = rank;

          // Apply any ranks we already know from cache to all items (cheap, local-only)
          try{ applyPsBrowseRanksToItems(items, job.locale); }catch(_e){}

          // Persist a stable sorted order by popRank so admin list doesn't depend on insert order.
          items.sort((a,b)=>{
            const ar = Number(a?.popRank); const br = Number(b?.popRank);
            if(ar===br) return String(a?.name||"").localeCompare(String(b?.name||""));
            if(!Number.isFinite(ar)) return 1;
            if(!Number.isFinite(br)) return -1;
            return ar - br;
          });

          writeJson(GAMES_PATH, { updatedAt: new Date().toISOString(), items });
        }catch(_e){}
      }
    }finally{
      _bgRankRunning = false;
    }
  });
}

// --- FIX: node18-safe JSON fetch + Chihiro fallback for cover & prices ---


function extractTitleFromHtml(html){
  if(!html || typeof html !== "string") return null;
  // og:title
  // meta attribute order varies across PS Store pages
  let m = html.match(/<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if(!(m && m[1])) m = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:title["']/i);
  if(m && m[1]) return decodeHtml(m[1]).trim();
  // twitter:title
  m = html.match(/<meta[^>]+(?:property|name)=["']twitter:title["'][^>]+content=["']([^"']+)["']/i);
  if(!(m && m[1])) m = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']twitter:title["']/i);
  if(m && m[1]) return decodeHtml(m[1]).trim();
  // h1 (store pages)
  m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if(m && m[1]){
    const t = decodeHtml(m[1].replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim());
    if(t) return t;
  }
  // title tag
  m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if(m && m[1]){
    const t = decodeHtml(m[1].replace(/\s+/g," ").trim());
    if(t) return t;
  }
  return null;
}
function decodeHtml(s){
  if(!s) return "";
  return s
    .replace(/&amp;/g,"&")
    .replace(/&quot;/g,'"')
    .replace(/&#39;/g,"'")
    .replace(/&lt;/g,"<")
    .replace(/&gt;/g,">");
}
async function fetchTitleFromAltLocales(productId){
  const locales = ["en-fi","fi-fi","en-us","en-gb","en-au"];
  for(const loc of locales){
    try{
      const url = `https://store.playstation.com/${loc}/product/${productId}`;
      const html = await fetchText(url, { acceptLanguage: loc.replace("-","_") });
      const t = extractTitleFromHtml(html);
      if(t && !looksDenied(t)) return t;
    }catch(_e){}
  }
  return null;
}

function looksDenied(s){
  if(!s || typeof s !== "string") return false;
  const low = s.toLowerCase();
  return low.includes("access denied") || low.includes("forbidden") || low.includes("denied");
}

function fetchJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = Object.assign({
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "Accept": "application/json,text/plain,*/*",
      "Accept-Language": opts.acceptLanguage || "en-US,en;q=0.9",
    }, opts.headers || {});

    const req = https.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: "GET",
      headers
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          return reject(new Error("HTTP " + res.statusCode));
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error("INVALID_JSON"));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function fetchChihiro(locale, productId){
  // Locale examples: "en-tr", "ru-ua"
  const url = `https://store.playstation.com/chihiro-api/viewfinder/${locale}/${productId}`;
  return await fetchJson(url, { acceptLanguage: locale.replace("-", "_") });
}

function pickCoverFromChihiro(obj){
  const imgs = obj?.images || obj?.data?.images || obj?.included?.images;
  if (Array.isArray(imgs)) {
    // choose first big image with url
    for (const im of imgs) {
      const u = im?.url || im?.src || im?.source || im?.image?.url;
      if (u && typeof u === "string" && /^https?:\/\//.test(u)) return u;
    }
  }
  // sometimes image is nested in "default_sku" or "webctas"
  const u = obj?.default_sku?.image_url || obj?.image_url || obj?.thumbnail_url;
  if (u && typeof u === "string" && /^https?:\/\//.test(u)) return u;
  return null;
}

function pickPricesFromChihiro(obj){
  // returns { base, discounted, currency } in numeric (if possible) and display strings
  const skus = obj?.skus || obj?.data?.skus || [];
  const def = obj?.default_sku || obj?.data?.default_sku;
  const skuId = def?.id || def?.sku_id;
  let sku = null;
  if (skuId && Array.isArray(skus)) sku = skus.find(s => s?.id === skuId) || null;
  if (!sku && Array.isArray(skus) && skus.length) sku = skus[0];

  const prices = sku?.prices || sku?.price || sku?.default_price || null;
  // different shapes: { basePrice, discountedPrice, currencyCode } or { base_price, discounted_price }
  const base = prices?.basePrice ?? prices?.base_price ?? prices?.original_price ?? prices?.strikethrough_price ?? null;
  const disc = prices?.discountedPrice ?? prices?.discounted_price ?? prices?.actual_price ?? prices?.sale_price ?? null;
  const currency = prices?.currencyCode ?? prices?.currency_code ?? prices?.currency ?? null;
  const display = prices?.displayPrice ?? prices?.display_price ?? prices?.formatted ?? null;

  // try parse numbers from strings like "₺ 1.299,00" or "1 299,00 ₴"
  const toNum = (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") return v;
    if (typeof v !== "string") return null;
    // keep digits, dot, comma
    let s = v.replace(/[^\d,.\-]/g, "").trim();
    if (!s) return null;
    // if both comma and dot, assume dot thousand sep and comma decimal
    if (s.includes(",") && s.includes(".")) {
      // remove dots, replace comma with dot
      s = s.replace(/\./g, "").replace(",", ".");
    } else if (s.includes(",") && !s.includes(".")) {
      // comma decimal -> dot
      s = s.replace(",", ".");
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  return {
    base: toNum(base),
    discounted: toNum(disc),
    currency,
    display
  };
}


function pickTitleFromChihiro(obj){
  // Recursive search for plausible title fields in Chihiro payload.
  const seen = new Set();
  const candidates = [];

  const push = (v, path="") => {
    if(!v || typeof v !== "string") return;
    const t = v.trim();
    if(!t) return;
    if(t.length < 2) return;
    const low = t.toLowerCase();
    if(low.includes("access denied") || low.includes("forbidden") || low === "denied") return;
    // filter urls / ids
    if(/^https?:\/\//.test(t)) return;
    if(/^[A-Z]{2}\d{3,}/.test(t)) return;
    const key = t.toLowerCase();
    if(seen.has(key)) return;
    seen.add(key);
    candidates.push({t, path});
  };

  const walk = (node, path="") => {
    if(!node) return;
    if(typeof node === "string"){ push(node, path); return; }
    if(typeof node !== "object") return;
    if(Array.isArray(node)){
      for(let i=0;i<node.length;i++) walk(node[i], path + "["+i+"]");
      return;
    }
    for(const k of Object.keys(node)){
      const v = node[k];
      const p = path ? (path + "." + k) : k;
      // prioritize keys that look like title/name
      if(typeof v === "string"){
        if(/name|title|product_name|localized|display|label/i.test(k)) push(v, p);
      }
      walk(v, p);
    }
  };

  walk(obj);

  if(!candidates.length) return null;

  // Scoring: prefer paths with name/title, shorter but not too short
  const score = (c) => {
    let s = 0;
    const p = c.path.toLowerCase();
    if(p.includes("localized")) s += 6;
    if(p.includes("title")) s += 6;
    if(p.includes("name")) s += 5;
    if(p.includes("product")) s += 2;
    if(p.includes("default_sku")) s += 1;
    const len = c.t.length;
    if(len >= 6 && len <= 60) s += 4;
    if(len > 60 && len <= 120) s += 2;
    if(len < 6) s -= 2;
    // penalize obviously non-titles
    if(/\btry\b|\buah\b|\b₺\b|\b₴\b/.test(c.t.toLowerCase())) s -= 3;
    return s;
  };

  candidates.sort((a,b)=>score(b)-score(a));
  return candidates[0].t;
}



app.use(express.json({ limit: "50mb" }));

// visitors counter (admin-only display)
app.use((req, _res, next)=>{ recordVisit(req); next(); });

function isAllowedRemoteImageUrl(raw){
  try{
    const u = new URL(String(raw || ""));
    if(u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    return host.endsWith("playstation.com") || host.endsWith("playstation.net") || host.includes("playstation");
  }catch(_e){
    return false;
  }
}

async function fetchRemoteImageBuffer(url, redirectsLeft=3){
  return new Promise((resolve, reject)=>{
    const req = https.get(url, {
      headers:{
        "User-Agent":"Mozilla/5.0 (compatible; PlayStore95ImageOptimizer/1.0)",
        "Accept":"image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
      },
      timeout:15000
    }, (res)=>{
      const status = Number(res.statusCode || 0);
      if(status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0){
        res.resume();
        try{
          const next = new URL(res.headers.location, url).href;
          return resolve(fetchRemoteImageBuffer(next, redirectsLeft - 1));
        }catch(e){ return reject(e); }
      }
      if(status < 200 || status >= 300){
        res.resume();
        return reject(new Error("remote_status_" + status));
      }
      const contentType = String(res.headers["content-type"] || "").toLowerCase();
      if(contentType && !contentType.startsWith("image/")){
        res.resume();
        return reject(new Error("not_image"));
      }
      const chunks = [];
      let total = 0;
      res.on("data", (chunk)=>{
        total += chunk.length;
        if(total > 12 * 1024 * 1024){
          req.destroy(new Error("image_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", ()=>resolve(Buffer.concat(chunks)));
    });
    req.on("timeout", ()=>req.destroy(new Error("remote_timeout")));
    req.on("error", reject);
  });
}

app.get("/api/optimized-image", async (req, res)=>{
  try{
    const remoteUrl = String(req.query.u || "");
    const width = Math.max(80, Math.min(700, parseInt(String(req.query.w || "322"), 10) || 322));
    if(!isAllowedRemoteImageUrl(remoteUrl)) return res.status(400).send("bad image url");

    const accept = String(req.headers.accept || "").toLowerCase();
    const canWebp = accept.includes("image/webp");
    const ext = (sharp && canWebp) ? "webp" : "bin";
    const key = crypto.createHash("sha1").update(remoteUrl + "|" + width + "|" + ext).digest("hex");
    const filePath = path.join(IMAGE_CACHE_DIR, key + "." + ext);

    if(fs.existsSync(filePath)){
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("Content-Type", ext === "webp" ? "image/webp" : "image/jpeg");
      return fs.createReadStream(filePath).pipe(res);
    }

    const original = await fetchRemoteImageBuffer(remoteUrl);
    let output = original;
    let contentType = "image/jpeg";

    if(sharp && canWebp){
      output = await sharp(original, { failOn:"none" })
        .resize({ width, height:width, fit:"cover", withoutEnlargement:true })
        .webp({ quality:82, effort:4 })
        .toBuffer();
      contentType = "image/webp";
    }

    try{ fs.writeFileSync(filePath, output); }catch(_e){}
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("Content-Type", contentType);
    return res.send(output);
  }catch(e){
    console.error("optimized image error:", e && e.message ? e.message : e);
    return res.status(502).send("image optimize failed");
  }
});

const DATA_DIR = path.join(__dirname, "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");
const GAMES_PATH = path.join(DATA_DIR, "games.json");
const ALL_GAMES_PATH = path.join(DATA_DIR, "all_games.json");
const DISCOUNT_BANNERS_PATH = path.join(DATA_DIR, "discount_banners.json");
const DESCRIPTION_BACKFILL_STATE_PATH = path.join(DATA_DIR, "description_backfill_state.json");

const PUBLIC_DIR = path.join(__dirname, "public");
const BANNERS_DIR = path.join(PUBLIC_DIR, "banners");
// Admin-only list for upcoming releases (not shown on public site yet)
const PREORDERS_PATH = path.join(DATA_DIR, "preorders.json");
const NEW_RELEASES_PATH = path.join(DATA_DIR, "newreleases.json");

// Ensure banner directory exists (for admin-uploaded discount banners)
try{ fs.mkdirSync(BANNERS_DIR, { recursive: true }); }catch(_){ }

function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  const env = {};
  if (!fs.existsSync(envPath)) return env;
  for (const line of fs.readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}
const ENV = loadEnv();
const TR_LOCALE = (ENV.TR_LOCALE || "tr-tr").trim();
const UA_LOCALE = (ENV.UA_LOCALE || "ru-ua").trim();

function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return fallback; } }
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf-8"); }

// --- Visitors counter (admin-only) ---
// We store rolling per-hour buckets for the last 24 hours.
// File format:
// { updatedAt, buckets: { [hourIso]: { total:number, ips:string[] } } }
function hourKeyIso(d){
  const dt = new Date(d);
  dt.setMinutes(0,0,0);
  return dt.toISOString();
}

function hashIp(ip){
  // Store only a hash for privacy; good enough for unique count.
  return crypto.createHash("sha1").update(String(ip||""), "utf8").digest("hex");
}

function readVisitors(){
  const doc = readJson(VISITORS_PATH, { updatedAt:null, buckets:{} });
  if(!doc || typeof doc !== 'object') return { updatedAt:null, buckets:{} };
  if(!doc.buckets || typeof doc.buckets !== 'object') doc.buckets = {};
  return doc;
}

function writeVisitors(doc){
  try{ writeJson(VISITORS_PATH, doc); }catch(_e){}
}

function pruneVisitors(doc, now=new Date()){
  const cutoff = now.getTime() - 24*60*60*1000;
  const out = { updatedAt: new Date().toISOString(), buckets:{} };
  const buckets = doc && doc.buckets ? doc.buckets : {};
  for(const [k,v] of Object.entries(buckets)){
    const t = Date.parse(k);
    if(!Number.isFinite(t)) continue;
    if(t >= cutoff) out.buckets[k] = v;
  }
  return out;
}

function recordVisit(req){
  try{
    // Best-effort: count only real page views (not APIs/assets)
    if(req.method !== 'GET') return;
    const p = String(req.path||'');
    if(p.startsWith('/api')) return;
    if(p.startsWith('/ps95_manage')) return;
    if(p.startsWith('/admin')) return;
    if(p.startsWith('/styles') || p.startsWith('/snow') || p.startsWith('/banners') || p.startsWith('/img')) return;
    if(/\.(js|css|png|jpg|jpeg|webp|svg|ico|map)$/i.test(p)) return;

    const now = new Date();
    const key = hourKeyIso(now);
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || req.connection?.remoteAddress || '';
    const hip = hashIp(ip);

    let doc = pruneVisitors(readVisitors(), now);
    if(!doc.buckets[key]) doc.buckets[key] = { total:0, ips:[] };
    const b = doc.buckets[key];
    b.total = Number(b.total||0) + 1;
    if(hip && !b.ips.includes(hip)){
      // Keep the list bounded per hour to avoid accidental growth
      if(b.ips.length < 20000) b.ips.push(hip);
    }
    doc.updatedAt = new Date().toISOString();
    writeVisitors(doc);
  }catch(_e){}
}

function visitorsStatsLast24(doc, now=new Date()){
  const cutoff = now.getTime() - 24*60*60*1000;
  const buckets = doc && doc.buckets ? doc.buckets : {};
  const byHour = [];
  let total = 0;
  const uniq = new Set();
  for(const [k,v] of Object.entries(buckets)){
    const t = Date.parse(k);
    if(!Number.isFinite(t) || t < cutoff) continue;
    const tot = Number(v?.total||0) || 0;
    const ips = Array.isArray(v?.ips) ? v.ips : [];
    total += tot;
    for(const h of ips) uniq.add(h);
    byHour.push({ hour:k, total:tot, unique: ips.length });
  }
  byHour.sort((a,b)=> a.hour.localeCompare(b.hour));
  return { total24h: total, unique24h: uniq.size, byHour };
}

function todayYMDAmsterdam(){
  // yyyy-mm-dd in Europe/Amsterdam, stable for lexicographic comparisons
  try{
    return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam' }).format(new Date());
  }catch(_e){
    return new Date().toISOString().slice(0,10);
  }
}


function isFutureReleaseDateYMD(dateStr){
  const d = dateStr ? String(dateStr).slice(0,10) : '';
  if(!/^20\d{2}-\d{2}-\d{2}$/.test(d)) return false;
  return d > todayYMDAmsterdam();
}

function addOneMonthYMD(dateStr){
  const d = String(dateStr || '').slice(0,10);
  if(!/^20\d{2}-\d{2}-\d{2}$/.test(d)) return '';
  const [y,m,day] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  const originalDay = dt.getUTCDate();
  dt.setUTCMonth(dt.getUTCMonth() + 1);
  // JS overflows dates like Jan 31 -> Mar 03; clamp to last day of target month.
  if(dt.getUTCDate() !== originalDay) dt.setUTCDate(0);
  return dt.toISOString().slice(0,10);
}

function isActiveNewReleaseByReleaseDate(dateStr){
  const d = String(dateStr || '').slice(0,10);
  if(!/^20\d{2}-\d{2}-\d{2}$/.test(d)) return true;
  const today = todayYMDAmsterdam();
  return d <= today && today < addOneMonthYMD(d);
}

function readNewReleasesDoc(){
  const doc = readJson(NEW_RELEASES_PATH, { updatedAt:null, items:[] });
  if(!doc || typeof doc !== 'object') return { updatedAt:null, items:[] };
  if(!Array.isArray(doc.items)) doc.items = [];
  return doc;
}

function pruneExpiredNewReleases(){
  const doc = readNewReleasesDoc();
  const before = doc.items.length;
  const items = doc.items.filter(g => isActiveNewReleaseByReleaseDate(g && g.releaseDate));
  if(items.length !== before){
    writeJson(NEW_RELEASES_PATH, { updatedAt: new Date().toISOString(), items });
  }
  return { pruned: before - items.length, items };
}

function addItemsToNewReleases(itemsToAdd){
  const doc = readNewReleasesDoc();
  const items = Array.isArray(doc.items) ? doc.items.filter(g => isActiveNewReleaseByReleaseDate(g && g.releaseDate)) : [];
  const existingIds = new Set(items.map(x => String(x && x.id || '').trim()).filter(Boolean));
  let added = 0;
  for(const g of (Array.isArray(itemsToAdd) ? itemsToAdd : [])){
    const id = String(g && g.id || '').trim();
    if(!id || existingIds.has(id)) continue;
    items.unshift(Object.assign({}, g, { addedToNewReleasesAt: new Date().toISOString() }));
    existingIds.add(id);
    added++;
  }
  if(added || items.length !== (doc.items || []).length){
    writeJson(NEW_RELEASES_PATH, { updatedAt: new Date().toISOString(), items });
  }
  return { added, total: items.length };
}

function moveReleasedPreordersToAllGames(){
  // If a preorder has releaseDate <= today, move it into all_games.json and newreleases.json.
  const today = todayYMDAmsterdam();
  const preDoc = readJson(PREORDERS_PATH, { updatedAt:null, items:[] });
  const allDoc = readJson(ALL_GAMES_PATH, { updatedAt:null, items:[] });
  const preItems = Array.isArray(preDoc.items) ? preDoc.items : [];
  const allItems = Array.isArray(allDoc.items) ? allDoc.items : [];

  pruneExpiredNewReleases();
  if(!preItems.length) return { moved:0, addedToNewReleases:0 };

  const canMove = (g)=>{
    const d = g && g.releaseDate ? String(g.releaseDate).slice(0,10) : '';
    if(!d) return false;
    // expects yyyy-mm-dd
    if(!/^20\d{2}-\d{2}-\d{2}$/.test(d)) return false;
    return d <= today;
  };

  const existingIds = new Set(allItems.map(x=>String(x && x.id || '')));

  const keep = [];
  const toMove = [];
  for(const g of preItems){
    if(canMove(g)) toMove.push(g);
    else keep.push(g);
  }
  if(!toMove.length) return { moved:0, addedToNewReleases:0 };

  for(const g of toMove){
    const id = String(g && g.id || '').trim();
    if(!id) continue;
    if(!existingIds.has(id)){
      allItems.unshift(g);
      existingIds.add(id);
    }
  }

  const nr = addItemsToNewReleases(toMove);
  writeJson(PREORDERS_PATH, { updatedAt: new Date().toISOString(), items: keep });
  writeJson(ALL_GAMES_PATH, { updatedAt: new Date().toISOString(), items: allItems });
  return { moved: toMove.length, addedToNewReleases: nr.added };
}

function requireAdmin(req, res, next) {
  const user = ENV.ADMIN_USER || "Sayhan2305";
  const pass = ENV.ADMIN_PASS || "Sayhan1994";
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="PlayStore95 Admin"');
    return res.status(401).json({ error: "auth_required" });
  }
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
  const [u, p] = decoded.split(":");
  if (u === user && p === pass) return next();
  res.setHeader("WWW-Authenticate", 'Basic realm="PlayStore95 Admin"');
  return res.status(401).json({ error: "invalid_credentials" });
}

function defaultDiscountRates(){
  return {
    TR:[
      {min:0,max:97,rate:5.20},{min:97,max:297,rate:4.00},{min:297,max:397,rate:3.60},
      {min:397,max:497,rate:3.30},{min:497,max:597,rate:3.20},{min:597,max:797,rate:3.10},
      {min:797,max:997,rate:3.00},{min:997,max:1297,rate:2.80},{min:1297,max:1497,rate:2.70},
      {min:1497,max:2197,rate:2.60},{min:2197,max:2497,rate:2.50},{min:2497,max:null,rate:2.40}
    ],
    UA:[
      {min:0,max:297,rate:3.60},{min:297,max:397,rate:3.40},{min:397,max:497,rate:3.20},
      {min:497,max:597,rate:3.10},{min:597,max:797,rate:2.95},{min:797,max:1197,rate:2.85},
      {min:1197,max:1597,rate:2.75},{min:1597,max:1897,rate:2.55},{min:1897,max:2097,rate:2.45},
      {min:2097,max:3397,rate:2.40},{min:3397,max:null,rate:2.25}
    ]
  };
}

function readStore() {
  const s = readJson(STORE_PATH, { settings:{roundStep:50, whatsappLink:"", minPriceRub:450}, rates:{TR:[],UA:[]}, discountRates:defaultDiscountRates() });
  if(!s.settings) s.settings = { roundStep:50, whatsappLink:"", minPriceRub:450 };
  if(typeof s.settings.minPriceRub === "undefined") s.settings.minPriceRub = 450;
  if(!s.discountRates) s.discountRates = defaultDiscountRates();
  if(!Array.isArray(s.discountRates.TR)) s.discountRates.TR = defaultDiscountRates().TR;
  if(!Array.isArray(s.discountRates.UA)) s.discountRates.UA = defaultDiscountRates().UA;
  // Subscription prices live in the same store.json and are editable from admin.
  // If missing (older installs) – seed defaults.
  if(!s.subscriptionsPrices){
    s.subscriptionsPrices = {
      TR:{
        psplus:{
          essential:{"1":1200,"3":2400,"12":5850},
          extra:{"1":1600,"3":3550,"12":9750},
          deluxe:{"1":1700,"3":3950,"12":11250},
        },
        eaplay:{"1":1100,"12":4350}
      },
      UA:{
        psplus:{
          essential:{"1":1100,"3":2000,"12":4200},
          extra:{"1":1400,"3":3150,"12":6100},
          deluxe:{"1":1600,"3":3450,"12":6850},
        },
        eaplay:{"1":900,"12":3000}
      }
    };
  }
  if (ENV.WHATSAPP_LINK) s.settings.whatsappLink = ENV.WHATSAPP_LINK;
  if (ENV.ROUND_STEP) s.settings.roundStep = Number(ENV.ROUND_STEP) === 100 ? 100 : 50;
  if (ENV.MIN_PRICE_RUB) {
    const n = Number(ENV.MIN_PRICE_RUB);
    if(Number.isFinite(n) && n > 0) s.settings.minPriceRub = n;
  }
  return s;
}

function clampMinGamePriceRub(store, rub){
  const min = Number(store?.settings?.minPriceRub);
  const m = (Number.isFinite(min) && min > 0) ? min : 450;
  return Math.max(m, Number(rub||0));
}

function pickRate(rules, price) {
  for (const r of rules) {
    const maxOk = (r.max === null) ? true : price < r.max;
    if (price >= r.min && maxOk) return r.rate;
  }
  return rules.length ? rules[rules.length - 1].rate : 1;
}
function roundUp(value, step) { const s = Number(step) || 50; return Math.ceil(value / s) * s; }
function roundDown(value, step) { const s = Number(step) || 50; return Math.floor(value / s) * s; }

// --- parsing helpers
function extractTitle(html){
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? m[1].replace(/\s+/g," ").trim() : null;
}
function extractH1(html){
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if(!m) return null;
  return m[1].replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim() || null;
}
function looksBlocked(html){
  const h = String(html||"");
    const bad = /(Sorry, you have been blocked|Access Denied|Forbidden|Request blocked|Checking your browser|cf-browser-verification|captcha|Cloudflare)/i.test(h);
  const hasNext = /__NEXT_DATA__|data-reactroot|application\/ld\+json/i.test(h);
  // считаем блокировкой только если есть явные признаки и нет нормального контента
  return bad && !hasNext;
}

async function fetchChihiroTitle(productId, regionOrLocale){
  // Backwards compatible helper used by the importer.
  // Prefer the modern Viewfinder ("chihiro-api/viewfinder") endpoint first,
  // then fall back to the older container API.
  // regionOrLocale can be: "TR" | "UA" or a locale like "en-tr" / "ru-ua".

  const toLocale = (x) => {
    const v = String(x || "").toLowerCase().trim();
    if(v === "tr") return (TR_LOCALE || "tr-tr").toLowerCase();
    if(v === "ua") return (UA_LOCALE || "ru-ua").toLowerCase();
    if(/^([a-z]{2}-[a-z]{2})$/.test(v)) return v;
    return (UA_LOCALE || "ru-ua").toLowerCase();
  };

  const locale = toLocale(regionOrLocale);

  // 1) Viewfinder
  try{
    const obj = await fetchChihiro(locale, productId);
    const t = pickTitleFromChihiro(obj);
    if(t && !looksBlocked(t)) return String(t).trim();
  }catch(_e){}

  // 2) Older container API fallback (kept for compatibility)
  const region = (locale === (UA_LOCALE||"ru-ua").toLowerCase()) ? "UA" : "TR";
  const country = region === "UA" ? "UA" : "TR";
  const lang = region === "UA" ? "ru" : "en";
  const tries = [ { age:"999" }, { age:"19" } ];
  for(const t of tries){
    const url = `https://store.playstation.com/store/api/chihiro/00_09_000/container/${country}/${lang}/${t.age}/${productId}`;
    try{
      const r = await fetch(url, { headers:{
        "User-Agent":"Mozilla/5.0",
        "Accept":"application/json,text/plain,*/*"
      }});
      if(!r.ok) continue;
      const j = await r.json();
      const title = j?.name || j?.long_name || j?.default_sku?.name || j?.default_sku?.title_name || null;
      if(title && !looksBlocked(title)) return String(title).trim();
    }catch(_e){}
  }

  return null;
}
function extractOg(html, prop){
  // Support different attribute orders in <meta> tags.
  // Example A: <meta property="og:title" content="...">
  // Example B: <meta content="..." property="og:title">
  let re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i");
  let m = html.match(re);
  if(m && m[1]) return m[1];
  re = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, "i");
  m = html.match(re);
  return m ? m[1] : null;
}
function extractImgByAlt(html, alt){
  if(!alt) return null;
  const safe = alt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let re = new RegExp(`<img[^>]+alt=["']${safe}["'][^>]+src=["']([^"']+)["']`, "i");
  let m = html.match(re);
  if(m) return m[1];
  re = new RegExp(`<img[^>]+src=["']([^"']+)["'][^>]+alt=["']${safe}["']`, "i");
  m = html.match(re);
  return m ? m[1] : null;
}
function extractFirstHeroImage(html){
  const re = /<img[^>]+src=["']([^"']+store\.playstation\.com[^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["']/ig;
  const m = re.exec(html);
  return m ? m[1] : null;
}
function extractJsonLd(html){
  const out=[];
  const re=/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while((m=re.exec(html))!==null){
    const txt=m[1].trim();
    try{ out.push(JSON.parse(txt)); }catch{}
  }
  return out;
}
function extractAnyImage(jsonLd){
  const pick=(obj)=>{
    if(!obj || typeof obj!=="object") return null;
    if(obj.image){
      if(Array.isArray(obj.image)) return obj.image[0];
      return obj.image;
    }
    return null;
  };
  for(const j of jsonLd){
    const im = pick(j);
    if(im) return im;
    if(j["@graph"] && Array.isArray(j["@graph"])){
      for(const g of j["@graph"]){
        const iim = pick(g);
        if(iim) return iim;
      }
    }
  }
  return null;
}
function extractOfferPrice(jsonLd){
  const scan=(obj)=>{
    if(!obj || typeof obj!=="object") return null;
    if(obj.offers){
      const o=obj.offers;
      if(Array.isArray(o)){
        for(const it of o){
          if(it && it.price) return {price:Number(it.price), currency:it.priceCurrency||null};
        }
      }else if(o.price){
        return {price:Number(o.price), currency:o.priceCurrency||null};
      }
    }
    return null;
  };
  for(const j of jsonLd){
    const r=scan(j);
    if(r && Number.isFinite(r.price)) return r;
    if(j["@graph"] && Array.isArray(j["@graph"])){
      for(const g of j["@graph"]){
        const rr=scan(g);
        if(rr && Number.isFinite(rr.price)) return rr;
      }
    }
  }
  return null;
}
function extractDiscountPercent(html){
  const h = String(html || "");
  const found = [];
  const addMatches = (re, groupIndex=1) => {
    let m;
    while((m = re.exec(h)) !== null){
      const pct = Number(m[groupIndex]);
      if(!Number.isFinite(pct) || pct <= 0 || pct > 100) continue;
      const start = Math.max(0, m.index - 220);
      const end = Math.min(h.length, m.index + m[0].length + 220);
      const ctx = h.slice(start, end).toLowerCase();
      // PS Plus discounts must not become the game's main discount.
      if(/ps\s*plus|playstation\s*plus|ps\+|plus/.test(ctx)) continue;
      found.push(pct);
    }
  };
  addMatches(/Save\s*(\d{1,3})%/gi);
  addMatches(/%(\d{1,3})\s*indirim/gi);
  addMatches(/(\d{1,3})%\s*(?:off|discount|indirim)/gi);
  return found.length ? Math.max(...found) : 0;
}
function extractUntilDate(html){
  let m = html.match(/(20\d{2}-\d{2}-\d{2})/);
  if(m) return m[1];
  m = html.match(/(?:Offer ends|Teklif sonu:)\s*([0-3]?\d)[\/\.]([0-1]?\d)[\/\.](20\d{2})/i);
  if(m){
    const dd=String(m[1]).padStart(2,"0");
    const mm=String(m[2]).padStart(2,"0");
    const yy=m[3];
    return `${yy}-${mm}-${dd}`;
  }
  return null;
}

// Extract discount end date in format yyyy-mm-dd.
// Prefer JSON-LD Offer fields; fall back to HTML text patterns.
function extractDiscountedUntil(html, jsonLd){
  const norm = (v) => {
    if(!v) return null;
    const s = String(v).trim();
    // ISO date or datetime
    const iso = s.match(/(20\d{2}-\d{2}-\d{2})/);
    if(iso) return iso[1];
    // dd/mm/yyyy or dd.mm.yyyy
    let m = s.match(/\b([0-3]?\d)[\/\.]([0-1]?\d)[\/\.](20\d{2})\b/);
    if(m){
      const dd=String(m[1]).padStart(2,"0");
      const mm=String(m[2]).padStart(2,"0");
      return `${m[3]}-${mm}-${dd}`;
    }
    return null;
  };

  const scanOffers = (obj) => {
    if(!obj || typeof obj !== "object") return null;
    const offers = obj.offers;
    if(offers){
      const arr = Array.isArray(offers) ? offers : [offers];
      for(const o of arr){
        if(!o || typeof o !== "object") continue;
        const d = norm(o.priceValidUntil || o.validThrough || o.availabilityEnds || o.endDate);
        if(d) return d;
      }
    }
    return null;
  };

  // 1) JSON-LD structured data
  try{
    if(Array.isArray(jsonLd)){
      for(const j of jsonLd){
        const d1 = scanOffers(j);
        if(d1) return d1;
        if(j && j["@graph"] && Array.isArray(j["@graph"])){
          for(const g of j["@graph"]){
            const d2 = scanOffers(g);
            if(d2) return d2;
          }
        }
      }
    }
  }catch(_e){}

  // 2) Visible HTML (multi-locale)
  if(html){
    const h = String(html).slice(0, 250000);
    // Common strings across locales
    const patterns = [
      /(?:Offer ends|Deal ends|Ends|Teklif sonu:|Teklif bitiş|İndirim bitiş)\s*[:\-–]?\s*([0-3]?\d)[\/\.]([0-1]?\d)[\/\.](20\d{2})/i,
      /(?:Предложение действует до|Скидка действует до|Акция заканчивается|Знижка діє до|Пропозиція діє до)\s*[:\-–]?\s*([0-3]?\d)[\.\/]([0-1]?\d)[\.\/]?(20\d{2})/i,
      /(20\d{2}-\d{2}-\d{2})/
    ];
    for(const re of patterns){
      const m = h.match(re);
      if(!m) continue;
      if(m[1] && m[2] && m[3]){
        const dd=String(m[1]).padStart(2,"0");
        const mm=String(m[2]).padStart(2,"0");
        return `${m[3]}-${mm}-${dd}`;
      }
      if(m[1] && /^20\d{2}-/.test(m[1])) return m[1];
    }
  }

  return null;
}





function normalizeGameMetaField(v){
  if(v === null || typeof v === "undefined") return null;
  const s = String(v).replace(/\s+/g," ").trim();
  return s || null;
}
function normalizeRatingValue(v){
  if(v === null || typeof v === "undefined") return null;
  let s = String(v).replace(",", ".").trim();
  const m = s.match(/(\d+(?:\.\d+)?)/);
  if(!m) return null;
  const n = Number(m[1]);
  if(!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(5, n));
}
function extractGameMeta(html, jsonLd){
  const text = String(html||"")
    .replace(/<script[\s\S]*?<\/script>/gi," ")
    .replace(/<style[\s\S]*?<\/style>/gi," ")
    .replace(/<[^>]+>/g," ")
    .replace(/&nbsp;|&#160;/gi," ")
    .replace(/&amp;/gi,"&")
    .replace(/\s+/g," ")
    .trim();
  const lower = text.toLowerCase();

  let rating = null;
  const walk = (node)=>{
    if(!node || rating !== null) return;
    if(Array.isArray(node)){ node.forEach(walk); return; }
    if(typeof node === 'object'){
      const ar = node.aggregateRating || node.aggregateRatings || null;
      if(ar && typeof ar === 'object'){
        rating = normalizeRatingValue(ar.ratingValue || ar.rating || ar.value);
        if(rating !== null) return;
      }
      if(node.ratingValue || node.rating){
        rating = normalizeRatingValue(node.ratingValue || node.rating);
        if(rating !== null) return;
      }
      Object.values(node).forEach(walk);
    }
  };
  try{ walk(jsonLd); }catch(_e){}
  if(rating === null){
    const m = text.match(/(?:rating|рейтинг|оценка)\s*[:：]?\s*(\d+(?:[.,]\d+)?)\s*(?:\/|из)\s*5/i) || text.match(/(\d+(?:[.,]\d+)?)\s*(?:\/|из)\s*5\s*(?:stars|зв[её]зд)/i);
    if(m) rating = normalizeRatingValue(m[1]);
  }

  let size = null;
  const sizeMatch = text.match(/(?:Размер|File size|Size|Storage|Место на диске|Память)\s*[:：]?\s*(\d+(?:[.,]\d+)?\s*(?:ГБ|GB|МБ|MB))/i) || text.match(/\b(\d+(?:[.,]\d+)?\s*(?:ГБ|GB|МБ|MB))\b/i);
  if(sizeMatch) size = normalizeGameMetaField(sizeMatch[1].replace(/GB/i,'ГБ').replace(/MB/i,'МБ').replace('.',','));

  let players = null;
  const playerPatterns = [
    /(?:Offline players|Players|Игроки|Локальные игроки|Количество игроков)\s*[:：]?\s*(\d+\s*[-–—]\s*\d+|\d+)\s*(?:players?|игрока?|игроков)?/i,
    /(\d+\s*[-–—]\s*\d+|\d+)\s*(?:offline\s*)?(?:players?|игрока?|игроков)\b/i
  ];
  for(const re of playerPatterns){
    const m = text.match(re);
    if(m){
      const v = String(m[1]).replace(/[–—]/g,'-').replace(/\s+/g,'');
      if(/^\d+(?:-\d+)?$/.test(v)){
        players = v === '1' ? '1 игрок' : `${v} игрока`;
        break;
      }
    }
  }
  return { players: normalizeGameMetaField(players), size: normalizeGameMetaField(size), rating };
}

// Extract release date in format yyyy-mm-dd.
// Used for "Предзаказы" in admin.
function extractReleaseDate(html, jsonLd){
  const norm = (v) => {
    if(!v) return null;
    const s = String(v).trim();
    // ISO date or datetime
    const iso = s.match(/(20\d{2}-\d{2}-\d{2})/);
    if(iso) return iso[1];
    // dd/mm/yyyy or dd.mm.yyyy
    const m = s.match(/\b([0-3]?\d)[\/.]([0-1]?\d)[\/.](20\d{2})\b/);
    if(m){
      const dd = String(m[1]).padStart(2,"0");
      const mm = String(m[2]).padStart(2,"0");
      return `${m[3]}-${mm}-${dd}`;
    }
    return null;
  };

  // 1) JSON-LD (SoftwareApplication / Product / Game)
  try{
    const walk = (node) => {
      if(!node) return null;
      if(Array.isArray(node)){
        for(const it of node){
          const r = walk(it);
          if(r) return r;
        }
        return null;
      }
      if(typeof node === "object"){
        const d = norm(node.releaseDate || node.datePublished || node.dateCreated || node.availableFrom);
        if(d) return d;
        if(node.offers){
          const offers = Array.isArray(node.offers) ? node.offers : [node.offers];
          for(const o of offers){
            const od = norm(o.validFrom || o.availabilityStarts || o.releaseDate || o.datePublished);
            if(od) return od;
          }
        }
        for(const v of Object.values(node)){
          const r = walk(v);
          if(r) return r;
        }
      }
      return null;
    };

    if(Array.isArray(jsonLd)){
      for(const j of jsonLd){
        const r = walk(j);
        if(r) return r;
        if(j && j["@graph"] && Array.isArray(j["@graph"])){
          const rr = walk(j["@graph"]);
          if(rr) return rr;
        }
      }
    }
  }catch(_e){}

  // 2) Embedded JSON in HTML (common)
  if(html){
    const h = String(html).slice(0, 300000);
    const candidates = [
      /"releaseDate"\s*:\s*"([^"]+)"/i,
      /"release_date"\s*:\s*"([^"]+)"/i,
      /"datePublished"\s*:\s*"([^"]+)"/i,
      /"availableFrom"\s*:\s*"([^"]+)"/i
    ];
    for(const re of candidates){
      const m = h.match(re);
      if(m){
        const d = norm(m[1]);
        if(d) return d;
      }
    }
    // Visible text fallback (multi-locale)
    const m2 = h.match(/(?:Release\s*date|Çıkış\s*tarihi|Дата\s*выхода|Дата\s*виходу)\s*[:\-–]?\s*([0-3]?\d)[\/.]([0-1]?\d)[\/.](20\d{2})/i);
    if(m2){
      const dd = String(m2[1]).padStart(2,"0");
      const mm = String(m2[2]).padStart(2,"0");
      return `${m2[3]}-${mm}-${dd}`;
    }
  }

  return null;
}
// --- Platform extraction helpers (Importer) ---
function _normPlatformToken(v){
  if(!v) return "";
  let s = String(v).toLowerCase();
  s = s.replace(/[\u00ae\u2122]/g, ""); // ® ™
  s = s.replace(/playstation\s*5/g, "ps5").replace(/playstation\s*4/g, "ps4");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}
function _addPlatform(set, token){
  const s = _normPlatformToken(token);
  if(!s) return;
  if(/\bps4\b/.test(s)) set.add("PS4");
  if(/\bps5\b/.test(s)) set.add("PS5");
}
function extractPlatformsFromHtml(html){
  const set = new Set();
  if(!html) return set;
  // IMPORTANT: don't scan the whole HTML for lone "PS4"/"PS5" tokens.
  // The Store page contains many unrelated references that cause false "PS4 / PS5".
  // We only trust strong, user-visible signals:
  //   1) Combined "PS4/PS5" style strings
  //   2) Title/H1/meta-title mentioning platform(s)
  const h = String(html).slice(0, 250000);

  // 1) Strong combined signal
  if(/ps4[\u00ae\u2122]?\s*(\/|\||,|&|и|and)\s*ps5[\u00ae\u2122]?/i.test(h) ||
     /ps5[\u00ae\u2122]?\s*(\/|\||,|&|и|and)\s*ps4[\u00ae\u2122]?/i.test(h)){
    set.add("PS4");
    set.add("PS5");
    return set;
  }

  // 2) Extract a small, relevant text surface (title/meta/h1) and detect there.
  const head = String(html).slice(0, 200000);
  const title = (head.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i)?.[1] || "").replace(/<[^>]+>/g," ");
  const h1 = (head.match(/<h1[^>]*>([\s\S]{0,300}?)<\/h1>/i)?.[1] || "").replace(/<[^>]+>/g," ");
  const ogt = (head.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i)?.[1]
            || head.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["'][^>]*>/i)?.[1]
            || "");
  const surface = `${title} ${h1} ${ogt}`;
  _addPlatform(set, surface);
  return set;
}

function extractPlatformsFromJsonLd(jsonLd){
  const set = new Set();
  if(!jsonLd) return set;

  const walk = (node) => {
    if(!node) return;
    if(Array.isArray(node)){ for(const x of node) walk(x); return; }
    if(typeof node === "object"){
      for(const [k,v] of Object.entries(node)){
        const key = String(k).toLowerCase();
        if(key === "gameplatform" || key === "platforms" || key === "platform" || key === "game_platform"){
          if(Array.isArray(v)){
            for(const it of v){
              if(typeof it === "string") _addPlatform(set, it);
              else if(it && typeof it === "object") _addPlatform(set, it.name || it.label || it.id || it.value || it.platform || "");
            }
          }else if(typeof v === "string"){
            _addPlatform(set, v);
          }else if(v && typeof v === "object"){
            _addPlatform(set, v.name || v.label || v.id || v.value || v.platform || "");
          }
        }
        walk(v);
      }
    }
  };
  walk(jsonLd);
  return set;
}

function pickPlatformsFromChihiro(obj){
  const set = new Set();
  if(!obj) return set;

  const walk = (node) => {
    if(!node) return;
    if(Array.isArray(node)){ for(const x of node) walk(x); return; }
    if(typeof node === "object"){
      for(const [k,v] of Object.entries(node)){
        const key = String(k).toLowerCase();
        if(key === "platforms" || key === "platform" || key === "gameplatform" || key === "game_platform" || key === "playableplatforms"){
          if(Array.isArray(v)){
            for(const it of v){
              if(typeof it === "string") _addPlatform(set, it);
              else if(it && typeof it === "object") _addPlatform(set, it.name || it.label || it.id || it.value || it.platform || "");
            }
          }else if(typeof v === "string"){
            _addPlatform(set, v);
          }else if(v && typeof v === "object"){
            _addPlatform(set, v.name || v.label || v.id || v.value || v.platform || "");
          }
        }
        walk(v);
      }
    }
  };
  walk(obj);
  return set;
}

function finalizePlatform(platformSet, productId){
  const set = platformSet || new Set();
  if(set.has("PS4") && set.has("PS5")) return "PS4 / PS5";
  if(set.has("PS5")) return "PS5";
  if(set.has("PS4")) return "PS4";

  // Fallback: infer from productId
  const pid = String(productId||"").toUpperCase();
  if(pid.includes("CUSA")) return "PS4";
  if(pid.includes("PPSA")) return "PS5";
  return "PS4 / PS5";
}

async function fetchChihiroPlatforms(productId, locale){
  try{
    const obj = await fetchChihiro(locale, productId);
    const set = pickPlatformsFromChihiro(obj);
    return finalizePlatform(set, productId);
  }catch(_e){
    return null;
  }
}

async function fetchPlatformsFromAltLocales(productId){
  const locales = ["ru-ua","en-tr","en-us","en-gb","de-de","fr-fr","es-es","it-it","pl-pl"];
  let best = null;
  for(const loc of locales){
    const p = await fetchChihiroPlatforms(productId, loc);
    if(!p) continue;
    if(p === "PS4 / PS5") return p; // strongest
    if(p === "PS4" || p === "PS5") best = p;
  }
  return best;
}



function extractEditionFromText(txt){
  if(!txt) return null;
  const s = String(txt);
  // Common edition keywords (keep it simple and robust)
  const patterns = [
    /\b(Standard|Premium|Ultimate|Gold|Complete|Definitive|Anniversary)\s+Edition\b/i,
    /\b(Digital\s+Deluxe)\b/i,
    /\bDeluxe\s+Edition\b/i,
    /\bCollector'?s\s+Edition\b/i,
    /\b(Game\s+of\s+the\s+Year)\b/i,
    /\b(Deluxe|Ultimate|Premium)\s+Bundle\b/i
  ];
  for(const re of patterns){
    const m = s.match(re);
    if(m && m[0]){
      let out = m[0].replace(/\s+/g," ").trim();
      // normalize Digital Deluxe -> Digital Deluxe Edition
      if(/^digital\s+deluxe$/i.test(out)) out = "Digital Deluxe Edition";
      // normalize GOTY
      if(/^game\s+of\s+the\s+year$/i.test(out)) out = "Game of the Year Edition";
      // Title-case first letters lightly
      out = out.split(" ").map(w => w ? (w[0].toUpperCase() + w.slice(1).toLowerCase()) : w).join(" ");
      // Keep abbreviations like "of", "the"
      out = out.replace(/\bOf\b/g,"of").replace(/\bThe\b/g,"the");
      return out;
    }
  }
  return null;
}

function extractEdition(jsonLd, title, html){
  // 1) from title/meta name
  let ed = extractEditionFromText(title);
  if(ed) return ed;

  // 2) from JSON-LD name/description
  try{
    const j = jsonLd;
    if(j){
      const names = [];
      const pushName = (x)=>{ if(x) names.push(String(x)); };
      if(Array.isArray(j)){
        for(const it of j){
          if(it && it.name) pushName(it.name);
          if(it && it.description) pushName(it.description);
        }
      }else if(typeof j === "object"){
        if(j.name) pushName(j.name);
        if(j.description) pushName(j.description);
      }
      for(const n of names){
        ed = extractEditionFromText(n);
        if(ed) return ed;
      }
    }
  }catch(_){}

  // 3) brute-force search in HTML (rarely needed)
  if(html){
    const m = String(html).match(/\b(Standard|Premium|Ultimate|Gold|Complete|Definitive|Anniversary)\s+Edition\b/i)
      || String(html).match(/\bDeluxe\s+Edition\b/i)
      || String(html).match(/\bDigital\s+Deluxe\b/i);
    if(m && m[0]) return extractEditionFromText(m[0]);
  }
  return null;
}


app.get("/api/meta", (req, res) => {
  const store = readStore();
  const games = readJson(GAMES_PATH, { updatedAt:null, items:[] });
  const allGames = readJson(ALL_GAMES_PATH, { updatedAt:null, items:[] });
  const preorders = readJson(PREORDERS_PATH, { updatedAt:null, items:[] });
  const hasAnyUntil = { TR:false, UA:false };
  for (const g of (games.items||[])) {
    for (const r of ["TR","UA"]) {
      if (g.regions && g.regions[r] && g.regions[r].discountedUntil) hasAnyUntil[r]=true;
    }
  }
  res.json({
    settings: store.settings,
    discountRates: store.discountRates || defaultDiscountRates(),
    updatedAt: { games: games.updatedAt || null },
    hasAnyUntil,
    total: Array.isArray(games.items) ? games.items.length : 0,
    allGamesTotal: Array.isArray(allGames.items) ? allGames.items.length : 0,
    preordersTotal: Array.isArray(preorders.items) ? preorders.items.length : 0,
  });
});

// Public: subscription prices (editable in admin, stored in data/store.json)
app.get("/api/subscriptions-prices", (req, res) => {
  try{
    const store = readStore();
    res.json(store.subscriptionsPrices || {});
  }catch(e){
    res.status(500).json({ error: "failed_to_read_store" });
  }
});


// --- Smart search / platform helpers ---
function normText(s){
  return String(s||"")
    .toLowerCase()
    .replace(/ё/g,"е")
    .replace(/[^a-z0-9а-я]+/gi," ")
    .replace(/\s+/g," ")
    .trim();
}

function normalizeRuVal(v){
  const s = String(v||"").toLowerCase().trim();
  if(!s) return "none";
  if(s==="unknown" || s.includes("неизвест")) return "unknown";
  if(s==="voice" || s.includes("озвуч") || s.includes("voice")) return "voice";
  if(s==="text" || s.includes("текст") || s.includes("sub") || s.includes("screen")) return "text";
  if(s==="none" || s.includes("отсут")) return "none";
  return "none";
}

// ---------------- Active discounts overlay ----------------
function parseDateSafe(v){
  if(!v) return null;
  const d = new Date(String(v));
  return Number.isFinite(d.getTime()) ? d : null;
}

function isDiscountActiveForRegion(reg){
  if(!reg) return false;
  const perc = Number(reg.discPerc || 0) || 0;
  if(perc <= 0) return false;
  // If no end date provided — treat as active (admin might set it manually)
  if(!reg.discountedUntil) return true;

  // IMPORTANT:
  // In our data, `discountedUntil` is often stored as a date-only string (YYYY-MM-DD)
  // meaning "valid through that day". If we parse it as a Date, JS treats it as
  // midnight UTC, which makes the discount look expired for most of the day.
  // So for date-only values, compare as YMD in Europe/Amsterdam.
  const untilRaw = String(reg.discountedUntil || "").trim();
  if(/^\d{4}-\d{2}-\d{2}$/.test(untilRaw)){
    // inclusive: active if until day is today or in the future
    return untilRaw >= todayYMDAmsterdam();
  }

  const until = parseDateSafe(untilRaw);
  if(!until) return true;
  return until.getTime() > Date.now();
}

// Build map of currently discounted games (by internal id and by conceptId)
function readActiveDiscountsIndex(){
  const doc = readJson(GAMES_PATH, { updatedAt:null, items:[] });
  const items = Array.isArray(doc.items) ? doc.items : [];
  const byId = new Map();
  for(const g of items){
    if(!g || !g.regions) continue;
    // Keep discounts exact: one product/version must not give a discount to another edition.
    const tr = g.regions.TR;
    const ua = g.regions.UA;
    if(!isDiscountActiveForRegion(tr) && !isDiscountActiveForRegion(ua)) continue;
    if(g.id) byId.set(String(g.id), g);
  }
  return { byId, updatedAt: doc.updatedAt || null };
}
function pruneExpiredDiscountItems(){
  const doc = readJson(GAMES_PATH, { updatedAt:null, items:[] });
  const items = Array.isArray(doc.items) ? doc.items : [];
  const activeItems = [];
  const activeProductIds = new Set();

  for(const g of items){
    if(!g || !g.regions) continue;
    const trActive = isDiscountActiveForRegion(g.regions.TR);
    const uaActive = isDiscountActiveForRegion(g.regions.UA);
    if(!trActive && !uaActive) continue;

    activeItems.push(g);
    if(g.id) activeProductIds.add(String(g.id).toUpperCase().trim());
  }

  return {
    activeItems,
    activeProductIds,
    removedExpired: Math.max(0, items.length - activeItems.length),
    previousCount: items.length
  };
}

function hasActiveDiscountForAnyTrProduct(g, activeProductIds){
  if(!g || !activeProductIds || typeof activeProductIds.has !== 'function') return false;
  if(g.id && activeProductIds.has(String(g.id).toUpperCase().trim())) return true;
  for(const pid of collectTrProductIdsFromGame(g)){
    if(activeProductIds.has(String(pid).toUpperCase().trim())) return true;
  }
  return false;
}

function mergeDiscountItemsById(existingItems, newItems){
  const byId = new Map();
  for(const g of (Array.isArray(existingItems) ? existingItems : [])){
    if(g && g.id) byId.set(String(g.id), g);
  }
  for(const g of (Array.isArray(newItems) ? newItems : [])){
    if(g && g.id) byId.set(String(g.id), g);
  }
  return Array.from(byId.values());
}


function smartMatch(name, q){
  const nq0 = normText(q);
  if(!nq0) return true;

  const nn = normText(name);
  if(!nn) return false;

  // Expand common abbreviations / equivalents used by players.
  // - "gta" -> "grand theft auto" (so "gta 5" finds "Grand Theft Auto V")
  // - roman numerals / digits equivalence for common cases ("v" <-> "5")
  const rawTokens = nq0.split(" ").filter(Boolean);
  const tokens = [];
  for(const t0 of rawTokens){
    const t = String(t0);
    if(t === "gta"){
      tokens.push("grand","theft","auto");
      continue;
    }
    tokens.push(t);
  }

  return tokens.every(t => {
    if(t === "5") return nn.includes("5") || nn.includes("v");
    if(t === "v") return nn.includes("v") || nn.includes("5");
    return nn.includes(t);
  });
}

// Relevance scoring for search results.
// Higher score = closer match to the query.
function relevanceScore(name, q){
  const nq = normText(q);
  if(!nq) return 0;

  const nn = normText(name);
  if(!nn) return 0;

  // Exact and phrase matches first
  if(nn === nq) return 400;
  if(nn.startsWith(nq)) return 320;
  if(nn.includes(nq)) return 240;

  // Token-level heuristics (all tokens are guaranteed to be included by smartMatch)
  const tokens = nq.split(" ").filter(Boolean);
  const words = nn.split(" ").filter(Boolean);

  let score = 180;

  // Boost if tokens match word starts (e.g. "gta sa")
  let starts = 0;
  for(const t of tokens){
    if(words.some(w => w.startsWith(t))) starts++;
  }
  score += Math.min(80, starts * 20);

  // Slight boost for shorter names (closer match)
  const diff = Math.abs(nn.length - nq.length);
  score += Math.max(0, 40 - Math.min(40, diff));

  return score;
}
function platformPass(gamePlatform, filter){
  const f = String(filter||"").trim().toUpperCase();
  if(!f) return true; // PS4/PS5 -> no filter
  const gp = String(gamePlatform||"").toUpperCase();
  if(f==="PS4") return gp.includes("PS4");
  if(f==="PS5") return gp.includes("PS5");
  return true;
}
// --- end helpers ---
app.get("/api/discount-dates", (req, res) => {
  try {
    const region = String(req.query.region || "TR").toUpperCase();
    const gamesDoc = readJson(GAMES_PATH, { updatedAt:null, items:[] });
    const all = Array.isArray(gamesDoc.items) ? gamesDoc.items : [];
    const norm = (v) => String(v || "").split("T")[0];

    const counts = {};
    for (const g of all) {
      // Дату скидки берём из данных игры по выбранному региону
      const until = norm(g && g.regions && g.regions[region] ? (g.regions[region].discountedUntil || "") : "");
      if (!until) continue;
      counts[until] = (counts[until] || 0) + 1;
    }

    const dates = Object.keys(counts).sort((a,b)=> a.localeCompare(b));
    res.json({ region, dates: dates.map(d => ({ date: d, count: counts[d] })) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Public: mapping date(YYYY-MM-DD) -> banner URL
app.get("/api/discount-banners", (req, res) => {
  try{
    const doc = readJson(DISCOUNT_BANNERS_PATH, { banners: {} });
    const banners = (doc && doc.banners && typeof doc.banners === "object") ? doc.banners : (doc||{});
    return res.json({ ok:true, banners });
  }catch(e){
    return res.json({ ok:false, banners:{} });
  }
});


function attachPublicEditions(items){
  if(!Array.isArray(items) || !items.length) return items;
  const editionPriority = (name)=>{
    const s = String(name||'');
    if(/\bstandard\b/i.test(s) && /\bedition\b/i.test(s)) return 0;
    if(/\bdigital\s+deluxe\b/i.test(s)) return 1;
    if(/\bdeluxe\b/i.test(s) && /\bedition\b/i.test(s)) return 1;
    if(/\bspecial\b/i.test(s) && /\bedition\b/i.test(s)) return 2;
    if(/\bultimate\b/i.test(s) && /\bedition\b/i.test(s)) return 3;
    if(/\bgold\b/i.test(s) && /\bedition\b/i.test(s)) return 4;
    if(/\bcomplete\b/i.test(s) && /\bedition\b/i.test(s)) return 5;
    if(/\bdefinitive\b/i.test(s) && /\bedition\b/i.test(s)) return 6;
    if(/\bbundle\b/i.test(s) || /\bpack\b/i.test(s)) return 8;
    return 9;
  };
  const groups = new Map();
  for(const it of items){
    const conceptKey = String(it.conceptId || '').trim();
    const titleKey = normText(baseTitleForRank(it.name || '')) || normText(it.name || '');
    const key = conceptKey ? `c:${conceptKey}` : `t:${titleKey}`;
    if(!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  for(const it of items){
    const conceptKey = String(it.conceptId || '').trim();
    const titleKey = normText(baseTitleForRank(it.name || '')) || normText(it.name || '');
    const key = conceptKey ? `c:${conceptKey}` : `t:${titleKey}`;
    const group = (groups.get(key) || []).slice().sort((a,b)=>{
      const pa=editionPriority(a.edition || a.name), pb=editionPriority(b.edition || b.name);
      if(pa!==pb) return pa-pb;
      return (Number(a.finalPriceRub||0)-Number(b.finalPriceRub||0)) || String(a.name||'').localeCompare(String(b.name||''));
    });
    it.editions = group.map(e=>({
      id:e.id,
      name:e.name,
      edition:e.edition || 'Standard Edition',
      platform:e.platform || '',
      cover:e.cover || '',
      ru:e.ru || 'none',
      sub:e.sub || '',
      discPerc:Number(e.discPerc||0)||0,
      discountedUntil:e.discountedUntil || null,
      players:e.players || null,
      finalPriceRub:Number(e.finalPriceRub||0)||0,
      oldPriceRub:Number(e.oldPriceRub||0)||0,
      description:e.description || '',
      releaseDate:e.releaseDate || null,
      isPreorder:!!e.isPreorder
    }));
  }
  return items;
}

app.get("/api/games", (req, res) => {
  try {
    const store = readStore();
    const region = String(req.query.region || "TR").toUpperCase();
    const sort = String(req.query.sort || "pop");
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
    let perPage = 24;
    if(req.query.perPage){
      const n = parseInt(String(req.query.perPage),10);
      if(Number.isFinite(n) && n>0) perPage = Math.min(50, Math.max(1, n));
    }
    const q = String(req.query.q || "").trim();
    const platform = String(req.query.platform || "").trim();
    const until = String(req.query.until || req.query.discountedUntil || "").trim();

    const gamesDoc = readJson(GAMES_PATH, { updatedAt:null, items:[] });
    let all = Array.isArray(gamesDoc.items) ? gamesDoc.items : [];
    if (q) all = all.filter(x => smartMatch(x.name || "", q));
    if (platform) all = all.filter(x => platformPass(x.platform || "", platform));

    const rules = store.rates[region] || [];
    const step = store.settings.roundStep || 50;

    const discountsIndex = readActiveDiscountsIndex();
    const descIndex = buildDescriptionIndex();
    const conceptIndex = buildConceptIndex();
    const allGamesDocForPlayers = readJson(ALL_GAMES_PATH, { updatedAt:null, items:[] });
    const allGamesPlayersById = new Map();
    for(const ag of (Array.isArray(allGamesDocForPlayers.items) ? allGamesDocForPlayers.items : [])){
      const playersVal = normalizeGameMetaField(ag.players);
      if(!playersVal) continue;
      const keys = [ag.id, ag.conceptId];
      if(ag.productIds && typeof ag.productIds === 'object') keys.push(ag.productIds.TR, ag.productIds.UA);
      if(ag.regions && typeof ag.regions === 'object'){
        for(const rg of Object.values(ag.regions)){
          if(rg && typeof rg === 'object') keys.push(rg.id, rg.productId, rg.storeId);
        }
      }
      for(const key of keys){
        const k = String(key || '').trim();
        if(k && !allGamesPlayersById.has(k)) allGamesPlayersById.set(k, playersVal);
      }
    }
    const playersFromAllGames = (g) => {
      const keys = [g.id, g.conceptId];
      if(g.productIds && typeof g.productIds === 'object') keys.push(g.productIds.TR, g.productIds.UA);
      if(g.regions && typeof g.regions === 'object'){
        for(const rg of Object.values(g.regions)){
          if(rg && typeof rg === 'object') keys.push(rg.id, rg.productId, rg.storeId);
        }
      }
      for(const key of keys){
        const k = String(key || '').trim();
        if(k && allGamesPlayersById.has(k)) return allGamesPlayersById.get(k);
      }
      return normalizeGameMetaField(g.players);
    };

    let computed = all.map(g => {
      const reg = (g.regions && g.regions[region]) ? g.regions[region] : null;
      const storePrice = reg ? Number(reg.salePrice || 0) : 0;

      // Hide the game ONLY in the selected region when that region's price is 0 (or missing/invalid).
      // Example: TR=450 -> visible in TR; UA=0 -> hidden in UA.
      if (!Number.isFinite(storePrice) || storePrice <= 0) return null;

      const rate = pickRate(rules, storePrice);
      let rub = roundUp(storePrice * rate, step);
      rub = clampMinGamePriceRub(store, rub);
      const trSub = (g.regions && g.regions.TR && g.regions.TR.sub) ? String(g.regions.TR.sub) : "";
      const uaSub = (g.regions && g.regions.UA && g.regions.UA.sub) ? String(g.regions.UA.sub) : "";
      const anySub = trSub || uaSub;

      const base = {
        id: g.id,
        name: g.name,
        edition: anySub ? "Standard Edition" : (g.edition || "Standard Edition"),
        ru: normalizeRuVal(reg && (reg.ru ?? reg.ruLang ?? reg.russian ?? reg.rus ?? reg.langRu ?? reg.languageRu)),
        // Subscription is not tied to a region in the UI (one badge for the game).
        // Prefer TR value (admin currently sets it there), fallback to UA.
        sub: anySub,
        platform: g.platform || "PS4 / PS5",
        players: playersFromAllGames(g) || null,
        size: g.size || null,
        rating: (typeof g.rating !== "undefined" ? g.rating : null),
        cover: g.cover || "",
        description: descriptionForPublicGame(g, descIndex),
        discPerc: reg ? Number(reg.discPerc || 0) : 0,
        discountedUntil: reg ? (reg.discountedUntil || null) : null,
        storePrice: storePrice,
        finalPriceRub: rub,
        oldPriceRub: (Number(reg && reg.discPerc || 0) > 0 ? clampMinGamePriceRub(store, roundUp((storePrice / Math.max(0.01, (1 - (Number(reg.discPerc||0)/100)))) * pickRate(rules, (storePrice / Math.max(0.01, (1 - (Number(reg.discPerc||0)/100))))), step)) : 0),
        conceptId: conceptForGame(g, conceptIndex),
        popRank: g.popRank || 999999
      };

      if(q) base._score = relevanceScore(g.name || "", q);
      return base;
    });

    // Remove games that were excluded for the selected region (e.g., region price is 0).
    computed = computed.filter(Boolean);

    if (until) {
      const norm = (v) => String(v || "").split("T")[0];
      const target = norm(until);
      computed = computed.filter(g => norm(g.discountedUntil) === target);
    }


    // When searching, show the closest matches first, then apply the selected sort as a tiebreaker.
    const tieBySort = (a,b)=>{
      if (sort === "price_desc") return (b.finalPriceRub-a.finalPriceRub) || ((a.popRank||0)-(b.popRank||0));
      if (sort === "price_asc") return (a.finalPriceRub-b.finalPriceRub) || ((a.popRank||0)-(b.popRank||0));
      return (a.popRank||0)-(b.popRank||0);
    };

    if(q){
      computed.sort((a,b)=> (Number(b._score||0)-Number(a._score||0)) || tieBySort(a,b));
    }else{
      computed.sort(tieBySort);
    }

    attachPublicEditions(computed);

    const total = computed.length;
    const startIndex = (page - 1) * perPage;
    const items = computed.slice(startIndex, startIndex + perPage).map(({ _score, ...rest }) => rest);
    res.json({ region, page, perPage, total, items, updatedAt: gamesDoc.updatedAt || null });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});


app.get("/api/game-editions", (req, res) => {
  try{
    const store = readStore();
    const region = String(req.query.region || "TR").toUpperCase();
    const requestedId = String(req.query.id || '').trim();
    const requestedConcept = String(req.query.conceptId || '').trim();
    const rules = store.rates[region] || [];
    const step = store.settings.roundStep || 50;
    const descIndex = buildDescriptionIndex();
    const conceptIndex = buildConceptIndex();

    const collect = [];
    const pushAll = (file, source)=>{
      const doc = readJson(file, {items:[]});
      const arr = Array.isArray(doc) ? doc : (Array.isArray(doc.items) ? doc.items : []);
      for(const raw of arr){ collect.push({ raw, source }); }
    };
    pushAll(ALL_GAMES_PATH, 'all');
    pushAll(PREORDERS_PATH, 'preorder');
    pushAll(GAMES_PATH, 'discount');

    let targetConcept = requestedConcept;
    let targetMainConcept = requestedConcept;
    let targetAdditionalConceptIds = [];
    if(requestedId){
      const found = collect.find(x=>{
        const g=x.raw||{};
        if(String(g.id||'').trim() === requestedId) return true;
        if(g.productIds && Object.values(g.productIds).some(v=>String(v||'').trim()===requestedId)) return true;
        return false;
      });
      if(found){
        targetMainConcept = conceptForGame(found.raw, conceptIndex);
        targetAdditionalConceptIds = normalizeAdditionalConceptIds(found.raw && found.raw.additionalConceptIds);
      }
    }
    if(!targetMainConcept && targetConcept) targetMainConcept = targetConcept;
    targetMainConcept = String(targetMainConcept || '').trim();
    targetAdditionalConceptIds = Array.from(new Set(targetAdditionalConceptIds.map(x => String(x || '').trim()).filter(Boolean)));
    if(!targetMainConcept && !targetAdditionalConceptIds.length) return res.json({ok:true, items:[]});
    if(!targetConcept) targetConcept = targetMainConcept || targetAdditionalConceptIds[0] || '';
    const isDirectConceptMatch = (g)=>{
      const candidateMainConcept = String(conceptForGame(g, conceptIndex) || '').trim();
      const candidateAdditionalConceptIds = normalizeAdditionalConceptIds(g && g.additionalConceptIds);
      if(targetMainConcept && candidateMainConcept && candidateMainConcept === targetMainConcept) return true;
      if(candidateMainConcept && targetAdditionalConceptIds.includes(candidateMainConcept)) return true;
      if(targetMainConcept && candidateAdditionalConceptIds.includes(targetMainConcept)) return true;
      return false;
    };

    // Discount entries may not store the players field themselves.
    // Use the same game metadata source as the regular catalog when possible.
    const allGamesPlayersByKey = new Map();
    const addPlayerKey = (key, val)=>{
      const k = String(key || '').trim();
      if(k && val && !allGamesPlayersByKey.has(k)) allGamesPlayersByKey.set(k, val);
    };
    for(const entry of collect){
      if(entry.source !== 'all') continue;
      const ag = entry.raw || {};
      const val = normalizeGameMetaField(ag.players);
      if(!val) continue;
      addPlayerKey(ag.id, val);
      addPlayerKey(ag.conceptId, val);
      if(ag.productIds && typeof ag.productIds === 'object'){
        addPlayerKey(ag.productIds.TR, val);
        addPlayerKey(ag.productIds.UA, val);
      }
      if(ag.regions && typeof ag.regions === 'object'){
        for(const rg of Object.values(ag.regions)){
          if(rg && typeof rg === 'object'){
            addPlayerKey(rg.id, val);
            addPlayerKey(rg.productId, val);
            addPlayerKey(rg.storeId, val);
          }
        }
      }
    }
    const playersForPublicEdition = (g)=>{
      const keys = [g.id, g.conceptId];
      if(g.productIds && typeof g.productIds === 'object') keys.push(g.productIds.TR, g.productIds.UA);
      if(g.regions && typeof g.regions === 'object'){
        for(const rg of Object.values(g.regions)){
          if(rg && typeof rg === 'object') keys.push(rg.id, rg.productId, rg.storeId);
        }
      }
      for(const key of keys){
        const k = String(key || '').trim();
        if(k && allGamesPlayersByKey.has(k)) return allGamesPlayersByKey.get(k);
      }
      return normalizeGameMetaField(g.players);
    };

    const byId = new Map();
    for(const entry of collect){
      const g = entry.raw || {};
      const cid = conceptForGame(g, conceptIndex);
      if(!isDirectConceptMatch(g)) continue;
      const reg = (g.regions && g.regions[region]) ? g.regions[region] : null;
      const storePrice = reg ? Number(reg.salePrice || 0) : 0;
      if(!Number.isFinite(storePrice) || storePrice <= 0) continue;
      const discPerc = reg ? Number(reg.discPerc || 0) : 0;
      const rate = pickRate(rules, storePrice);
      let rub = roundUp(storePrice * rate, step);
      rub = clampMinGamePriceRub(store, rub);
      const baseStorePrice = discPerc > 0 ? (storePrice / Math.max(0.01, (1 - (discPerc/100)))) : storePrice;
      const trSub = (g.regions && g.regions.TR && g.regions.TR.sub) ? String(g.regions.TR.sub) : "";
      const uaSub = (g.regions && g.regions.UA && g.regions.UA.sub) ? String(g.regions.UA.sub) : "";
      const anySub = trSub || uaSub;
      const item = {
        id: g.id,
        name: g.name,
        edition: anySub ? "Standard Edition" : (g.edition || "Standard Edition"),
        ru: normalizeRuVal(reg && (reg.ru ?? reg.ruLang ?? reg.russian ?? reg.rus ?? reg.langRu ?? reg.languageRu)),
        sub: anySub,
        platform: g.platform || "PS4 / PS5",
        players: playersForPublicEdition(g) || null,
        size: g.size || null,
        rating: (typeof g.rating !== "undefined" ? g.rating : null),
        cover: g.cover || "",
        description: descriptionForPublicGame(g, descIndex),
        discPerc,
        discountedUntil: reg ? (reg.discountedUntil || null) : null,
        storePrice,
        finalPriceRub: rub,
        oldPriceRub: (discPerc > 0 ? clampMinGamePriceRub(store, roundUp(baseStorePrice * pickRate(rules, baseStorePrice), step)) : 0),
        conceptId: cid,
        releaseDate: g.releaseDate || null,
        isPreorder: entry.source === 'preorder' && isFutureReleaseDateYMD(g.releaseDate)
      };
      const key = String(item.id || '').trim();
      if(!key) continue;
      const prev = byId.get(key);
      // Prefer discounted library entries, then items with description.
      if(!prev || entry.source === 'discount' || (!prev.description && item.description)) byId.set(key, item);
    }
    let items = Array.from(byId.values());
    const pr = (name)=>{
      const s=String(name||'');
      if(/\bstandard\b/i.test(s) && /\bedition\b/i.test(s)) return 0;
      if(/\bdeluxe\b/i.test(s)) return 1;
      if(/\bspecial\b/i.test(s)) return 2;
      if(/\bultimate\b/i.test(s)) return 3;
      if(/\bgold\b/i.test(s)) return 4;
      if(/\bcomplete\b/i.test(s)) return 5;
      if(/\bbundle\b|\bpack\b/i.test(s)) return 8;
      return 9;
    };
    items.sort((a,b)=> (pr(a.edition||a.name)-pr(b.edition||b.name)) || (Number(a.finalPriceRub||0)-Number(b.finalPriceRub||0)) || String(a.name||'').localeCompare(String(b.name||'')));
    res.json({ok:true, conceptId:targetConcept, items});
  }catch(e){
    res.status(500).json({ok:false, error:String(e && e.message || e)});
  }
});

// Admin: rates/settings
app.get("/api/admin/rates", requireAdmin, (req, res) => {
  const store = readStore();
  const region = String(req.query.region || "TR").toUpperCase();
  const type = String(req.query.type || "main");
  const bucket = type === "discount" ? store.discountRates : store.rates;
  res.json({ region, type, rules: bucket[region] || [] });
});
app.put("/api/admin/rates", requireAdmin, (req, res) => {
  const store = readStore();
  const region = String(req.body.region || "TR").toUpperCase();
  const type = String(req.body.type || "main");
  const rules = Array.isArray(req.body.rules) ? req.body.rules : [];
  const cleaned = rules
    .map(r => ({ min:Number(r.min), max:(r.max===null||r.max===""||typeof r.max==="undefined")?null:Number(r.max), rate:Number(r.rate) }))
    .filter(r => Number.isFinite(r.min) && (r.max===null || Number.isFinite(r.max)) && Number.isFinite(r.rate));
  if(type === "discount"){
    store.discountRates = store.discountRates || defaultDiscountRates();
    store.discountRates[region] = cleaned;
  }else{
    store.rates[region] = cleaned;
  }
  writeJson(STORE_PATH, store);
  res.json({ ok:true });
});

// Admin: subscriptions prices (PS Plus + EA Play)
app.get("/api/admin/subscriptions-prices", requireAdmin, (req, res) => {
  const store = readStore();
  res.json({ ok:true, prices: store.subscriptionsPrices || {} });
});
app.put("/api/admin/subscriptions-prices", requireAdmin, (req, res) => {
  const store = readStore();
  const p = req.body && req.body.prices ? req.body.prices : null;
  if(!p || typeof p !== "object") return res.status(400).json({ ok:false, error:"bad_prices" });

  const normRegion = (region) => {
    const r = (p[region] && typeof p[region] === "object") ? p[region] : {};
    const ps = (r.psplus && typeof r.psplus === "object") ? r.psplus : {};
    const ea = (r.eaplay && typeof r.eaplay === "object") ? r.eaplay : {};
    const cleanNum = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(0, n) : 0;
    };
    const normTier = (t) => ({
      "1": cleanNum(t && t["1"]),
      "3": cleanNum(t && t["3"]),
      "12": cleanNum(t && t["12"]),
      discount12: cleanNum(t && t.discount12)
    });
    const essential = normTier(ps.essential);
    const extra = normTier(ps.extra);
    const deluxe = normTier(ps.deluxe);
    const eaplay = {
      "1": cleanNum(ea && ea["1"]),
      "12": cleanNum(ea && ea["12"]),
      discount12: cleanNum(ea && ea.discount12)
    };
    return {
      psplus: { essential, extra, deluxe },
      eaplay
    };
  };

  store.subscriptionsPrices = {
    TR: normRegion("TR"),
    UA: normRegion("UA")
  };
  writeJson(STORE_PATH, store);
  res.json({ ok:true, prices: store.subscriptionsPrices });
});
app.get("/api/admin/settings", requireAdmin, (req, res) => res.json(readStore().settings));

// Admin: visitors counter (last 24 hours)
app.get("/api/admin/visitors", requireAdmin, (req, res) => {
  try{
    const now = new Date();
    const doc = pruneVisitors(readVisitors(), now);
    // Ensure we persist pruning
    writeVisitors(doc);
    const stats = visitorsStatsLast24(doc, now);
    res.json({ ok:true, updatedAt: doc.updatedAt || null, now: now.toISOString(), ...stats });
  }catch(e){
    res.status(500).json({ ok:false, error: String(e) });
  }
});
app.put("/api/admin/settings", requireAdmin, (req, res) => {
  const store = readStore();
  store.settings = store.settings || {};
  if (req.body.roundStep !== undefined) store.settings.roundStep = Number(req.body.roundStep) === 100 ? 100 : 50;
  if (req.body.whatsappLink !== undefined) store.settings.whatsappLink = String(req.body.whatsappLink);
  const dd = req.body.defaultDiscountUntil ?? req.body.defaultDate;
  if (dd !== undefined) store.settings.defaultDiscountUntil = dd ? String(dd) : null;
  writeJson(STORE_PATH, store);
  res.json({ ok:true, settings: store.settings });
});

// Admin: manage discount banner images per discount-end date (YYYY-MM-DD)
app.get("/api/admin/discount-banners", requireAdmin, (req, res) => {
  try{
    const doc = readJson(DISCOUNT_BANNERS_PATH, { banners: {} });
    const banners = (doc && doc.banners && typeof doc.banners === "object") ? doc.banners : (doc||{});
    return res.json({ ok:true, banners });
  }catch(e){
    return res.status(500).json({ ok:false, error:String(e) });
  }
});

app.post("/api/admin/discount-banners", requireAdmin, (req, res) => {
  try{
    const date = String(req.body?.date||"").trim();
    const url = String(req.body?.url||"").trim();
    const dataUrl = String(req.body?.dataUrl||"").trim();
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)){
      return res.status(400).json({ ok:false, error:"bad_date" });
    }

    let finalUrl = "";
    if(dataUrl){
      const m = dataUrl.match(/^data:(image\/(png|jpeg|webp));base64,(.+)$/i);
      if(!m) return res.status(400).json({ ok:false, error:"bad_data_url" });
      const mime = m[1].toLowerCase();
      const ext = (mime.endsWith("jpeg")?"jpg":mime.endsWith("webp")?"webp":"png");
      const b64 = m[3];
      const buf = Buffer.from(b64, "base64");
      if(!buf || !buf.length) return res.status(400).json({ ok:false, error:"empty_image" });
      if(buf.length > 4*1024*1024) return res.status(400).json({ ok:false, error:"image_too_large" });
      const fname = `banner-${date}.${ext}`;
      const fpath = path.join(BANNERS_DIR, fname);
      fs.writeFileSync(fpath, buf);
      finalUrl = `/banners/${fname}?v=${Date.now()}`;
    }else if(url){
      finalUrl = url;
    }else{
      return res.status(400).json({ ok:false, error:"no_image" });
    }

    const doc = readJson(DISCOUNT_BANNERS_PATH, { banners: {} });
    const banners = (doc && doc.banners && typeof doc.banners === "object") ? doc.banners : {};
    banners[date] = finalUrl;
    writeJson(DISCOUNT_BANNERS_PATH, { updatedAt: new Date().toISOString(), banners });
    return res.json({ ok:true, date, url: finalUrl });
  }catch(e){
    return res.status(500).json({ ok:false, error:String(e) });
  }
});

app.delete("/api/admin/discount-banners", requireAdmin, (req, res) => {
  try{
    const date = String((req.query && req.query.date) || "").trim();
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)){
      return res.status(400).json({ ok:false, error:"bad_date" });
    }
    const doc = readJson(DISCOUNT_BANNERS_PATH, { banners: {} });
    const banners = (doc && doc.banners && typeof doc.banners === "object") ? doc.banners : {};
    delete banners[date];
    writeJson(DISCOUNT_BANNERS_PATH, { updatedAt: new Date().toISOString(), banners });
    return res.json({ ok:true, date });
  }catch(e){
    return res.status(500).json({ ok:false, error:String(e) });
  }
});

// Admin: list & delete games
app.get("/api/admin/games/list", requireAdmin, (req, res) => {
  const doc = readJson(GAMES_PATH, { updatedAt:null, items:[] });
  const items = Array.isArray(doc.items) ? doc.items : [];
  res.json({
    updatedAt: doc.updatedAt || null,
    items: items.map(g=>{
      const until = (g?.regions?.TR?.discountedUntil) || (g?.regions?.UA?.discountedUntil) || null;
      return {
        id: g.id,
        name: g.name,
        platform: g.platform || "",
        cover: g.cover || null,
        popRank: g.popRank || 0,
        discountedUntil: until
      };
    })
  });
});

// Admin: read full game info (for editing)
app.get("/api/admin/games/:id", requireAdmin, (req, res) => {
  try{
    const id = String(req.params.id || "").trim();
    if(!id) return res.status(400).json({ ok:false, error:"id_required" });
    const doc = readJson(GAMES_PATH, { updatedAt:null, items:[] });
    const items = Array.isArray(doc.items) ? doc.items : [];
    const g = items.find(x => String(x.id) === id);
    if(!g) return res.status(404).json({ ok:false, error:"not_found" });
    res.json({ ok:true, item: g });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// Admin: update full game info (edit after adding)
app.put("/api/admin/games/:id", requireAdmin, (req, res) => {
  try{
    const id = String(req.params.id || "").trim();
    if(!id) return res.status(400).json({ ok:false, error:"id_required" });

    const body = req.body || {};
    const doc = readJson(GAMES_PATH, { updatedAt:null, items:[] });
    const items = Array.isArray(doc.items) ? doc.items : [];
    const idx = items.findIndex(x => String(x.id) === id);
    if(idx < 0) return res.status(404).json({ ok:false, error:"not_found" });

    const cur = items[idx] || {};

    const numOr = (v, fallback)=>{
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };
    const strOr = (v, fallback)=>{
      if(v === null) return null;
      if(typeof v === "undefined") return fallback;
      return String(v);
    };
    const dateOrNull = (v)=>{
      const s = (v===null || typeof v === "undefined") ? null : String(v).trim();
      if(!s) return null;
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
    };

    const next = Object.assign({}, cur);
    if(typeof body.name !== "undefined") next.name = String(body.name || "").trim();
    if(typeof body.cover !== "undefined") next.cover = body.cover ? String(body.cover) : null;
    if(typeof body.platform !== "undefined") next.platform = String(body.platform || "");
    if(typeof body.edition !== "undefined") next.edition = (body.edition===null) ? null : String(body.edition || "");
    if(typeof body.players !== "undefined") next.players = normalizeGameMetaField(body.players);
    if(typeof body.size !== "undefined") next.size = normalizeGameMetaField(body.size);
    if(typeof body.rating !== "undefined") next.rating = normalizeRatingValue(body.rating);

    next.regions = next.regions && typeof next.regions === "object" ? next.regions : {};
    const updRegion = (code)=>{
      const rBody = body.regions && body.regions[code] ? body.regions[code] : null;
      if(!rBody) return;
      const rCur = next.regions[code] && typeof next.regions[code] === "object" ? next.regions[code] : {};
      const rNext = Object.assign({}, rCur);
      if(typeof rBody.salePrice !== "undefined") rNext.salePrice = numOr(rBody.salePrice, rCur.salePrice ?? 0);
      if(typeof rBody.discPerc !== "undefined") rNext.discPerc = numOr(rBody.discPerc, rCur.discPerc ?? 0);
      if(typeof rBody.discountedUntil !== "undefined") rNext.discountedUntil = dateOrNull(rBody.discountedUntil);
      if(typeof rBody.sub !== "undefined") rNext.sub = strOr(rBody.sub, rCur.sub || "") || "";
      if(typeof rBody.ru !== "undefined"){
        try{ rNext.ru = normalizeRuVal(rBody.ru); }catch(_e){ rNext.ru = normalizeRuVal(rCur.ru || "none"); }
      }else if(typeof rCur.ru !== "undefined"){
        try{ rNext.ru = normalizeRuVal(rCur.ru); }catch(_e){}
      }
      next.regions[code] = rNext;
    };
    updRegion("TR");
    updRegion("UA");

    // Ensure required region shape exists
    if(!next.regions.TR) next.regions.TR = { discPerc:0, discountedUntil:null, salePrice:0, ru:"none", sub:"" };
    if(!next.regions.UA) next.regions.UA = { discPerc:0, discountedUntil:null, salePrice:0, ru:"none", sub:"" };

    // Normalize RU values
    try{ next.regions.TR.ru = normalizeRuVal(next.regions.TR.ru); }catch(_e){}
    try{ next.regions.UA.ru = normalizeRuVal(next.regions.UA.ru); }catch(_e){}
    if(typeof next.regions.TR.sub !== "string") next.regions.TR.sub = next.regions.TR.sub ? String(next.regions.TR.sub) : "";
    if(typeof next.regions.UA.sub !== "string") next.regions.UA.sub = next.regions.UA.sub ? String(next.regions.UA.sub) : "";

    // Подписка единая (TR=UA)
    next.regions.UA.sub = next.regions.TR.sub;

    // Basic safety: id stays immutable
    next.id = cur.id;

    items[idx] = next;
    writeJson(GAMES_PATH, { updatedAt: new Date().toISOString(), items });
    res.json({ ok:true, item: next });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// Admin: delete games by discount date (yyyy-mm-dd) or "none" for empty dates
app.delete("/api/admin/games/by-discount-date", requireAdmin, (req, res) => {
  try{
    const dateRaw = String(req.query.date || "").trim();
    if(!dateRaw) return res.status(400).json({ ok:false, error:"date_required" });

    const wantNone = dateRaw.toLowerCase() === "none";
    const date = wantNone ? null : dateRaw;
    if(!wantNone && !/^\d{4}-\d{2}-\d{2}$/.test(date)){
      return res.status(400).json({ ok:false, error:"bad_date" });
    }

    const doc = readJson(GAMES_PATH, { updatedAt:null, items:[] });
    const items = Array.isArray(doc.items) ? doc.items : [];

    const keep = [];
    const removed = [];
    for(const g of items){
      const until = (g?.regions?.TR?.discountedUntil) || (g?.regions?.UA?.discountedUntil) || null;
      const match = wantNone ? (!until) : (String(until) === date);
      if(match) removed.push(g);
      else keep.push(g);
    }

    keep.forEach((g, idx)=>{ g.popRank = idx+1; });
    writeJson(GAMES_PATH, { updatedAt: new Date().toISOString(), items: keep });

    res.json({ ok:true, removed: removed.length, count: keep.length });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});
app.delete("/api/admin/games/:id", requireAdmin, (req, res) => {
  try{
    const id = String(req.params.id || "").trim();
    if(!id) return res.status(400).json({ ok:false, error:"id_required" });
    const doc = readJson(GAMES_PATH, { updatedAt:null, items:[] });
    const items = Array.isArray(doc.items) ? doc.items : [];
    const next = items.filter(g => String(g.id) !== id);
    if(next.length === items.length) return res.status(404).json({ ok:false, error:"not_found" });
    next.forEach((g, idx)=>{ g.popRank = idx+1; });
    writeJson(GAMES_PATH, { updatedAt: new Date().toISOString(), items: next });
    res.json({ ok:true, count: next.length });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});

app.delete("/api/admin/games", requireAdmin, (req, res) => {
  try{
    writeJson(GAMES_PATH, { updatedAt: new Date().toISOString(), items: [] });
    res.json({ ok:true });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// Admin: list/add/update/delete ALL GAMES (library without discounts)
app.get("/api/admin/allgames/list", requireAdmin, (req, res) => {
  const doc = readJson(ALL_GAMES_PATH, { updatedAt:null, items:[] });
  const items = Array.isArray(doc.items) ? doc.items : [];
  res.json({
    updatedAt: doc.updatedAt || null,
    items
  });

});

// Admin: refresh "Новинки" manually. This is the only PS Store request path for new releases.
app.get("/api/admin/newreleases/status", requireAdmin, (req, res) => {
  pruneExpiredNewReleases();
  const c = readNewReleasesDoc();
  res.json({ ok:true, updatedAt: c.updatedAt || null, count: Array.isArray(c.items) ? c.items.length : 0, locale: "local-json" });
});
app.post("/api/admin/newreleases/refresh", requireAdmin, async (req, res) => {
  try{
    const c = await refreshPsNewReleasesCache('en-tr', { pages: 12, timeoutMs: 8000 });
    const order = Array.isArray(c.order) ? c.order : [];
    const orderRank = new Map();
    for(let i=0;i<order.length;i++) orderRank.set(String(order[i]), i+1);

    const allDoc = readJson(ALL_GAMES_PATH, { updatedAt:null, items:[] });
    const allItems = Array.isArray(allDoc.items) ? allDoc.items : [];
    const psItems = allItems
      .filter(g => {
        const cid = String(g && g.conceptId || "").trim();
        return cid && orderRank.has(cid);
      })
      .map(g => Object.assign({}, g, { _newReleaseRank: orderRank.get(String(g.conceptId).trim()) || 999999 }))
      .sort((a,b)=> (Number(a._newReleaseRank||999999)-Number(b._newReleaseRank||999999)) || String(a.name||"").localeCompare(String(b.name||"")));

    // Keep active released preorders too, so manual PS refresh does not remove them before their 1-month window ends.
    const existing = readNewReleasesDoc().items.filter(g => g && g.releaseDate && isActiveNewReleaseByReleaseDate(g.releaseDate));
    const seen = new Set();
    const items = [];
    for(const g of psItems.concat(existing)){
      const id = String(g && g.id || '').trim();
      if(!id || seen.has(id)) continue;
      seen.add(id);
      items.push(g);
    }

    writeJson(NEW_RELEASES_PATH, { updatedAt: new Date().toISOString(), items });
    res.json({ ok:true, updatedAt: new Date().toISOString(), count: items.length });
  }catch(e){
    res.status(500).json({ ok:false, error: String(e) });
  }
});


// Admin: refresh discounts list from PS Store TR discounts category
app.post("/api/admin/discounts/refresh_from_ps", requireAdmin, async (req, res) => {
  try{
    const pages = Number(req.body && req.body.pages) || 25;
    const timeoutMs = Number(req.body && req.body.timeoutMs) || 10000;

    const baseDoc = readJson(ALL_GAMES_PATH, { updatedAt:null, items:[] });
    const baseItems = Array.isArray(baseDoc.items) ? baseDoc.items : [];

    // First clean local expired discounts. This must happen before any PS Store requests:
    // if Sony blocks scraping or returns 0 items, expired discounts still disappear locally.
    const localDiscounts = pruneExpiredDiscountItems();
    const activeExistingItems = localDiscounts.activeItems;
    const activeProductIds = localDiscounts.activeProductIds;
    const baseItemsToCheck = baseItems.filter(g => !hasActiveDiscountForAnyTrProduct(g, activeProductIds));

    const byTrPid = new Map();
    for(const g of baseItems){
      for(const pid of collectTrProductIdsFromGame(g)){
        if(pid && !byTrPid.has(pid)) byTrPid.set(pid, g);
      }
    }

    const discountsFromCategory = await scrapeTrDiscountCategory({ pages, timeoutMs });
    const discountsFromKnownProducts = await scrapeKnownTrProductDiscounts(baseItemsToCheck, {
      timeoutMs: Math.min(Math.max(3000, timeoutMs), 8000),
      concurrency: Number(req.body && req.body.extraConcurrency) || 5,
      maxProducts: Number(req.body && req.body.extraMaxProducts) || 1200
    });
    const discounts = mergeDiscountListsExact([discountsFromCategory, discountsFromKnownProducts]);

    // Safety: never wipe existing скидки if scraping failed / returned nothing.
    // PS Store иногда блокирует requests (Cloudflare / captcha) и тогда "0" — это не "скидок нет".
    if(!Array.isArray(discounts) || discounts.length === 0){
      if(localDiscounts.removedExpired > 0){
        writeJson(GAMES_PATH, { updatedAt: new Date().toISOString(), items: activeExistingItems });
      }
      return res.status(502).json({
        ok:false,
        error:"scrape_empty",
        cleanedExpired: localDiscounts.removedExpired,
        keptActive: activeExistingItems.length,
        skippedActiveKnownProducts: baseItems.length - baseItemsToCheck.length,
        hint:"PS Store вернул 0 товаров (возможна блокировка). Истёкшие локальные скидки удалены, активные сохранены."
      });
    }

    const matched = [];
    const missing = [];

    for(const d of discounts){
      const key = String(d.productId||"").toUpperCase().trim();
      const base = byTrPid.get(key);
      if(!base){
        missing.push(key);
        continue;
      }

      const trBasePrice = base?.regions?.TR ? Number(base.regions.TR.salePrice || 0) : 0;
      const trDiscountPrice = Number(d.trDiscountPrice || 0);
      // A version is discounted only if THIS exact version has a real sale price,
      // an end date, and the sale price is lower than its own regular TR price.
      if(!d.discountedUntil || !Number.isFinite(trBasePrice) || trBasePrice <= 0 || !Number.isFinite(trDiscountPrice) || trDiscountPrice <= 0 || trDiscountPrice >= trBasePrice){
        continue;
      }
      const exactDiscPerc = computeDiscountPercentFromPrices(trBasePrice, trDiscountPrice);
      if(!(exactDiscPerc > 0)) continue;
      const uaBasePrice = base?.regions?.UA ? Number(base.regions.UA.salePrice || 0) : 0;
      const trBaseRu = base?.regions?.TR ? normalizeRuVal(base.regions.TR.ru) : "none";
      const uaBaseRu = base?.regions?.UA ? normalizeRuVal(base.regions.UA.ru) : "none";
      const sub = (base?.regions?.TR?.sub) ? String(base.regions.TR.sub) : (base?.regions?.UA?.sub ? String(base.regions.UA.sub) : "");

      matched.push({
        id: String(base.id),
        name: String(base.name),
        cover: base.cover ? String(base.cover) : null,
        platform: base.platform ? String(base.platform) : "PS4 / PS5",
        edition: base.edition ? String(base.edition) : null,
        popRank: Number.isFinite(base.popRank) ? base.popRank : 1000000000,
        regions: {
          TR: {
            salePrice: Number(d.trDiscountPrice || 0),
            discPerc: exactDiscPerc,
            discountedUntil: d.discountedUntil || null,
            ru: trBaseRu,
            sub
          },
          UA: {
            salePrice: computeDiscountedPrice(uaBasePrice, exactDiscPerc),
            discPerc: exactDiscPerc,
            discountedUntil: d.discountedUntil || null,
            ru: uaBaseRu,
            sub
          }
        }
      });
    }

    matched.sort((a,b)=> (Number(a.popRank||0) - Number(b.popRank||0)));

    // Safety: if nothing matched our local library, keep active local discounts and only remove expired ones.
    if(matched.length === 0){
      if(localDiscounts.removedExpired > 0){
        writeJson(GAMES_PATH, { updatedAt: new Date().toISOString(), items: activeExistingItems });
      }
      return res.status(502).json({
        ok:false,
        error:"no_matches",
        scraped: discounts.length,
        scrapedFromCategory: discountsFromCategory.length,
        scrapedFromKnownProducts: discountsFromKnownProducts.length,
        cleanedExpired: localDiscounts.removedExpired,
        keptActive: activeExistingItems.length,
        skippedActiveKnownProducts: baseItems.length - baseItemsToCheck.length,
        missingInAllGames: missing.length,
        missingSample: missing.slice(0, 20),
        hint:"Скидки нашли, но ни одна не совпала с твоей базой all_games.json. Истёкшие локальные скидки удалены, активные сохранены."
      });
    }

    const finalItems = mergeDiscountItemsById(activeExistingItems, matched);
    finalItems.sort((a,b)=> (Number(a.popRank||0) - Number(b.popRank||0)));
    writeJson(GAMES_PATH, { updatedAt: new Date().toISOString(), items: finalItems });

    res.json({
      ok:true,
      scraped: discounts.length,
      scrapedFromCategory: discountsFromCategory.length,
      scrapedFromKnownProducts: discountsFromKnownProducts.length,
      cleanedExpired: localDiscounts.removedExpired,
      keptActive: activeExistingItems.length,
      skippedActiveKnownProducts: baseItems.length - baseItemsToCheck.length,
      addedOrUpdated: matched.length,
      totalDiscounts: finalItems.length,
      missingInAllGames: missing.length,
      missingSample: missing.slice(0, 20)
    });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});



// Admin: fetch one Russian description from PS Store UA region.
app.post("/api/admin/description/fetch", requireAdmin, async (req, res) => {
  try{
    const body = req.body || {};
    const id = String(body.productId || body.uaProductId || body.conceptId || '').trim();
    if(!id) return res.status(400).json({ ok:false, error:'product_or_concept_id_required' });
    const description = await fetchGameDescriptionFromPs(id);
    res.json({ ok:true, description });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// Admin: clean descriptions polluted by PS page/footer/cookie dumps.
app.post("/api/admin/descriptions/clean", requireAdmin, (req, res) => {
  try{
    const files = [ALL_GAMES_PATH, PREORDERS_PATH, GAMES_PATH];
    let cleaned = 0, total = 0;
    for(const file of files){
      const doc = readJson(file, { updatedAt:null, items:[] });
      const items = Array.isArray(doc.items) ? doc.items : [];
      for(const g of items){
        total++;
        if(g && g.description && !hasUsableDescription(g)){
          g.description = '';
          cleaned++;
        }
      }
      writeJson(file, { updatedAt: new Date().toISOString(), items });
    }
    res.json({ ok:true, total, cleaned });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// Admin: backfill missing Russian descriptions.
// Resumable batch: each click processes the next 50 games and stores the cursor.
app.post("/api/admin/descriptions/backfill", requireAdmin, async (req, res) => {
  try{
    const body = req.body || {};
    const batchSize = Math.max(1, Math.min(100, Number(body.limit || body.batchSize || 50)));
    const concurrency = Math.max(1, Math.min(50, Number(body.concurrency || 50)));
    const force = !!body.force;
    const reset = !!body.reset;
    const files = [
      { path: ALL_GAMES_PATH, name: 'all_games' },
      { path: PREORDERS_PATH, name: 'preorders' },
      { path: GAMES_PATH, name: 'games' },
    ];

    let state = reset ? null : readJson(DESCRIPTION_BACKFILL_STATE_PATH, null);
    if(!state || typeof state !== 'object') state = { fileIndex: 0, itemIndex: 0, completedCycles: 0 };
    state.fileIndex = Math.max(0, Math.min(files.length - 1, Number(state.fileIndex || 0)));
    state.itemIndex = Math.max(0, Number(state.itemIndex || 0));

    let total = 0, skipped = 0, checked = 0, updated = 0, failed = 0, cleaned = 0;
    const errors = [];
    const docs = files.map(f => {
      const doc = readJson(f.path, { updatedAt:null, items:[] });
      const items = Array.isArray(doc.items) ? doc.items : [];
      total += items.length;
      return { ...f, doc, items, changed:false };
    });

    const targets = [];
    let scans = 0;
    const maxScans = Math.max(1, total) + files.length;
    let fileIndex = state.fileIndex;
    let itemIndex = state.itemIndex;

    while(targets.length < batchSize && scans < maxScans){
      const d = docs[fileIndex];
      if(!d || !d.items.length || itemIndex >= d.items.length){
        fileIndex = (fileIndex + 1) % docs.length;
        itemIndex = 0;
        scans++;
        continue;
      }
      const g = d.items[itemIndex];
      const currentIndex = itemIndex;
      itemIndex++;
      scans++;
      if(!g) continue;
      if(g.description && !hasUsableDescription(g)){
        g.description = '';
        d.changed = true;
        cleaned++;
      }
      if(!force && hasUsableDescription(g)){ skipped++; continue; }
      const pid = pickUaProductId(g) || String(g.conceptId || '').trim();
      if(!pid){ failed++; continue; }
      targets.push({ d, g, pid, index: currentIndex });
    }

    let next = 0;
    const worker = async ()=>{
      while(true){
        const cur = targets[next++];
        if(!cur) return;
        checked++;
        try{
          const desc = await fetchGameDescriptionFromPs(cur.pid);
          if(desc && isGoodPsDescription(desc)){
            cur.g.description = cleanPsDescriptionText(desc);
            cur.d.changed = true;
            updated++;
          }else{
            failed++;
          }
        }catch(e){
          failed++;
          if(errors.length < 20) errors.push(`${cur.pid}: ${String(e)}`);
        }
      }
    };
    await Promise.all(Array.from({length: Math.min(concurrency, targets.length || 1)}, worker));

    for(const d of docs){
      if(d.changed) writeJson(d.path, { updatedAt: new Date().toISOString(), items: d.items });
    }

    const remaining = docs.reduce((sum, d)=> sum + d.items.filter(g => {
      if(!g) return false;
      if(!force && hasUsableDescription(g)) return false;
      return !!(pickUaProductId(g) || String(g.conceptId || '').trim());
    }).length, 0);

    if(targets.length === 0 || remaining === 0){
      state = { fileIndex: 0, itemIndex: 0, completedCycles: Number(state.completedCycles || 0) + 1, updatedAt: new Date().toISOString() };
    }else{
      state = { fileIndex, itemIndex, completedCycles: Number(state.completedCycles || 0), updatedAt: new Date().toISOString() };
    }
    writeJson(DESCRIPTION_BACKFILL_STATE_PATH, state);

    const currentFile = docs[state.fileIndex] ? docs[state.fileIndex].name : docs[0].name;
    res.json({ ok:true, mode:'resumable_batch', batchSize, total, skipped, cleaned, checked, updated, failed, remaining, concurrency, nextFile: currentFile, nextIndex: state.itemIndex, completedCycles: state.completedCycles, errors });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// Admin: backfill conceptId for already added items in "Всё игры" (uses stored productIds)
app.post("/api/admin/allgames/backfill_conceptid", requireAdmin, async (req, res) => {
  try{
    const doc = readJson(ALL_GAMES_PATH, { updatedAt:null, items:[] });
    const items = Array.isArray(doc.items) ? doc.items : [];

    const targets = items.filter(g => !String(g.conceptId||"").trim());
    const max = Math.max(1, Math.min(targets.length, Number(req.body && req.body.limit || 9999)));
    const concurrency = Math.max(1, Math.min(4, Number(req.body && req.body.concurrency || 2)));

    let updated = 0, failed = 0;
    const errs = [];

    const pickPid = (g)=>{
      const tr = g?.productIds?.TR ? String(g.productIds.TR) : "";
      const ua = g?.productIds?.UA ? String(g.productIds.UA) : "";
      return tr || ua || String(g.id||"");
    };

    const queue = targets.slice(0, max).map(g => ({ g, pid: pickPid(g) }));
    let idx = 0;

    const worker = async ()=>{
      while(true){
        const cur = queue[idx++];
        if(!cur) return;
        const pid = String(cur.pid||"").trim();
        if(!pid) { failed++; continue; }
        const url = `https://store.playstation.com/en-tr/product/${pid}`;
        try{
          const html = await fetchText(url, { acceptLanguage: "en-TR,en;q=0.9,tr-TR;q=0.8", timeoutMs: 8000 });
          const cid = extractConceptIdFromProductHtml(html, pid);
          if(cid){
            cur.g.conceptId = String(cid);
            updated++;
          }else{
            failed++;
          }
        }catch(e){
          failed++;
          if(errs.length < 10) errs.push(String(e));
        }
      }
    };

    await Promise.all(Array.from({length:concurrency}, worker));

    writeJson(ALL_GAMES_PATH, { updatedAt: new Date().toISOString(), items });
    res.json({ ok:true, updated, failed, total: items.length, errors: errs });
  }catch(e){
    res.status(500).json({ ok:false, error: String(e) });
  }
});

// Admin: backfill conceptId for already added items in "Предзаказы" (uses stored productIds)
app.post("/api/admin/preorders/backfill_conceptid", requireAdmin, async (req, res) => {
  try{
    const doc = readJson(PREORDERS_PATH, { updatedAt:null, items:[] });
    const items = Array.isArray(doc.items) ? doc.items : [];

    const targets = items.filter(g => !String(g.conceptId||"").trim());
    const max = Math.max(1, Math.min(targets.length, Number(req.body && req.body.limit || 9999)));
    const concurrency = Math.max(1, Math.min(4, Number(req.body && req.body.concurrency || 2)));

    let updated = 0, failed = 0;
    const errs = [];

    const pickPid = (g)=>{
      const tr = g?.productIds?.TR ? String(g.productIds.TR) : "";
      const ua = g?.productIds?.UA ? String(g.productIds.UA) : "";
      return tr || ua || String(g.id||"");
    };

    const queue = targets.slice(0, max).map(g => ({ g, pid: pickPid(g) }));
    let idx = 0;

    const worker = async ()=>{
      while(true){
        const cur = queue[idx++];
        if(!cur) return;
        const pid = String(cur.pid||"").trim();
        if(!pid) { failed++; continue; }
        const url = `https://store.playstation.com/en-tr/product/${pid}`;
        try{
          const html = await fetchText(url, { acceptLanguage: "en-TR,en;q=0.9,tr-TR;q=0.8", timeoutMs: 8000 });
          const cid = extractConceptIdFromProductHtml(html, pid);
          if(cid){
            cur.g.conceptId = String(cid);
            updated++;
          }else{
            failed++;
          }
        }catch(e){
          failed++;
          if(errs.length < 10) errs.push(String(e));
        }
      }
    };

    await Promise.all(Array.from({length:concurrency}, worker));
    writeJson(PREORDERS_PATH, { updatedAt: new Date().toISOString(), items });
    res.json({ ok:true, updated, failed, total: items.length, errors: errs });
  }catch(e){
    res.status(500).json({ ok:false, error: String(e) });
  }
});

// Public: list ALL GAMES (library without discounts)
app.get("/api/allgames", async (req, res) => {
  try {
    const store = readStore();
    const region = String(req.query.region || "TR").toUpperCase();
    // Sorting for TR and UA must be identical. We use the TR Browse order as the
    // canonical ranking source for both regions.
    const locale = "en-tr";
    const sort = String(req.query.sort || "pop");
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
    const perPage = 24;
    const q = String(req.query.q || "").trim();
    const platform = String(req.query.platform || "").trim();

    // For TR browse-like ordering, prefill ranks for the first pages so the order matches
    // https://store.playstation.com/en-tr/pages/browse immediately.
    if(!q && (sort === "pop" || !sort)){
      try{ await withTimeout(warmupPsBrowseCache(locale, 6), 2500); }catch(_e){}
    }

    // PlayStation browse ordering cache (used as "relevance" / default order)
    // We store both ranks by product/concept id and by normalized title.
    const psRankDoc = readPsBrowseCache();
    const psRanksById = (psRankDoc && psRankDoc.locale === locale && psRankDoc.ranksById) ? psRankDoc.ranksById : {};
    const psRanksByName = (psRankDoc && psRankDoc.locale === locale && psRankDoc.ranksByName) ? psRankDoc.ranksByName : {};
    const normKey = (s) => normText(String(s || ""));
    // IMPORTANT: PS ranks may legitimately be 0 for the first item.
    // Avoid using `||` with Number(...) because 0 would be treated as falsy.
    const firstFinite = (...vals) => {
      for (const v of vals) {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
      return 999999;
    };

    const doc = readJson(ALL_GAMES_PATH, { updatedAt:null, items:[] });
    let all = Array.isArray(doc.items) ? doc.items : [];
    if (q) all = all.filter(x => smartMatch(x.name || "", q));
    if (platform) all = all.filter(x => platformPass(x.platform || "", platform));

    const rules = store.rates[region] || [];
    const step = store.settings.roundStep || 50;

    // Overlay active discounts from discounts storage (data/games.json)
    // so the "Все игры" page can show the same discount badge/price without duplicating cards.
    const discountsIndex = readActiveDiscountsIndex();
    const descIndex = buildDescriptionIndex();
    const conceptIndex = buildConceptIndex();

    let computed = all.map(g => {
      const reg = (g.regions && g.regions[region]) ? g.regions[region] : null;
      const baseStorePrice = reg ? Number(reg.salePrice || 0) : 0;

      // Hide game in selected region if price missing/invalid
      if (!Number.isFinite(baseStorePrice) || baseStorePrice <= 0) return null;

      // Find matching discounted entry by exact product/version id only.
      const dg = (g.id && discountsIndex.byId.get(String(g.id))) || null;

      // If discounted entry exists and is active for this region — override price + discount meta
      let discPerc = 0;
      let discountedUntil = null;
      let storePrice = baseStorePrice;
      if(dg && dg.regions && dg.regions[region] && isDiscountActiveForRegion(dg.regions[region])){
        const dreg = dg.regions[region];
        discPerc = Number(dreg.discPerc || 0) || 0;
        discountedUntil = dreg.discountedUntil || null;
        const dPrice = Number(dreg.salePrice || 0);
        if(Number.isFinite(dPrice) && dPrice > 0){
          storePrice = dPrice;
        }else if(discPerc > 0){
          // Fallback: compute discounted price from base price if missing
          storePrice = Math.max(0, baseStorePrice * (1 - (discPerc/100)));
        }
      }

      const rate = pickRate(rules, storePrice);
      let rub = roundUp(storePrice * rate, step);
      rub = clampMinGamePriceRub(store, rub);
      const trSub = (g.regions && g.regions.TR && g.regions.TR.sub) ? String(g.regions.TR.sub) : "";
      const uaSub = (g.regions && g.regions.UA && g.regions.UA.sub) ? String(g.regions.UA.sub) : "";
      const anySub = trSub || uaSub;

      const base = {
        id: g.id,
        name: g.name,
        edition: anySub ? "Standard Edition" : (g.edition || "Standard Edition"),
        ru: normalizeRuVal(reg && (reg.ru ?? reg.ruLang ?? reg.russian ?? reg.rus ?? reg.langRu ?? reg.languageRu)),
        sub: anySub,
        platform: g.platform || "PS4 / PS5",
        players: g.players || null,
        size: g.size || null,
        rating: (typeof g.rating !== "undefined" ? g.rating : null),
        cover: g.cover || "",
        description: descriptionForPublicGame(g, descIndex),
        discPerc,
        discountedUntil,
        storePrice: storePrice,
        finalPriceRub: rub,
        oldPriceRub: (discPerc > 0 ? clampMinGamePriceRub(store, roundUp(baseStorePrice * pickRate(rules, baseStorePrice), step)) : 0),
        conceptId: conceptForGame(g, conceptIndex),
        popRank: g.popRank || 999999,
        // Prefer PS browse rank by id; fallback to title match.
        // IMPORTANT: match by base title too, because PS Browse often shows a single tile
        // for the game (e.g. "EA SPORTS FC™ 26") while our library stores per-edition items
        // (e.g. "EA SPORTS FC™ 26 Standard Edition PS4 & PS5").
        psRank: firstFinite(
          // 1) Prefer conceptId (stable across editions and matches PS browse tiles)
          psRanksById[String(g.conceptId || "").trim()],
          // 2) Fallback: legacy internal id (older saves)
          psRanksById[String(g.id||"").trim()],
          // 3) Fallback: region-specific product ids (if stored there)
          psRanksById[String((g.regions && g.regions.TR && (g.regions.TR.id || g.regions.TR.productId || g.regions.TR.storeId)) || "").trim()],
          psRanksById[String((g.regions && g.regions.UA && (g.regions.UA.id || g.regions.UA.productId || g.regions.UA.storeId)) || "").trim()],
          // 4) Fallback: title match
          psRanksByName[normKey(g.name)],
          psRanksByName[normKey(baseTitleForRank(g.name))]
        )
      };

      if(q) base._score = relevanceScore(g.name || "", q);
      return base;
    });

    computed = computed.filter(Boolean);

    // Sorting
    if (q) {
      computed.sort((a,b)=> (b._score||0)-(a._score||0));
    } else if (sort === "name_asc") {
      computed.sort((a,b)=> String(a.name||"").localeCompare(String(b.name||""), "ru"));
    } else if (sort === "name_desc") {
      computed.sort((a,b)=> String(b.name||"").localeCompare(String(a.name||""), "ru"));
    } else if (sort === "price_asc") {
      computed.sort((a,b)=> (a.finalPriceRub||0)-(b.finalPriceRub||0));
    } else if (sort === "price_desc") {
      computed.sort((a,b)=> (b.finalPriceRub||0)-(a.finalPriceRub||0));
    } else {
      // Default: PlayStation browse-like order, with fallback to popRank
      computed.sort((a,b)=> (a.psRank||999999)-(b.psRank||999999) || (a.popRank||999999)-(b.popRank||999999));
    }

    // Keep editions together (e.g. Standard/Deluxe/Ultimate should go one after another)
    // We do this after sorting so we preserve the selected sort order at the group level.
    if(!q){
      const editionPriority = (name)=>{
        const s = String(name||"");
        // Treat common PS Store naming variants as the same "edition" bucket.
        // (e.g. "Digital Deluxe Edition" should group with "Deluxe Edition".)
        if(/\bstandard\b/i.test(s) && /\bedition\b/i.test(s)) return 0;
        if(/\bdigital\s+deluxe\b/i.test(s)) return 1;
        if(/\bdeluxe\b/i.test(s) && /\bedition\b/i.test(s)) return 1;
        if(/\bultimate\b/i.test(s) && /\bedition\b/i.test(s)) return 2;
        if(/\bgold\b/i.test(s) && /\bedition\b/i.test(s)) return 3;
        if(/\bcomplete\b/i.test(s) && /\bedition\b/i.test(s)) return 4;
        if(/\bdefinitive\b/i.test(s) && /\bedition\b/i.test(s)) return 5;
        if(/\bcollector'?s\b/i.test(s)) return 6;
        // Bundles/packs should still be kept with the base title, but after editions.
        if(/\bbundle\b/i.test(s) || /\bpack\b/i.test(s)) return 8;
        return 9;
      };
      // Use the same base-title normalizer that we use for PS Browse rank matching.
      // This is more aggressive and handles cases like "Digital Deluxe Edition",
      // "Cross-Gen Bundle", etc., so editions don't get split into different groups.
      const baseTitle = (name)=> baseTitleForRank(name);

      const groups = new Map();
      for(let i=0;i<computed.length;i++){
        const it = computed[i];
        const key = normKey(baseTitle(it.name||"")) || normKey(it.name||"") || String(it.id||"");
        const g = groups.get(key) || { firstIndex: i, items: [] };
        g.items.push(it);
        groups.set(key, g);
      }
      const orderedGroups = Array.from(groups.values()).sort((a,b)=> a.firstIndex - b.firstIndex);
      computed = orderedGroups.flatMap(g => {
        const items = g.items;
        if(items.length <= 1) return items;
        return items.slice().sort((a,b)=>{
          const pa = editionPriority(a.name);
          const pb = editionPriority(b.name);
          if(pa !== pb) return pa - pb;
          // then prefer PS browse rank (if present) and then name
          const ra = Number(a.psRank||999999);
          const rb = Number(b.psRank||999999);
          if(ra !== rb) return ra - rb;
          return String(a.name||"").localeCompare(String(b.name||""));
        });
      });
    }

    attachPublicEditions(computed);

    // Only on the public "Все игры" page: show the base edition per game.
    // Search must keep returning all editions, so this is disabled when q is present.
    // Versions of the same game are identified only by the main conceptId.
    if(!q){
      const isStandardEdition = (it)=> String((it && it.edition) || "").trim().toLowerCase() === "standard edition";
      const priceForBasePick = (it)=> {
        const n = Number(it && it.finalPriceRub);
        return Number.isFinite(n) ? n : 999999999;
      };
      const groups = new Map();
      for(let i=0;i<computed.length;i++){
        const it = computed[i];
        const key = String((it && it.conceptId) || "").trim();
        const g = groups.get(key) || { firstIndex:i, items:[] };
        g.items.push(it);
        groups.set(key, g);
      }
      computed = Array.from(groups.values()).sort((a,b)=> a.firstIndex - b.firstIndex).flatMap(g => {
        const items = g.items || [];
        if(items.length <= 1) return items;

        // If exact "Standard Edition" exists, show every exact Standard Edition entry.
        // Do not treat titles like "Eclipse Standard Edition" as a Standard Edition.
        const standards = items.filter(isStandardEdition);
        if(standards.length) return standards;

        // If there is no exact Standard Edition, show the cheapest edition of this conceptId.
        const cheapest = items.slice().sort((a,b)=>
          (priceForBasePick(a)-priceForBasePick(b)) ||
          String(a.name||"").localeCompare(String(b.name||""))
        )[0];
        return cheapest ? [cheapest] : [];
      }).filter(Boolean);
    }

    const total = computed.length;
    const startIdx = (page - 1) * perPage;
    const items = computed.slice(startIdx, startIdx + perPage);

    res.json({ region, page, perPage, total, items });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Public: list NEW RELEASES ("Новинки")
// Source of truth for ordering is PS Store category (TR) cached weekly.
// We only show games that exist in our "Всё игры" library and have conceptId.
app.get("/api/newreleases", async (req, res) => {
  try{
    pruneExpiredNewReleases();
    const store = readStore();
    const region = String(req.query.region || "TR").toUpperCase();
    const sort = String(req.query.sort || "pop");
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
    const perPage = 24;
    const q = String(req.query.q || "").trim();
    const platform = String(req.query.platform || "").trim();

    const nrDoc = readNewReleasesDoc();
    let all = Array.isArray(nrDoc.items) ? nrDoc.items : [];
    if(q) all = all.filter(x => smartMatch(x.name || "", q));
    if(platform) all = all.filter(x => platformPass(x.platform || "", platform));

    const rules = store.rates[region] || [];
    const step = store.settings.roundStep || 50;
    const descIndex = buildDescriptionIndex();
    const conceptIndex = buildConceptIndex();
    const normKey = (s)=> normText(String(s||""));
    const baseTitle = (name)=> baseTitleForRank(name);
    const editionPriority = (name)=>{
      const s = String(name||"");
      if(/\bstandard\b/i.test(s) && /\bedition\b/i.test(s)) return 0;
      if(/\bdigital\s+deluxe\b/i.test(s)) return 1;
      if(/\bdeluxe\b/i.test(s) && /\bedition\b/i.test(s)) return 1;
      if(/\bultimate\b/i.test(s) && /\bedition\b/i.test(s)) return 2;
      if(/\bgold\b/i.test(s) && /\bedition\b/i.test(s)) return 3;
      if(/\bcomplete\b/i.test(s) && /\bedition\b/i.test(s)) return 4;
      if(/\bdefinitive\b/i.test(s) && /\bedition\b/i.test(s)) return 5;
      if(/\bcollector'?s\b/i.test(s)) return 6;
      if(/\bbundle\b/i.test(s) || /\bpack\b/i.test(s)) return 8;
      return 9;
    };

    let computed = all.map((g, idx) => {
      const reg = (g.regions && g.regions[region]) ? g.regions[region] : null;
      const storePrice = reg ? Number(reg.salePrice || 0) : 0;
      if(!Number.isFinite(storePrice) || storePrice <= 0) return null;

      const rate = pickRate(rules, storePrice);
      let rub = roundUp(storePrice * rate, step);
      rub = clampMinGamePriceRub(store, rub);
      const trSub = (g.regions && g.regions.TR && g.regions.TR.sub) ? String(g.regions.TR.sub) : "";
      const uaSub = (g.regions && g.regions.UA && g.regions.UA.sub) ? String(g.regions.UA.sub) : "";
      const anySub = trSub || uaSub;
      const cid = String(g.conceptId||"").trim();
      const psRank = Number(g._newReleaseRank || g.newReleaseRank || idx + 1) || (idx + 1);
      const base = {
        id: g.id,
        name: g.name,
        edition: anySub ? "Standard Edition" : (g.edition || "Standard Edition"),
        ru: normalizeRuVal(reg && (reg.ru ?? reg.ruLang ?? reg.russian ?? reg.rus ?? reg.langRu ?? reg.languageRu)),
        sub: anySub,
        platform: g.platform || "PS4 / PS5",
        players: g.players || null,
        size: g.size || null,
        rating: (typeof g.rating !== "undefined" ? g.rating : null),
        cover: g.cover || "",
        description: descriptionForPublicGame(g, descIndex),
        discPerc: 0,
        discountedUntil: null,
        storePrice: storePrice,
        finalPriceRub: rub,
        oldPriceRub: 0,
        conceptId: conceptForGame(g, conceptIndex),
        popRank: g.popRank || 999999,
        psRank,
        releaseDate: g.releaseDate || null
      };
      if(q) base._score = relevanceScore(g.name || "", q);
      return base;
    }).filter(Boolean);

    if(q){
      computed.sort((a,b)=> (b._score||0)-(a._score||0));
    }else if(sort === "name_asc"){
      computed.sort((a,b)=> String(a.name||"").localeCompare(String(b.name||""), "ru"));
    }else if(sort === "name_desc"){
      computed.sort((a,b)=> String(b.name||"").localeCompare(String(a.name||""), "ru"));
    }else if(sort === "price_asc"){
      computed.sort((a,b)=> (a.finalPriceRub||0)-(b.finalPriceRub||0));
    }else if(sort === "price_desc"){
      computed.sort((a,b)=> (b.finalPriceRub||0)-(a.finalPriceRub||0));
    }else{
      computed.sort((a,b)=> (a.psRank||999999)-(b.psRank||999999) || String(a.name||"").localeCompare(String(b.name||"")));
    }

    if(!q){
      const groups = new Map();
      for(let i=0;i<computed.length;i++){
        const it = computed[i];
        const key = normKey(baseTitle(it.name||"")) || normKey(it.name||"") || String(it.conceptId||it.id||"");
        const g = groups.get(key) || { firstIndex: i, items: [] };
        g.items.push(it);
        groups.set(key, g);
      }
      const orderedGroups = Array.from(groups.values()).sort((a,b)=> a.firstIndex - b.firstIndex);
      computed = orderedGroups.flatMap(g => {
        const items = g.items;
        if(items.length <= 1) return items;
        return items.slice().sort((a,b)=>{
          const pa = editionPriority(a.name);
          const pb = editionPriority(b.name);
          if(pa !== pb) return pa - pb;
          return String(a.name||"").localeCompare(String(b.name||""));
        });
      });
    }

    attachPublicEditions(computed);

    const total = computed.length;
    const startIdx = (page - 1) * perPage;
    const items = computed.slice(startIdx, startIdx + perPage);

    res.json({ region, page, perPage, total, updatedAt: nrDoc.updatedAt || null, items });
  }catch(e){
    res.status(500).json({ error: String(e) });
  }
});


app.get("/api/preorders", async (req, res) => {
  try{
    const store = readStore();
    const region = String(req.query.region || "TR").toUpperCase();
    // Sorting must be одинаковой для TR и UA: используем порядок TR как канонический.
    const locale = "en-tr";
    const sort = String(req.query.sort || "pop");
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
    const perPage = 24;
    const q = String(req.query.q || "").trim();
    const platform = String(req.query.platform || "").trim();

    if(!q && (sort === "pop" || !sort)){
      try{ await withTimeout(warmupPsPreordersCache(locale, 6), 2500); }catch(_e){}
    }

    const psRankDoc = readPsPreordersCache();
    const psRanksById = (psRankDoc && psRankDoc.locale === locale && psRankDoc.ranksById) ? psRankDoc.ranksById : {};
    const psRanksByName = (psRankDoc && psRankDoc.locale === locale && psRankDoc.ranksByName) ? psRankDoc.ranksByName : {};
    const normKey = (s) => normText(String(s || ""));
    const firstFinite = (...vals) => {
      for (const v of vals) {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
      return 999999;
    };

    const doc = readJson(PREORDERS_PATH, { updatedAt:null, items:[] });
    let all = Array.isArray(doc.items) ? doc.items : [];
    if (q) all = all.filter(x => smartMatch(x.name || "", q));
    if (platform) all = all.filter(x => platformPass(x.platform || "", platform));

    const rules = store.rates[region] || [];
    const step = store.settings.roundStep || 50;
    const descIndex = buildDescriptionIndex();
    const conceptIndex = buildConceptIndex();

    let computed = all.map(g => {
      const reg = (g.regions && g.regions[region]) ? g.regions[region] : null;
      const storePrice = reg ? Number(reg.salePrice || 0) : 0;
      if (!Number.isFinite(storePrice) || storePrice <= 0) return null;

      const rate = pickRate(rules, storePrice);
      let rub = roundUp(storePrice * rate, step);
      rub = clampMinGamePriceRub(store, rub);

      const trSub = (g.regions && g.regions.TR && g.regions.TR.sub) ? String(g.regions.TR.sub) : "";
      const uaSub = (g.regions && g.regions.UA && g.regions.UA.sub) ? String(g.regions.UA.sub) : "";
      const anySub = trSub || uaSub;

      const base = {
        id: g.id,
        name: g.name,
        edition: anySub ? "Standard Edition" : (g.edition || "Standard Edition"),
        ru: normalizeRuVal(reg && (reg.ru ?? reg.ruLang ?? reg.russian ?? reg.rus ?? reg.langRu ?? reg.languageRu)),
        sub: anySub,
        platform: g.platform || "PS4 / PS5",
        players: g.players || null,
        size: g.size || null,
        rating: (typeof g.rating !== "undefined" ? g.rating : null),
        cover: g.cover || "",
        description: descriptionForPublicGame(g, descIndex),
        discPerc: 0,
        discountedUntil: null,
        storePrice: storePrice,
        finalPriceRub: rub,
        oldPriceRub: 0,
        conceptId: conceptForGame(g, conceptIndex),
        popRank: g.popRank || 999999,
        releaseDate: g.releaseDate || null,
        isPreorder: isFutureReleaseDateYMD(g.releaseDate),
        psRank: firstFinite(
          // 1) Prefer conceptId (stable across editions and matches PS browse tiles)
          psRanksById[String(g.conceptId || "").trim()],
          // 2) Fallback: legacy internal id (older saves)
          psRanksById[String(g.id||"" ).trim()],
          // 3) Fallback: region store ids (some imports keep PS ids here)
          psRanksById[String(((g.regions&&g.regions.TR)&&(g.regions.TR.id||g.regions.TR.productId||g.regions.TR.storeId))||"").trim()],
          psRanksById[String(((g.regions&&g.regions.UA)&&(g.regions.UA.id||g.regions.UA.productId||g.regions.UA.storeId))||"").trim()],
          // 4) Title matching
          psRanksByName[normKey(g.name)],
          psRanksByName[normKey(baseTitleForRank(g.name))]
        )
      };
      if(q) base._score = relevanceScore(g.name || "", q);
      return base;
    });
    computed = computed.filter(Boolean);

    if (q) {
      computed.sort((a,b)=> (b._score||0)-(a._score||0));
    } else if (sort === "price_asc") {
      computed.sort((a,b)=> (a.finalPriceRub||0)-(b.finalPriceRub||0));
    } else if (sort === "price_desc") {
      computed.sort((a,b)=> (b.finalPriceRub||0)-(a.finalPriceRub||0));
    } else {
      // Default: PlayStation preorders category order
      computed.sort((a,b)=> (a.psRank||999999)-(b.psRank||999999) || (a.popRank||999999)-(b.popRank||999999));
    }

    // Keep editions together for preorders too
    if(!q){
      const editionPriority = (name)=>{
        const s = String(name||"");
        if(/\bstandard\b/i.test(s) && /\bedition\b/i.test(s)) return 0;
        if(/\bdigital\s+deluxe\b/i.test(s)) return 1;
        if(/\bdeluxe\b/i.test(s) && /\bedition\b/i.test(s)) return 1;
        if(/\bultimate\b/i.test(s) && /\bedition\b/i.test(s)) return 2;
        if(/\bgold\b/i.test(s) && /\bedition\b/i.test(s)) return 3;
        if(/\bcomplete\b/i.test(s) && /\bedition\b/i.test(s)) return 4;
        if(/\bdefinitive\b/i.test(s) && /\bedition\b/i.test(s)) return 5;
        if(/\bcollector'?s\b/i.test(s)) return 6;
        if(/\bbundle\b/i.test(s) || /\bpack\b/i.test(s)) return 8;
        return 9;
      };
      const groups = new Map();
      for(let i=0;i<computed.length;i++){
        const it = computed[i];
        const key = normKey(baseTitleForRank(it.name||"")) || normKey(it.name||"") || String(it.id||"");
        const g = groups.get(key) || { firstIndex: i, items: [] };
        g.items.push(it);
        groups.set(key, g);
      }
      const orderedGroups = Array.from(groups.values()).sort((a,b)=> a.firstIndex - b.firstIndex);
      computed = orderedGroups.flatMap(g => {
        if(g.items.length <= 1) return g.items;
        return g.items.slice().sort((a,b)=>{
          const pa = editionPriority(a.name);
          const pb = editionPriority(b.name);
          if(pa !== pb) return pa - pb;
          const ra = Number(a.psRank||999999);
          const rb = Number(b.psRank||999999);
          if(ra !== rb) return ra - rb;
          return String(a.name||"").localeCompare(String(b.name||""));
        });
      });
    }

    attachPublicEditions(computed);

    const total = computed.length;
    const startIdx = (page - 1) * perPage;
    const items = computed.slice(startIdx, startIdx + perPage);
    res.json({ region, page, perPage, total, items });
  }catch(e){
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/admin/allgames/:id", requireAdmin, (req, res) => {
  try{
    const id = String(req.params.id||"").trim();
    if(!id) return res.status(400).json({ ok:false, error:"id_required" });
    const doc = readJson(ALL_GAMES_PATH, { updatedAt:null, items:[] });
    const items = Array.isArray(doc.items) ? doc.items : [];
    const g = items.find(x => String(x.id) === id);
    if(!g) return res.status(404).json({ ok:false, error:"not_found" });
    res.json({ ok:true, item: g });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});

app.post("/api/admin/allgames/add", requireAdmin, (req, res) => {
  try{
    const body = req.body || {};
    const id = String(body.id||"").trim();
    const name = String(body.name||"").trim();
    if(!id) return res.status(400).json({ ok:false, error:"id_required" });
    if(!name) return res.status(400).json({ ok:false, error:"name_required" });

    const doc = readJson(ALL_GAMES_PATH, { updatedAt:null, items:[] });
    const items = Array.isArray(doc.items) ? doc.items : [];

    const idx = items.findIndex(x => String(x.id) === id);

    const normalize = (g) => {
      const next = {};
      next.id = id;
      next.name = name;
      next.cover = g.cover ? String(g.cover) : null;
      next.platform = String(g.platform||"");
      next.edition = (g.edition===null || typeof g.edition==='undefined') ? "Standard Edition" : (String(g.edition||"").trim()||"Standard Edition");
      next.players = normalizeGameMetaField(g.players);
      next.size = normalizeGameMetaField(g.size);
      next.rating = normalizeRatingValue(g.rating);
      next.description = cleanPsDescriptionText(g.description || "");

      // Concept ID groups multiple editions of the same game.
      // It's required for the "Новинки" page (matches PS category -> our library).
      const cid = String(g.conceptId || "").trim();
      next.conceptId = cid || null;

      // PS Store product IDs can differ by region for the same game.
      // Keep them explicitly so we can refresh regional prices later.
      next.productIds = (g.productIds && typeof g.productIds === 'object') ? g.productIds : {};
      const pidTR = next.productIds.TR ? String(next.productIds.TR).trim() : '';
      const pidUA = next.productIds.UA ? String(next.productIds.UA).trim() : '';
      next.productIds = {
        TR: pidTR || null,
        UA: pidUA || null,
      };
      next.regions = (g.regions && typeof g.regions === 'object') ? g.regions : {};
      const mkRegion = (code) => {
        const r = (next.regions[code] && typeof next.regions[code] === 'object') ? next.regions[code] : {};
        const out = {};
        out.salePrice = Number.isFinite(Number(r.salePrice)) ? Number(r.salePrice) : 0;
        try{ out.ru = normalizeRuVal(r.ru || 'none'); }catch(_e){ out.ru = 'none'; }
        out.sub = (typeof r.sub === 'string') ? r.sub : (r.sub ? String(r.sub) : '');
        return out;
      };
      next.regions.TR = mkRegion('TR');
      next.regions.UA = mkRegion('UA');
      // unify subscription like скидки
      next.regions.UA.sub = next.regions.TR.sub;
      return next;
    };

    const newItem = normalize(body);
    if(idx >= 0) items[idx] = newItem;
    else items.unshift(newItem);

    writeJson(ALL_GAMES_PATH, { updatedAt: new Date().toISOString(), items });
    res.json({ ok:true, count: items.length });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});

app.put("/api/admin/allgames/:id", requireAdmin, (req, res) => {
  try{
    const id = String(req.params.id||"").trim();
    if(!id) return res.status(400).json({ ok:false, error:"id_required" });
    const body = req.body || {};

    const doc = readJson(ALL_GAMES_PATH, { updatedAt:null, items:[] });
    const items = Array.isArray(doc.items) ? doc.items : [];
    const idx = items.findIndex(x => String(x.id) === id);
    if(idx < 0) return res.status(404).json({ ok:false, error:"not_found" });

    const cur = items[idx] || {};
    const next = Object.assign({}, cur);

    if(typeof body.name !== 'undefined') next.name = String(body.name||'').trim();
    if(typeof body.cover !== 'undefined') next.cover = body.cover ? String(body.cover) : null;
    if(typeof body.platform !== 'undefined') next.platform = String(body.platform||'');
    if(typeof body.edition !== 'undefined') next.edition = (body.edition===null) ? null : String(body.edition||'');
    if(typeof body.players !== 'undefined') next.players = normalizeGameMetaField(body.players);
    if(typeof body.size !== 'undefined') next.size = normalizeGameMetaField(body.size);
    if(typeof body.rating !== 'undefined') next.rating = normalizeRatingValue(body.rating);
    if(typeof body.description !== 'undefined') next.description = preserveAdminDescriptionText(body.description || '');
    if(typeof body.conceptId !== 'undefined') next.conceptId = body.conceptId ? String(body.conceptId).trim() : null;
    if(typeof body.additionalConceptIds !== 'undefined') next.additionalConceptIds = normalizeAdditionalConceptIds(body.additionalConceptIds);

    if(typeof body.productIds !== 'undefined'){
      const p = (body.productIds && typeof body.productIds === 'object') ? body.productIds : {};
      next.productIds = next.productIds && typeof next.productIds === 'object' ? next.productIds : {};
      if(typeof p.TR !== 'undefined') next.productIds.TR = p.TR ? String(p.TR).trim() : null;
      if(typeof p.UA !== 'undefined') next.productIds.UA = p.UA ? String(p.UA).trim() : null;
    }

    next.regions = next.regions && typeof next.regions === 'object' ? next.regions : {};
    const updRegion = (code)=>{
      const rBody = body.regions && body.regions[code] ? body.regions[code] : null;
      if(!rBody) return;
      const rCur = next.regions[code] && typeof next.regions[code] === 'object' ? next.regions[code] : {};
      const rNext = Object.assign({}, rCur);
      if(typeof rBody.salePrice !== 'undefined'){
        const n = Number(rBody.salePrice);
        rNext.salePrice = Number.isFinite(n) ? n : (rCur.salePrice||0);
      }
      if(typeof rBody.sub !== 'undefined') rNext.sub = (typeof rBody.sub === 'string') ? rBody.sub : (rBody.sub ? String(rBody.sub) : '');
      if(typeof rBody.ru !== 'undefined'){
        try{ rNext.ru = normalizeRuVal(rBody.ru); }catch(_e){ rNext.ru = 'none'; }
      }
      next.regions[code] = rNext;
    };
    updRegion('TR');
    updRegion('UA');
    if(!next.regions.TR) next.regions.TR = { salePrice:0, ru:'none', sub:'' };
    if(!next.regions.UA) next.regions.UA = { salePrice:0, ru:'none', sub:'' };

    // normalize
    try{ next.regions.TR.ru = normalizeRuVal(next.regions.TR.ru); }catch(_e){}
    try{ next.regions.UA.ru = normalizeRuVal(next.regions.UA.ru); }catch(_e){}
    next.regions.UA.sub = next.regions.TR.sub;

    next.id = cur.id;

    items[idx] = next;
    writeJson(ALL_GAMES_PATH, { updatedAt: new Date().toISOString(), items });
    res.json({ ok:true, item: next });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});

app.delete("/api/admin/allgames/:id", requireAdmin, (req, res) => {
  try{
    const id = String(req.params.id||"").trim();
    if(!id) return res.status(400).json({ ok:false, error:"id_required" });
    const doc = readJson(ALL_GAMES_PATH, { updatedAt:null, items:[] });
    const items = Array.isArray(doc.items) ? doc.items : [];
    const next = items.filter(g => String(g.id) !== id);
    if(next.length === items.length) return res.status(404).json({ ok:false, error:"not_found" });
    writeJson(ALL_GAMES_PATH, { updatedAt: new Date().toISOString(), items: next });
    res.json({ ok:true, count: next.length });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});



// Admin: list/add/update/delete PREORDERS (admin-only, not shown on public site yet)
app.get("/api/admin/preorders/list", requireAdmin, (req, res) => {
  // Auto-move released titles into "Всё игры"
  try{ moveReleasedPreordersToAllGames(); }catch(_e){}
  const doc = readJson(PREORDERS_PATH, { updatedAt:null, items:[] });
  const items = Array.isArray(doc.items) ? doc.items : [];
  res.json({ updatedAt: doc.updatedAt || null, items });
});

app.get("/api/admin/preorders/:id", requireAdmin, (req, res) => {
  try{
    const id = String(req.params.id||"").trim();
    if(!id) return res.status(400).json({ ok:false, error:"id_required" });
    const doc = readJson(PREORDERS_PATH, { updatedAt:null, items:[] });
    const items = Array.isArray(doc.items) ? doc.items : [];
    const g = items.find(x => String(x.id) === id);
    if(!g) return res.status(404).json({ ok:false, error:"not_found" });
    res.json({ ok:true, item: g });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});

app.post("/api/admin/preorders/add", requireAdmin, (req, res) => {
  try{
    const body = req.body || {};
    const id = String(body.id||"").trim();
    const name = String(body.name||"").trim();
    if(!id) return res.status(400).json({ ok:false, error:"id_required" });
    if(!name) return res.status(400).json({ ok:false, error:"name_required" });

    const doc = readJson(PREORDERS_PATH, { updatedAt:null, items:[] });
    const items = Array.isArray(doc.items) ? doc.items : [];
    const idx = items.findIndex(x => String(x.id) === id);

    const dateOrNull = (v) => {
      const s = String(v||"").trim();
      if(!s) return null;
      const m = s.match(/(20\d{2}-\d{2}-\d{2})/);
      return m ? m[1] : null;
    };

    const normalize = (g) => {
      const next = {};
      next.id = id;
      next.name = name;
      // optional: conceptId (needed for discount matching and global search)
      if(g && (g.conceptId || g.conceptID || g.concept_id)){
        next.conceptId = String(g.conceptId || g.conceptID || g.concept_id).trim();
      }else{
        next.conceptId = null;
      }
      next.cover = g.cover ? String(g.cover) : null;
      next.platform = String(g.platform||"");
      next.edition = (g.edition===null || typeof g.edition==='undefined') ? "Standard Edition" : (String(g.edition||"").trim()||"Standard Edition");
      next.players = normalizeGameMetaField(g.players);
      next.size = normalizeGameMetaField(g.size);
      next.rating = normalizeRatingValue(g.rating);
      next.description = cleanPsDescriptionText(g.description || "");
      next.releaseDate = dateOrNull(g.releaseDate);

      next.productIds = (g.productIds && typeof g.productIds === 'object') ? g.productIds : {};
      const pidTR = next.productIds.TR ? String(next.productIds.TR).trim() : '';
      const pidUA = next.productIds.UA ? String(next.productIds.UA).trim() : '';
      next.productIds = { TR: pidTR || null, UA: pidUA || null };

      next.regions = (g.regions && typeof g.regions === 'object') ? g.regions : {};
      const mkRegion = (code) => {
        const r = (next.regions[code] && typeof next.regions[code] === 'object') ? next.regions[code] : {};
        const out = {};
        out.salePrice = Number.isFinite(Number(r.salePrice)) ? Number(r.salePrice) : 0;
        try{ out.ru = normalizeRuVal(r.ru || 'none'); }catch(_e){ out.ru = 'none'; }
        out.sub = (typeof r.sub === 'string') ? r.sub : (r.sub ? String(r.sub) : '');
        return out;
      };
      next.regions.TR = mkRegion('TR');
      next.regions.UA = mkRegion('UA');
      // unify subscription like other lists
      next.regions.UA.sub = next.regions.TR.sub;
      return next;
    };

    const newItem = normalize(body);
    if(idx >= 0) items[idx] = newItem;
    else items.unshift(newItem);

    writeJson(PREORDERS_PATH, { updatedAt: new Date().toISOString(), items });
    res.json({ ok:true, count: items.length });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});

app.put("/api/admin/preorders/:id", requireAdmin, (req, res) => {
  try{
    const id = String(req.params.id||"").trim();
    if(!id) return res.status(400).json({ ok:false, error:"id_required" });
    const body = req.body || {};
    const doc = readJson(PREORDERS_PATH, { updatedAt:null, items:[] });
    const items = Array.isArray(doc.items) ? doc.items : [];
    const idx = items.findIndex(x => String(x.id) === id);
    if(idx < 0) return res.status(404).json({ ok:false, error:"not_found" });

    const cur = items[idx] || {};
    const next = Object.assign({}, cur);

    const dateOrNull = (v) => {
      const s = String(v||"").trim();
      if(!s) return null;
      const m = s.match(/(20\d{2}-\d{2}-\d{2})/);
      return m ? m[1] : null;
    };

    if(typeof body.name !== 'undefined') next.name = String(body.name||'').trim();
    if(typeof body.cover !== 'undefined') next.cover = body.cover ? String(body.cover) : null;
    if(typeof body.platform !== 'undefined') next.platform = String(body.platform||'');
    if(typeof body.edition !== 'undefined') next.edition = (body.edition===null) ? null : String(body.edition||'');
    if(typeof body.players !== 'undefined') next.players = normalizeGameMetaField(body.players);
    if(typeof body.size !== 'undefined') next.size = normalizeGameMetaField(body.size);
    if(typeof body.rating !== 'undefined') next.rating = normalizeRatingValue(body.rating);
    if(typeof body.releaseDate !== 'undefined') next.releaseDate = dateOrNull(body.releaseDate);
    if(typeof body.description !== 'undefined') next.description = preserveAdminDescriptionText(body.description || '');
    if(typeof body.conceptId !== 'undefined'){
      const s = String(body.conceptId||'').trim();
      next.conceptId = s || null;
    }

    if(typeof body.productIds !== 'undefined'){
      const p = (body.productIds && typeof body.productIds === 'object') ? body.productIds : {};
      next.productIds = next.productIds && typeof next.productIds === 'object' ? next.productIds : {};
      if(typeof p.TR !== 'undefined') next.productIds.TR = p.TR ? String(p.TR).trim() : null;
      if(typeof p.UA !== 'undefined') next.productIds.UA = p.UA ? String(p.UA).trim() : null;
    }

    next.regions = next.regions && typeof next.regions === 'object' ? next.regions : {};
    const updRegion = (code)=>{
      const rBody = body.regions && body.regions[code] ? body.regions[code] : null;
      if(!rBody) return;
      const rCur = next.regions[code] && typeof next.regions[code] === 'object' ? next.regions[code] : {};
      const rNext = Object.assign({}, rCur);
      if(typeof rBody.salePrice !== 'undefined'){
        const n = Number(rBody.salePrice);
        rNext.salePrice = Number.isFinite(n) ? n : (rCur.salePrice||0);
      }
      if(typeof rBody.sub !== 'undefined') rNext.sub = (typeof rBody.sub === 'string') ? rBody.sub : (rBody.sub ? String(rBody.sub) : '');
      if(typeof rBody.ru !== 'undefined'){
        try{ rNext.ru = normalizeRuVal(rBody.ru); }catch(_e){ rNext.ru = 'none'; }
      }
      next.regions[code] = rNext;
    };
    updRegion('TR');
    updRegion('UA');
    if(!next.regions.TR) next.regions.TR = { salePrice:0, ru:'none', sub:'' };
    if(!next.regions.UA) next.regions.UA = { salePrice:0, ru:'none', sub:'' };

    try{ next.regions.TR.ru = normalizeRuVal(next.regions.TR.ru); }catch(_e){}
    try{ next.regions.UA.ru = normalizeRuVal(next.regions.UA.ru); }catch(_e){}
    next.regions.UA.sub = next.regions.TR.sub;

    next.id = cur.id;
    items[idx] = next;
    writeJson(PREORDERS_PATH, { updatedAt: new Date().toISOString(), items });
    res.json({ ok:true, item: next });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});

app.delete("/api/admin/preorders/:id", requireAdmin, (req, res) => {
  try{
    const id = String(req.params.id||"").trim();
    if(!id) return res.status(400).json({ ok:false, error:"id_required" });
    const doc = readJson(PREORDERS_PATH, { updatedAt:null, items:[] });
    const items = Array.isArray(doc.items) ? doc.items : [];
    const next = items.filter(g => String(g.id) !== id);
    if(next.length === items.length) return res.status(404).json({ ok:false, error:"not_found" });
    writeJson(PREORDERS_PATH, { updatedAt: new Date().toISOString(), items: next });
    res.json({ ok:true, count: next.length });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// Admin: import (Playwright)

async function extractRuInfoFromPage(page){
  try{
    const data = await page.evaluate(()=>{
      const isRuToken = (v)=>{
        const s = String(v||"").toLowerCase().trim();
        return s==="ru" || s==="ru-ru" || s==="ru_ru" || s.includes("russian") || s.includes("русск") || s.includes("російс");
      };

      const scan = (node, path, acc)=>{
        if(node==null) return;
        if(Array.isArray(node)){
          for(const it of node) scan(it, path, acc);
          return;
        }
        if(typeof node === "object"){
          for(const k of Object.keys(node)){
            scan(node[k], path ? (path+"."+k) : k, acc);
          }
          return;
        }
        // primitive
        const p = String(path||"").toLowerCase();
        const val = node;
        const add = (arr, v)=>{ if(v!=null) arr.push(String(v)); };

        if(p.includes("audio") || p.includes("voice") || p.includes("dub")){
          add(acc.audio, val);
        }else if(p.includes("subtitle")){
          add(acc.subs, val);
        }else if(p.includes("screen") || p.includes("text") || p.includes("interface")){
          add(acc.screen, val);
        }else if(p.endsWith("language") || p.endsWith("languages")){
          add(acc.other, val);
        }
      };

      // Try __NEXT_DATA__ first (PlayStation Store is Next.js)
      let next = null;
      try{
        const el = document.querySelector('script#__NEXT_DATA__');
        if(el && el.textContent){
          next = JSON.parse(el.textContent);
        }
      }catch(e){}

      const acc = { audio:[], subs:[], screen:[], other:[] };
      if(next) scan(next, "", acc);

      const anyRu = (arr)=>arr.some(isRuToken);
      const ruVoice = anyRu(acc.audio);
      const ruText  = anyRu(acc.subs) || anyRu(acc.screen);

      if(ruVoice || ruText){
        
      const fullText = (document.body && (document.body.innerText||"")) || "";
      const t = fullText.toLowerCase();
      let sub = "";
      const hasEa = /\bea\s*play\b/i.test(fullText);
      const hasPs = /playstation\s*plus|ps\s*plus/i.test(fullText);
      const hasExtra = /\bextra\b/i.test(t);
      if(hasEa) sub = "eaplay";
      else if(hasPs && hasExtra) sub = "psplus_extra";

      return { ruVoice, ruText, ru: (ruVoice ? "voice" : "text"), sub, _src:"next", _audio: acc.audio.slice(0,20).join("|"), _subs: acc.subs.slice(0,20).join("|"), _screen: acc.screen.slice(0,20).join("|") };
      }

      // Fallback: visible text blocks near labels
      const RU_RE = /(Russian|Русск|Русский|Русская|Русское|Російськ|ru-ru|\bru\b)/i;
      const bodyText = (document.body && (document.body.innerText||"")) || "";
      const lines = bodyText.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);

      const findBlock = (labels)=>{
        const lset = labels.map(x=>x.toLowerCase());
        for(let i=0;i<lines.length;i++){
          const t = lines[i].toLowerCase();
          if(lset.some(l=>t===l || t.startsWith(l+":") || t.startsWith(l+" "))){
            const chunk = lines.slice(i, Math.min(lines.length, i+20)).join(" | ");
            return chunk;
          }
        }
        return "";
      };

      const audioBlock = findBlock(["audio languages","voice languages","dub languages","язык озвучки","озвучка","дубляж","ses dilleri","ses dili","seslendirme"]);
      const subBlock   = findBlock(["subtitles","subtitle languages","screen languages","text languages","субтитры","субтитри","текст","altyazı","altyazılar","ekran dilleri","ekran dili"]);

      const ruVoice2 = RU_RE.test(audioBlock);
      const ruText2  = RU_RE.test(subBlock);

            const fullText2 = (document.body && (document.body.innerText||"")) || "";
      const t2 = fullText2.toLowerCase();
      let sub2 = "";
      const hasEa2 = /\bea\s*play\b/i.test(fullText2);
      const hasPs2 = /playstation\s*plus|ps\s*plus/i.test(fullText2);
      const hasExtra2 = /\bextra\b/i.test(t2);
      if(hasEa2) sub2 = "eaplay";
      else if(hasPs2 && hasExtra2) sub2 = "psplus_extra";

return { ruVoice: ruVoice2, ruText: ruText2, ru: (ruVoice2 ? "voice" : (ruText2 ? "text" : "none")), sub: sub2, _src:"fallback", _audio: audioBlock, _subs: subBlock };
    });

    return { ruVoice: !!data.ruVoice, ruText: !!data.ruText, ru: data.ru || "none", sub: data.sub || "", _src: data._src || "", _audio: data._audio || "", _subs: data._subs || "", _screen: data._screen || "" };
  }catch(e){
    return { ruVoice:false, ruText:false, ru:"none", _src:"err" };
  }
}


app.post("/api/admin/import", requireAdmin, async (req, res) => {
  try{
    const url = String(req.body.url || "").trim();
    if(!url) return res.status(400).json({ ok:false, error:"url_required" });

    const m = url.match(/\/product\/([A-Z0-9_-]{10,})/i);
    const productId = m ? m[1].toUpperCase() : null;

    // Use locale from provided URL if present (en-tr, tr-tr, etc.)
    const locMatch = url.match(/store\.playstation\.com\/([a-z]{2}-[a-z]{2})\//i);
    const inputLocale = locMatch ? locMatch[1].toLowerCase() : null;

    // IMPORTANT: Admin now provides the UA product link (ru-ua). We must still fetch TR pricing/discounts.
    // UA link is the source of truth for title/edition/platform, TR is the source of TR price/discount/date.
    const makeUrl = (locale, pid) => pid ? `https://store.playstation.com/${locale}/product/${pid}` : url;

    const uaLocale = UA_LOCALE;
    const isUaInput = (inputLocale === uaLocale);

    // UA page: use provided URL directly when UA link is given
    let uaProductId = productId;
    let uaU = isUaInput ? url : makeUrl(uaLocale, uaProductId);

    // TR page: default to same productId, but some titles have different IDs per region.
    const trLocale = TR_LOCALE;
    let trProductId = productId;
    let trU = makeUrl(trLocale, trProductId);

    // Try Playwright first (best for anti-bot / dynamic pages). If browsers are missing (common on Windows),
    // fall back to plain HTTP fetch so import still works without downloading Playwright browsers.
    let chromium = null;
    try{
      ({ chromium } = require("playwright"));
    }catch(e){
      chromium = null;
    }

    const headersForLocale = (locale) => {
      const loc = String(locale||"").toLowerCase();
      if(loc === "ru-ua") return {
        "accept-language": "ru-UA,ru;q=0.9,uk-UA;q=0.8,en;q=0.7",
      };
      if(loc === "en-tr") return {
        "accept-language": "en-TR,en;q=0.9,tr-TR;q=0.8,tr;q=0.7",
      };
      // reasonable default
      return { "accept-language": "en-US,en;q=0.9" };
    };

    async function fetchHtmlHttp(u, locale){
      let status = 0;
      try{
        const ac = new AbortController();
        const t = setTimeout(()=>ac.abort(), 90000);
        const resp = await fetch(u, {
          redirect: "follow",
          signal: ac.signal,
          headers: {
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "cache-control": "no-cache",
            "pragma": "no-cache",
            ...headersForLocale(locale),
          }
        });
        clearTimeout(t);
        status = resp.status;
        const html = await resp.text();
        // Even without Playwright we can still detect subscription badges and (for TR) RU localization from HTML.
        const sub = extractSubFromHtml(html);
        let ruInfo = { ru:"none", ruVoice:false, ruText:false };
        const loc = String(locale||"").toLowerCase();
        if(loc.startsWith("tr")){
          ruInfo = extractRuFromHtmlTR(html);
        }
        return { status, html, ruInfo: { ...ruInfo, sub } };
      }catch(e){
        return { status, html:"", ruInfo:{ru:"none",ruVoice:false,ruText:false, sub:""}, error:String(e?.message||e) };
      }
    }

    async function fetchHtml(u, page, locale){
      if(!page) return await fetchHtmlHttp(u, locale);
      let status = 0;
      try{
        const resp = await page.goto(u, { waitUntil:"domcontentloaded", timeout: 90000 });
        status = resp ? resp.status() : 0;
        await page.waitForTimeout(1800);
        const html = await page.content();
        const ruInfo = await extractRuInfoFromPage(page);
        return { status, html, ruInfo };
      }catch(e){
        return { status, html:"", ruInfo:{ru:"none",ruVoice:false,ruText:false}, error:String(e?.message||e) };
      }
    }

    let browser = null, context = null, pageTR = null, pageUA = null;
    let tr = {status:0, html:""}, ua = {status:0, html:""};

    const tryWithPlaywright = async () => {
      browser = await chromium.launch({ headless: true });
      context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        viewport: { width: 1280, height: 720 }
      });
      pageTR = await context.newPage();
      pageUA = await context.newPage();
    };

    if(chromium){
      try{
        await tryWithPlaywright();
      }catch(e){
        // Playwright is installed but browsers are missing / blocked => fallback to HTTP
        chromium = null;
      }
    }

    // 3 попытки (часть игр иногда отдаёт пусто/блок)
    for(let attempt=1; attempt<=3; attempt++){
      tr = await fetchHtml(trU, pageTR, trLocale);
      ua = await fetchHtml(uaU, pageUA, uaLocale);
      const trBlocked = !tr.html || looksBlocked(tr.html);
      const uaBlocked = !ua.html || looksBlocked(ua.html);
      if(!trBlocked && !uaBlocked) break;
      await new Promise(r=>setTimeout(r, 800*attempt));
    }

    if(pageTR) await pageTR.close().catch(()=>{});
    if(pageUA) await pageUA.close().catch(()=>{});
    if(context) await context.close().catch(()=>{});
    if(browser) await browser.close().catch(()=>{});

    function parse(html, expectedSku){
      if(!html || looksBlocked(html)) return { blocked:true };
      const jsonLd = extractJsonLd(html);
      const platSet = new Set();
      for(const v of extractPlatformsFromJsonLd(jsonLd)) platSet.add(v);
      for(const v of extractPlatformsFromHtml(html)) platSet.add(v);
      // Platform detection should use the SKU we are currently parsing (TR/UA IDs can differ).
      const platform = finalizePlatform(platSet, expectedSku || productId);
      const h1 = extractH1(html) || extractTitle(html);
      const nameRaw0 = extractOg(html, "og:title") || extractOg(html, "twitter:title") || h1;
      const nameRaw = (nameRaw0 && looksBlocked(nameRaw0)) ? null : nameRaw0;
      let coverRaw = extractOg(html, "og:image") || extractOg(html, "twitter:image") || extractAnyImage(jsonLd);
      if(!coverRaw){
        coverRaw = extractImgByAlt(html, h1) || extractFirstHeroImage(html);
      }
      const offer = extractOfferPrice(jsonLd, expectedSku);
      const name = nameRaw ? String(nameRaw).replace(/\s+/g," ").trim() : null;
      const cover = coverRaw ? String(coverRaw).trim() : null;
      const discPerc = extractDiscountPercent(html);
      const edition = extractEdition(jsonLd, nameRaw0, html);
      const conceptId = extractConceptIdFromProductHtml(html, expectedSku || productId);
      const releaseDate = extractReleaseDate(html, jsonLd);
      const meta = extractGameMeta(html, jsonLd);
      // Discount end date: pull from Store (one region is enough; we later copy TR->UA)
      const until = (discPerc && discPerc > 0) ? (extractDiscountedUntil(html, jsonLd) || extractUntilDate(html)) : null;
      return { blocked:false, name, edition, cover, platform, conceptId: conceptId || null, salePrice: (offer && Number.isFinite(offer.price) ? offer.price : null), currency: offer ? offer.currency : null, discPerc: discPerc || 0, discountedUntil: until || null, releaseDate: releaseDate || null, players: meta.players || null, size: meta.size || null, rating: meta.rating };
    }

	    let parsedTR = parse(tr.html, productId);
    if(tr.ruInfo && tr.ruInfo.ru) parsedTR.ru = tr.ruInfo.ru;
    if(tr.ruInfo && tr.ruInfo.sub) parsedTR.sub = tr.ruInfo.sub;
    // HTTP fallback may not have ruInfo.sub (older cache) — detect from HTML too.
    if(!parsedTR.sub) parsedTR.sub = extractSubFromHtml(tr.html);
    // Don't blindly overwrite edition when a subscription marker is detected.
    // Subscription detection can be noisy and must not erase Deluxe/Ultimate editions.
    // Only default to Standard Edition when edition is missing.
    if(parsedTR.sub && (!parsedTR.edition || !String(parsedTR.edition).trim())) parsedTR.edition = "Standard Edition";

    let parsedUA = parse(ua.html, uaProductId || productId);
    if(ua.ruInfo && ua.ruInfo.ru) parsedUA.ru = ua.ruInfo.ru;
    if(ua.ruInfo && ua.ruInfo.sub) parsedUA.sub = ua.ruInfo.sub;
    if(!parsedUA.sub) parsedUA.sub = extractSubFromHtml(ua.html);

    // If UA has a more specific edition name (e.g., Deluxe/Ultimate) and TR ended up with a generic/default
    // value, prefer UA's edition for consistency.
    try {
      const trEd = parsedTR && parsedTR.edition ? String(parsedTR.edition).trim() : "";
      const uaEd = parsedUA && parsedUA.edition ? String(parsedUA.edition).trim() : "";
      const trIsGeneric = !trEd || /^standard edition$/i.test(trEd);
      const uaIsSpecific = !!uaEd && !/^standard edition$/i.test(uaEd);
      if(trIsGeneric && uaIsSpecific) parsedTR.edition = uaEd;
    } catch(_) {}

    // TR region: when admin provides a UA link, the TR productId can be different.
    // If TR page looks wrong or has no price/currency, resolve TR productId via TR search by UA title.
    const trLooksWrong = (p, html) => {
      const n = (p && p.name) ? String(p.name) : "";
      if(n.trim() === "PlayStation") return true;
      if(/Похоже, вы искали/i.test(n)) return true;
      if(!p || p.blocked) return true;
      if(p.salePrice == null || p.currency == null) return true;
      if(html && /\/search\//i.test(html) && (!p.salePrice && !p.currency)) return true;
      return false;
    };

    if(isUaInput && trLooksWrong(parsedTR, tr.html) && parsedUA && parsedUA.name){
      const tail = (uaProductId && uaProductId.includes("_00-")) ? uaProductId.split("_00-")[1] : "";
      const prefix = uaProductId ? uaProductId.split("-")[0] : "";
      const searchUrl = `https://store.playstation.com/${trLocale}/search/${encodeURIComponent(parsedUA.name)}`;
      const sr = await fetchHtmlHttp(searchUrl, trLocale);
      const found = [];
      if(sr && sr.html){
        const reProd = new RegExp(`/${trLocale}/product/([A-Z0-9_-]{10,})`, "gi");
        let mm;
        while((mm = reProd.exec(sr.html))){
          const id = mm[1].toUpperCase();
          if(!found.includes(id)) found.push(id);
        }
      }
      const scoreId = (id) => {
        let sc = 0;
        if(prefix && id.startsWith(prefix + "-")) sc += 100;
        if(tail && id.includes("_00-" + tail)) sc += 250;
        if(/_00-[A-Z0-9]{5,}/.test(id)) sc += 10;
        return sc;
      };
      let bestId = null, bestScore = -1;
      for(const id of found){
        const sc = scoreId(id);
        if(sc > bestScore){ bestScore = sc; bestId = id; }
      }
      if(bestId && bestId !== trProductId){
        trProductId = bestId;
        trU = `https://store.playstation.com/${trLocale}/product/${trProductId}`;
        tr = await fetchHtmlHttp(trU, trLocale);
        parsedTR = parse(tr.html, trProductId);
        if(tr.ruInfo && tr.ruInfo.ru) parsedTR.ru = tr.ruInfo.ru;
        if(tr.ruInfo && tr.ruInfo.sub) parsedTR.sub = tr.ruInfo.sub;
        if(!parsedTR.sub) parsedTR.sub = extractSubFromHtml(tr.html);
        if(parsedTR.sub) parsedTR.edition = "Standard Edition";
      }
    }

    // UA region: some titles have a different productId than TR.
    // If UA page looks like a "not found/search" page OR price is missing,
    // try to resolve the correct UA productId via UA search by title, then refetch UA page.
    const uaLooksWrong = (p, html) => {
      const n = (p && p.name) ? String(p.name) : "";
      if(/Похоже, вы искали/i.test(n)) return true;
      if(n.trim() === "PlayStation") return true;
      if(!p || p.blocked) return true;
      if(p.salePrice == null) return true;
      // Extra heuristic: search/landing pages often contain "/search/" in canonical
      if(html && /\/search\//i.test(html) && (!p.salePrice && !p.currency)) return true;
      return false;
    };

    // Helper: collect product IDs from a PS Store HTML page.
    const extractProductIdsFromHtml = (html, locale) => {
      const ids = [];
      if(!html) return ids;
      const reProd = new RegExp(`/${String(locale)}/product/([A-Z0-9_-]{10,})`, "gi");
      let mm;
      while((mm = reProd.exec(html))){
        const id = mm[1].toUpperCase();
        if(!ids.includes(id)) ids.push(id);
      }
      return ids;
    };

    if(uaLooksWrong(parsedUA, ua.html) && parsedTR && parsedTR.name){
      const tail = (productId && productId.includes("_00-")) ? productId.split("_00-")[1] : "";
      const prefix = productId ? productId.split("-")[0] : "";

      // 1) Try resolving by title (most human-friendly)
      const searchUrlByTitle = `https://store.playstation.com/${uaLocale}/search/${encodeURIComponent(parsedTR.name)}`;
      const srTitle = await fetchHtmlHttp(searchUrlByTitle, uaLocale);
      let found = extractProductIdsFromHtml(srTitle && srTitle.html ? srTitle.html : "", uaLocale);

      // 2) If title search yields nothing (sometimes PS Store renders results client-side),
      // try searching by the content tail (the part after _00-), which often appears in URLs.
      if((!found || !found.length) && tail){
        const searchUrlByTail = `https://store.playstation.com/${uaLocale}/search/${encodeURIComponent(tail)}`;
        const srTail = await fetchHtmlHttp(searchUrlByTail, uaLocale);
        found = extractProductIdsFromHtml(srTail && srTail.html ? srTail.html : "", uaLocale);
      }

      const scoreId = (id) => {
        let sc = 0;
        if(prefix && id.startsWith(prefix + "-")) sc += 100;
        if(tail && id.includes("_00-" + tail)) sc += 200;
        // Prefer IDs that look like base games (heuristic)
        if(/_00-[A-Z0-9]{5,}/.test(id)) sc += 10;
        return sc;
      };

      let bestId = null, bestScore = -1;
      for(const id of found){
        const sc = scoreId(id);
        if(sc > bestScore){ bestScore = sc; bestId = id; }
      }

      if(bestId && bestId !== uaProductId){
        uaProductId = bestId;
        uaU = `https://store.playstation.com/${uaLocale}/product/${uaProductId}`;
        // refetch UA product page (one more request)
        ua = await fetchHtml(uaU, pageUA, uaLocale);
        parsedUA = parse(ua.html, uaProductId);
        if(ua.ruInfo && ua.ruInfo.ru) parsedUA.ru = ua.ruInfo.ru;
        if(ua.ruInfo && ua.ruInfo.sub) parsedUA.sub = ua.ruInfo.sub;
        if(!parsedUA.sub) parsedUA.sub = extractSubFromHtml(ua.html);
      }
    }
    

    // Discount percent: prefer the percent computed from this exact product/version price.
    // PS Store pages can contain several editions at once; taking the maximum textual percent
    // makes bundles show Standard Edition's discount (for example 80% instead of 60%).
    let exactDiscFromBase = 0;
    try{
      const allDocForImport = readJson(ALL_GAMES_PATH, { items:[] });
      const allItemsForImport = Array.isArray(allDocForImport.items) ? allDocForImport.items : [];
      const trPidForImport = String(trProductId || productId || "").toUpperCase();
      const baseItemForImport = allItemsForImport.find(x => {
        const id = String(x && x.id || "").toUpperCase();
        const trPid = String(x && x.productIds && x.productIds.TR || "").toUpperCase();
        return trPidForImport && (id === trPidForImport || trPid === trPidForImport);
      });
      const baseTR = baseItemForImport && baseItemForImport.regions && baseItemForImport.regions.TR ? Number(baseItemForImport.regions.TR.salePrice || 0) : 0;
      const saleTR = parsedTR && Number.isFinite(Number(parsedTR.salePrice)) ? Number(parsedTR.salePrice) : 0;
      exactDiscFromBase = computeDiscountPercentFromPrices(baseTR, saleTR);
    }catch(_e){}

    const bestDisc = exactDiscFromBase > 0
      ? exactDiscFromBase
      : ((parsedTR && !parsedTR.blocked && Number.isFinite(parsedTR.discPerc) && parsedTR.discPerc > 0)
          ? parsedTR.discPerc
          : ((parsedUA && !parsedUA.blocked && Number.isFinite(parsedUA.discPerc) && parsedUA.discPerc > 0)
              ? parsedUA.discPerc
              : 0));
    if(parsedTR) parsedTR.discPerc = bestDisc;
    if(parsedUA) parsedUA.discPerc = bestDisc;

    // Copy discount end date from one region to the other (TR preferred)
    const bestUntil = (parsedTR && parsedTR.discountedUntil) ? parsedTR.discountedUntil
                    : ((parsedUA && parsedUA.discountedUntil) ? parsedUA.discountedUntil : null);
    if(bestUntil){
      if(parsedTR) parsedTR.discountedUntil = bestUntil;
      if(parsedUA) parsedUA.discountedUntil = bestUntil;
    }else{
      if(parsedTR) parsedTR.discountedUntil = null;
      if(parsedUA) parsedUA.discountedUntil = null;
    }

    // Ensure REAL title: if TR title missing/blocked, try chihiro API by productId (only for /product/)
    if((!parsedTR.name || looksBlocked(parsedTR.name)) && (trProductId || productId)){
      // Use the same locale we used to fetch the product page.
      const t = await fetchChihiroTitle((trProductId || productId), trLocale);
      if(t) parsedTR.name = t;
    }
    if((!parsedUA.name || looksBlocked(parsedUA.name)) && (uaProductId || productId)){
      const t = await fetchChihiroTitle((uaProductId || productId), uaLocale);
      if(t) parsedUA.name = t;
    }

    // Title policy (per request): the "main" game title in admin should come from TR.
    // We do NOT copy UA title into TR. Instead, if TR title is missing, we try a few TR/neutral locales.
    if(parsedTR && (!parsedTR.name || looksBlocked(parsedTR.name)) && (trProductId || productId)){
      const pidForTitle = (trProductId || productId);
      const tryLocales = [trLocale, "en-tr", "tr-tr", "en-us", "en-gb"];
      for(const loc of tryLocales){
        const t = await fetchChihiroTitle(pidForTitle, loc);
        if(t){ parsedTR.name = t; break; }
      }
      if(!parsedTR.name){
        // Last resort: scrape product pages from alt locales for a title.
        const t2 = await fetchTitleFromAltLocales(pidForTitle);
        if(t2) parsedTR.name = t2;
      }
    }
    // UA: if missing, we may still fill it from other locales, but TR remains the source for admin title.
    if(parsedUA && (!parsedUA.name || looksBlocked(parsedUA.name)) && (uaProductId || productId)){
      const pidForTitle = (uaProductId || productId);
      const tryLocales = [uaLocale, "ru-ua", "uk-ua", "en-us", "en-gb"];
      for(const loc of tryLocales){
        const t = await fetchChihiroTitle(pidForTitle, loc);
        if(t){ parsedUA.name = t; break; }
      }
      if(!parsedUA.name){
        const t2 = await fetchTitleFromAltLocales(pidForTitle);
        if(t2) parsedUA.name = t2;
      }
    }

    
    // --- Platform: prefer explicit TR/UA; if ambiguous, confirm via Chihiro in other locales.
    let bestPlatform = (parsedTR && parsedTR.platform) ? parsedTR.platform : null;
    if(parsedUA && parsedUA.platform){
      if(!bestPlatform) bestPlatform = parsedUA.platform;
      else if(bestPlatform !== "PS4 / PS5" && parsedUA.platform === "PS4 / PS5") bestPlatform = parsedUA.platform;
    }
    // If still ambiguous, try Chihiro in other locales for a reliable platform list.
    if(productId && (!bestPlatform || bestPlatform === "PS4 / PS5")){
      const altPlat = await fetchPlatformsFromAltLocales(productId);
      if(altPlat) bestPlatform = altPlat;
    }
    if(bestPlatform){
      if(parsedTR) parsedTR.platform = bestPlatform;
      if(parsedUA) parsedUA.platform = bestPlatform;
    }

    // --- RU localization rule:
    // For скидки (legacy): RU is determined from UA and mirrored to TR.
    // For "Все игры": admin wants RU separately for TR and UA.
    // The admin UI can send { ruSeparate: true } to keep both values.
    const ruSeparate = !!req.body.ruSeparate;
    if(!ruSeparate){
      try{
        const uaRu = normalizeRuVal((parsedUA && parsedUA.ru) ? parsedUA.ru : "none");
        if(parsedUA) parsedUA.ru = uaRu;
        if(parsedTR) parsedTR.ru = uaRu;
      }catch(_e){}
    }else{
      try{
        if(parsedTR) parsedTR.ru = normalizeRuVal((parsedTR && parsedTR.ru) ? parsedTR.ru : "none");
        if(parsedUA) parsedUA.ru = normalizeRuVal((parsedUA && parsedUA.ru) ? parsedUA.ru : "none");
      }catch(_e){}
    }
// If still no real title - do NOT allow import
    const realTitle = parsedTR && !parsedTR.blocked ? parsedTR.name : null;
    if(!realTitle){
      // TITLE missing is allowed now

    }

    const ok = parsedTR && !parsedTR.blocked;

    res.json({
      ok,
      // Back-compat: keep old field
      productId,
      // New: explicit product IDs per region (TR/UA can differ for the same game)
      productIds: {
        TR: (trProductId || productId || null),
        UA: (uaProductId || productId || null),
      },
      urls:{ TR: trU, UA: uaU },
      status:{ TR: tr.status||null, UA: ua.status||null },
      errors:{ TR: tr.error||null, UA: ua.error||null },
      parsed:{ TR: parsedTR, UA: parsedUA }
    });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});

app.post("/api/admin/games/add", requireAdmin, async (req, res) => {
  try{
    const g = req.body || {};
    // We no longer take a manually заданную дату скидки from админки/дефолта.
    // discountedUntil must be получена from Store parsing and пришедшая в regions.*.

    if(!g.id || !g.name) return res.status(400).json({ ok:false, error:"id_and_name_required" });
    const doc = readJson(GAMES_PATH, { updatedAt:null, items:[] });
    const items = Array.isArray(doc.items) ? doc.items : [];
    if(items.find(x=>x.id===g.id)) return res.status(409).json({ ok:false, error:"already_exists" });

    // IMPORTANT: popRank scraping must never block the "Add" button.
    // We assign a placeholder rank now and update ranks in the background after the response.
    const psRank = null;

    const next = {
      id: String(g.id),
      name: String(g.name),
      cover: g.cover ? String(g.cover) : null,
      platform: g.platform ? String(g.platform) : "PS4 / PS5",
      edition: g.edition ? String(g.edition) : null,
      players: normalizeGameMetaField(g.players),
      size: normalizeGameMetaField(g.size),
      rating: normalizeRatingValue(g.rating),

      // If we found a PS browse rank, use it. Otherwise keep unknown titles at the end.
      popRank: Number.isFinite(psRank) ? psRank : 1000000000,
      regions: {
        TR: g.regions && g.regions.TR ? g.regions.TR : { discPerc:0, discountedUntil:null, salePrice:0, ru:"none", sub:"" },
        UA: g.regions && g.regions.UA ? g.regions.UA : { discPerc:0, discountedUntil:null, salePrice:0, ru:"none", sub:"" }
      }
    };
    
    // Normalize RU fields to canonical values
    try{
      if(next.regions && next.regions.TR) next.regions.TR.ru = normalizeRuVal(next.regions.TR.ru);
      if(next.regions && next.regions.UA) next.regions.UA.ru = normalizeRuVal(next.regions.UA.ru);
    }catch(e){}

    // Ensure subscription fields exist (editable per-region)
    if(!next.regions.TR) next.regions.TR = { discPerc:0, discountedUntil:null, salePrice:0, ru:"none", sub:"" };
    if(!next.regions.UA) next.regions.UA = { discPerc:0, discountedUntil:null, salePrice:0, ru:"none", sub:"" };
    if(typeof next.regions.TR.sub !== "string") next.regions.TR.sub = next.regions.TR.sub ? String(next.regions.TR.sub) : "";
    if(typeof next.regions.UA.sub !== "string") next.regions.UA.sub = next.regions.UA.sub ? String(next.regions.UA.sub) : "";

    // Subscription is not регион-зависимая в нашем проекте:
    // если игра в подписке в Турции, то она же в подписке и в Украине.
    next.regions.UA.sub = next.regions.TR.sub;
    items.push(next);

    // Also (re)apply any known PS browse ranks to existing items using the cache.
    // (Cheap operation; uses local cache only.)
    try{ applyPsBrowseRanksToItems(items, UA_LOCALE); }catch(_e){}

    writeJson(GAMES_PATH, { updatedAt: new Date().toISOString(), items });
    res.json({ ok:true, count: items.length });

    // Background: fetch PS browse rank + re-sort without blocking the UI.
    // Fire-and-forget: errors are swallowed.
    try{ scheduleBackgroundRankAndResort(String(g.id), String(g.name), UA_LOCALE); }catch(_e){}
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});

app.get("/ps95_manage", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.use("/", express.static(path.join(__dirname, "public")));

const PORT = Number(process.env.PORT || ENV.PORT || 3000);
// Auto-move released preorders on startup and periodically (no admin visit required)
try{ moveReleasedPreordersToAllGames(); }catch(_e){}
setInterval(() => {
  try{ moveReleasedPreordersToAllGames(); }catch(_e){}
}, 60 * 60 * 1000);

app.listen(PORT, () => console.log("PlayStore95 running on http://localhost:" + PORT));
console.log("PlayStore95 build: DATE_PERSIST_LOCALSTORAGE_RUFORMAT_CJS5 2025-12-22");

//test


// Public: GLOBAL SEARCH across all games + preorders (includes subscription titles)
// Works from any page/tab on the client.
app.get("/api/search", async (req, res) => {
  try{
    const region = String(req.query.region || "TR").toUpperCase();
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
    let perPage = 36;
    if(req.query.perPage){
      const n = parseInt(String(req.query.perPage),10);
      if(Number.isFinite(n) && n>0) perPage = Math.min(60, Math.max(1, n));
    }
    const q = String(req.query.q || "").trim();
    const platform = String(req.query.platform || "").trim();
    const sort = String(req.query.sort || "pop").trim();

    // Base sources: all games + preorders (search must be global).
    // Keep a source marker so the UI can show "Предзаказ" badge in search results.
    const allDoc = readJson(ALL_GAMES_PATH, { updatedAt:null, items:[] });
    const preDoc = readJson(PREORDERS_PATH, { updatedAt:null, items:[] });
    let items = [];
    if(Array.isArray(allDoc.items)) items = items.concat(allDoc.items.map(x=>Object.assign({_src:"all"}, x)));
    if(Array.isArray(preDoc.items)) items = items.concat(preDoc.items.map(x=>Object.assign({_src:"pre"}, x)));

    // NOTE: Search must be truly global.
    // Do NOT exclude subscription games here — users expect to find all editions,
    // including those currently available via EA Play / PS Plus tiers.

    // De-duplicate strictly by product id.
    // IMPORTANT: do NOT dedupe by conceptId, because different editions
    // (Standard/Deluxe/Ultimate) often share the same conceptId.
    const keyOf = (g)=>{
      const id = g && (g.id || g.productId || g.productID || (g.productIds && (g.productIds.TR || g.productIds.UA)));
      if(id) return "i:"+String(id);
      const cid = g && (g.conceptId || g.conceptID || g.concept_id);
      if(cid) return "c:"+String(cid)+"|"+normText(String(g.edition||""));
      return "n:"+normText(String(g && g.name || ""))+
        "|"+normText(String(g && g.edition || ""))+
        "|"+normText(String(g && g.platform || ""));
    };
    const seen = new Set();
    const dedup = [];
    for(const g of items){
      const k = keyOf(g);
      if(seen.has(k)) continue;
      seen.add(k);
      dedup.push(g);
    }
    items = dedup;

    // Apply search + platform filters
    // Match by name + edition to make sure queries like "gta premium" work.
    if(q) items = items.filter(x => smartMatch([x.name, x.edition].filter(Boolean).join(" "), q));
    if(platform) items = items.filter(x => platformPass(x.platform || "", platform));

    // Build a computed list identical to other catalog endpoints.
    // This guarantees correct language badge, discount price, and preorder badge.
    const store = readStore();
    const rules = (store.rates && store.rates[region]) ? store.rates[region] : [];
    const step = Number(store.settings?.roundStep || 50);
    const discountsIndex = readActiveDiscountsIndex();

    let computed = items.map(g => {
      const reg = (g.regions && g.regions[region]) ? g.regions[region] : null;
      const baseStorePrice = reg ? Number(reg.salePrice || 0) : 0;
      if(!Number.isFinite(baseStorePrice) || baseStorePrice <= 0) return null;

      const dg = (g.id && discountsIndex.byId.get(String(g.id))) || null;

      let discPerc = 0;
      let discountedUntil = null;
      let storePrice = baseStorePrice;
      if(dg && dg.regions && dg.regions[region] && isDiscountActiveForRegion(dg.regions[region])){
        const dreg = dg.regions[region];
        discPerc = Number(dreg.discPerc || 0) || 0;
        discountedUntil = dreg.discountedUntil || null;
        const dPrice = Number(dreg.salePrice || 0);
        if(Number.isFinite(dPrice) && dPrice > 0){
          storePrice = dPrice;
        }else if(discPerc > 0){
          storePrice = Math.max(0, baseStorePrice * (1 - (discPerc/100)));
        }
      }

      const rate = pickRate(rules, storePrice);
      let rub = roundUp(storePrice * rate, step);
      rub = clampMinGamePriceRub(store, rub);
      const trSub = (g.regions && g.regions.TR && g.regions.TR.sub) ? String(g.regions.TR.sub) : "";
      const uaSub = (g.regions && g.regions.UA && g.regions.UA.sub) ? String(g.regions.UA.sub) : "";
      const anySub = trSub || uaSub;

      const base = {
        id: g.id,
        name: g.name,
        edition: anySub ? "Standard Edition" : (g.edition || "Standard Edition"),
        ru: normalizeRuVal(reg && (reg.ru ?? reg.ruLang ?? reg.russian ?? reg.rus ?? reg.langRu ?? reg.languageRu)),
        sub: anySub,
        platform: g.platform || "PS4 / PS5",
        players: g.players || null,
        size: g.size || null,
        rating: (typeof g.rating !== "undefined" ? g.rating : null),
        cover: g.cover || "",
        discPerc,
        discountedUntil,
        storePrice,
        finalPriceRub: rub,
        popRank: g.popRank || 999999,
        releaseDate: g.releaseDate || null,
        isPreorder: ((g._src === "pre") || !!g.isPreorder) && isFutureReleaseDateYMD(g.releaseDate)
      };
      if(q) base._score = relevanceScore([g.name, g.edition].filter(Boolean).join(" "), q);
      return base;
    });
    computed = computed.filter(Boolean);

    // Sorting
    if(q){
      computed.sort((a,b)=> (b._score||0)-(a._score||0));
    }else if(sort === "name"){
      computed.sort((a,b)=>String(a.name||"").localeCompare(String(b.name||"")));
    }else{
      computed.sort((a,b)=>{
        const ra = Number(a.popRank ?? 999999);
        const rb = Number(b.popRank ?? 999999);
        if(ra !== rb) return ra - rb;
        return String(a.name||"").localeCompare(String(b.name||""));
      });
    }

    const total = computed.length;
    const start = (page - 1) * perPage;
    const pageItems = computed.slice(start, start + perPage);
    return res.json({ region, page, perPage, total, items: pageItems });


    // NOTE: response returned above (computed)
  }catch(e){
    res.status(500).json({ error: String(e) });
  }
});
