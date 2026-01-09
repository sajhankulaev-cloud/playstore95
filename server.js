const fs = require("fs");
const https = require("https");
const path = require("path");
const express = require("express");

const app = express();

// --- PlayStation Browse rank ("All games" page order) helpers ---
// We assign popRank to match the ordering on https://store.playstation.com/<locale>/pages/browse
// by scraping browse pages and finding the game's position.

const PS_BROWSE_CACHE_PATH = path.join(__dirname, "data", "ps_browse_rank_cache.json");
const PS_BROWSE_PAGE_SIZE_GUESS = 24; // PS Store browse commonly shows 24 tiles per page
const PS_BROWSE_MAX_PAGES_HARD_LIMIT = 500; // safety

function readPsBrowseCache(){
  try{
    const raw = fs.readFileSync(PS_BROWSE_CACHE_PATH, "utf-8");
    const j = JSON.parse(raw);
    if(!j || typeof j !== "object") return { updatedAt:null, locale:"", ranks:{} };
    if(!j.ranks || typeof j.ranks !== "object") j.ranks = {};
    return j;
  }catch{
    return { updatedAt:null, locale:"", ranks:{} };
  }
}
function writePsBrowseCache(obj){
  try{ fs.writeFileSync(PS_BROWSE_CACHE_PATH, JSON.stringify(obj, null, 2), "utf-8"); }catch(_e){}
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

function extractBrowseTitles(html){
  // Pull anchor text for product/concept links, preserve document order.
  const titles = [];
  if(!html || typeof html !== "string") return titles;
  const re = /<a\b[^>]*href=["']([^"']+\/(?:product|concept)\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  const seen = new Set();
  while((m = re.exec(html)) !== null){
    let txt = m[2] || "";
    txt = txt.replace(/<[^>]+>/g, " ");
    txt = decodeHtml(txt).replace(/\s+/g, " ").trim();
    if(!txt) continue;
    // quick filters for non-title anchors
    if(txt.length < 2) continue;
    if(/^(image|ps plus|free|бесплатно)$/i.test(txt)) continue;
    const key = normText(txt);
    if(!key) continue;
    if(seen.has(key)) continue;
    seen.add(key);
    titles.push(txt);
  }
  return titles;
}

function psBrowseUrl(locale, page){
  const loc = String(locale || "ru-ua").trim();
  if(!page || page === 1) return `https://store.playstation.com/${loc}/pages/browse`;
  // PS store uses /pages/browse/2/ style paging
  return `https://store.playstation.com/${loc}/pages/browse/${page}/`;
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

async function getPsBrowseRankByName(name, locale){
  // Returns a 1-based absolute rank (across pages) if found; otherwise null.
  const today = new Date().toISOString();
  const cache = readPsBrowseCache();
  const loc = String(locale || "ru-ua").trim();
  const key = normText(name);
  if(!key) return null;

  // Use cache if it was updated today and locale matches.
  if(cache.locale === loc && cache.updatedAt && sameDayIso(cache.updatedAt, today)){
    const r = cache.ranks[key];
    if(Number.isFinite(r)) return r;
  }

  // Always (re)use cache map as we discover more titles.
  if(cache.locale !== loc){
    cache.locale = loc;
    cache.ranks = {};
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
    const titles = extractBrowseTitles(html);
    if(!titles.length){
      // stop if we can no longer parse
      break;
    }
    // store ranks into cache
    for(let i=0;i<titles.length;i++){
      const tKey = normText(titles[i]);
      if(tKey && !cache.ranks[tKey]){
        cache.ranks[tKey] = (page-1) * PS_BROWSE_PAGE_SIZE_GUESS + (i+1);
      }
    }
    const best = bestTitleMatchIndex(titles, name);
    // 9999 means exact match
    if(best.idx >= 0 && (best.score >= 120 || best.score === 9999 || best.score >= 5000)){
      const rank = (page-1) * PS_BROWSE_PAGE_SIZE_GUESS + (best.idx+1);
      cache.ranks[key] = rank;
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
  const loc = String(locale || "ru-ua").trim();
  const map = (cache.locale === loc && cache.ranks) ? cache.ranks : {};

  // First pass: set known ranks; unknown -> large number
  for(let i=0;i<items.length;i++){
    const it = items[i];
    const k = normText(it?.name || "");
    const r = k ? map[k] : null;
    if(Number.isFinite(r)) it.popRank = r;
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
  _bgRankPending.set(gid, { id: gid, name: String(name||""), locale: String(locale||"ru-ua") });
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
          rank = await getPsBrowseRankByName(job.name, job.locale);
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



app.use(express.json({ limit: "5mb" }));

const DATA_DIR = path.join(__dirname, "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");
const GAMES_PATH = path.join(DATA_DIR, "games.json");

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

function readStore() {
  const s = readJson(STORE_PATH, { settings:{roundStep:50, whatsappLink:""}, rates:{TR:[],UA:[]} });
  if (ENV.WHATSAPP_LINK) s.settings.whatsappLink = ENV.WHATSAPP_LINK;
  if (ENV.ROUND_STEP) s.settings.roundStep = Number(ENV.ROUND_STEP) === 100 ? 100 : 50;
  return s;
}

function pickRate(rules, price) {
  for (const r of rules) {
    const maxOk = (r.max === null) ? true : price < r.max;
    if (price >= r.min && maxOk) return r.rate;
  }
  return rules.length ? rules[rules.length - 1].rate : 1;
}
function roundUp(value, step) { const s = Number(step) || 50; return Math.ceil(value / s) * s; }

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
  const m = html.match(/Save\s*(\d{1,3})%/i) || html.match(/%(\d{1,3})\s*indirim/i);
  return m ? Number(m[1]) : 0;
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
  const hasAnyUntil = { TR:false, UA:false };
  for (const g of (games.items||[])) {
    for (const r of ["TR","UA"]) {
      if (g.regions && g.regions[r] && g.regions[r].discountedUntil) hasAnyUntil[r]=true;
    }
  }
  res.json({ settings: store.settings, updatedAt: { games: games.updatedAt || null }, hasAnyUntil, total: Array.isArray(games.items)?games.items.length:0 });
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
  if(s==="voice" || s.includes("озвуч") || s.includes("voice")) return "voice";
  if(s==="text" || s.includes("текст") || s.includes("sub") || s.includes("screen")) return "text";
  if(s==="none" || s.includes("отсут")) return "none";
  return "none";
}

function smartMatch(name, q){
  const nq = normText(q);
  if(!nq) return true;
  const tokens = nq.split(" ").filter(Boolean);
  const nn = normText(name);
  return tokens.every(t => nn.includes(t));
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

app.get("/api/games", (req, res) => {
  try {
    const store = readStore();
    const region = String(req.query.region || "TR").toUpperCase();
    const sort = String(req.query.sort || "pop");
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
    const perPage = 24;
    const q = String(req.query.q || "").trim();
    const platform = String(req.query.platform || "").trim();
    const until = String(req.query.until || req.query.discountedUntil || "").trim();

    const gamesDoc = readJson(GAMES_PATH, { updatedAt:null, items:[] });
    let all = Array.isArray(gamesDoc.items) ? gamesDoc.items : [];
    if (q) all = all.filter(x => smartMatch(x.name || "", q));
    if (platform) all = all.filter(x => platformPass(x.platform || "", platform));

    const rules = store.rates[region] || [];
    const step = store.settings.roundStep || 50;

    let computed = all.map(g => {
      const reg = (g.regions && g.regions[region]) ? g.regions[region] : null;
      const storePrice = reg ? Number(reg.salePrice || 0) : 0;

      // Hide the game ONLY in the selected region when that region's price is 0 (or missing/invalid).
      // Example: TR=450 -> visible in TR; UA=0 -> hidden in UA.
      if (!Number.isFinite(storePrice) || storePrice <= 0) return null;

      const rate = pickRate(rules, storePrice);
      const rub = roundUp(storePrice * rate, step);
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
        cover: g.cover || "",
        discPerc: reg ? Number(reg.discPerc || 0) : 0,
        discountedUntil: reg ? (reg.discountedUntil || null) : null,
        storePrice: storePrice,
        finalPriceRub: rub,
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

    const total = computed.length;
    const startIndex = (page - 1) * perPage;
    const items = computed.slice(startIndex, startIndex + perPage).map(({ _score, ...rest }) => rest);
    res.json({ region, page, perPage, total, items, updatedAt: gamesDoc.updatedAt || null });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Admin: rates/settings
app.get("/api/admin/rates", requireAdmin, (req, res) => {
  const store = readStore();
  const region = String(req.query.region || "TR").toUpperCase();
  res.json({ region, rules: store.rates[region] || [] });
});
app.put("/api/admin/rates", requireAdmin, (req, res) => {
  const store = readStore();
  const region = String(req.body.region || "TR").toUpperCase();
  const rules = Array.isArray(req.body.rules) ? req.body.rules : [];
  store.rates[region] = rules
    .map(r => ({ min:Number(r.min), max:(r.max===null||r.max===""||typeof r.max==="undefined")?null:Number(r.max), rate:Number(r.rate) }))
    .filter(r => Number.isFinite(r.min) && (r.max===null || Number.isFinite(r.max)) && Number.isFinite(r.rate));
  writeJson(STORE_PATH, store);
  res.json({ ok:true });
});
app.get("/api/admin/settings", requireAdmin, (req, res) => res.json(readStore().settings));
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
      // Discount end date: pull from Store (one region is enough; we later copy TR->UA)
      const until = (discPerc && discPerc > 0) ? (extractDiscountedUntil(html, jsonLd) || extractUntilDate(html)) : null;
      return { blocked:false, name, edition, cover, platform, salePrice: (offer && Number.isFinite(offer.price) ? offer.price : null), currency: offer ? offer.currency : null, discPerc: discPerc || 0, discountedUntil: until || null };
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

    if(uaLooksWrong(parsedUA, ua.html) && parsedTR && parsedTR.name){
      const tail = (productId && productId.includes("_00-")) ? productId.split("_00-")[1] : "";
      const prefix = productId ? productId.split("-")[0] : "";
      const searchUrl = `https://store.playstation.com/${uaLocale}/search/${encodeURIComponent(parsedTR.name)}`;
      const sr = await fetchHtmlHttp(searchUrl, uaLocale);

      const found = [];
      if(sr && sr.html){
        const reProd = new RegExp(`/${uaLocale}/product/([A-Z0-9_-]{10,})`, "gi");
        let mm;
        while((mm = reProd.exec(sr.html))){
          const id = mm[1].toUpperCase();
          if(!found.includes(id)) found.push(id);
        }
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
    

    // Discount percent: take from TR if available, otherwise from UA.
    const bestDisc = (parsedTR && !parsedTR.blocked && Number.isFinite(parsedTR.discPerc) && parsedTR.discPerc > 0)
      ? parsedTR.discPerc
      : ((parsedUA && !parsedUA.blocked && Number.isFinite(parsedUA.discPerc) && parsedUA.discPerc > 0)
          ? parsedUA.discPerc
          : 0);
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

    // --- RU localization rule (requested by admin):
    // Determine RU (voice/text/none) ONLY from UA region and mirror the same value to TR.
    // This keeps UA as the single source of truth for RU availability (more stable locale data).
    try{
      const uaRu = normalizeRuVal((parsedUA && parsedUA.ru) ? parsedUA.ru : "none");
      if(parsedUA) parsedUA.ru = uaRu;
      if(parsedTR) parsedTR.ru = uaRu;
    }catch(_e){}
// If still no real title - do NOT allow import
    const realTitle = parsedTR && !parsedTR.blocked ? parsedTR.name : null;
    if(!realTitle){
      // TITLE missing is allowed now

    }

    const ok = parsedTR && !parsedTR.blocked;

    res.json({ ok, productId, urls:{ TR: trU, UA: uaU }, status:{ TR: tr.status||null, UA: ua.status||null }, errors:{ TR: tr.error||null, UA: ua.error||null }, parsed:{ TR: parsedTR, UA: parsedUA }});
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
app.listen(PORT, () => console.log("PlayStore95 running on http://localhost:" + PORT));
console.log("PlayStore95 build: DATE_PERSIST_LOCALSTORAGE_RUFORMAT_CJS5 2025-12-22");

//test
