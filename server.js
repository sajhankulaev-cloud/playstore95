const fs = require("fs");
const https = require("https");
const path = require("path");
const express = require("express");

const app = express();

// --- FIX: node18-safe JSON fetch + Chihiro fallback for cover & prices ---


function extractTitleFromHtml(html){
  if(!html || typeof html !== "string") return null;
  // og:title
  let m = html.match(/property=["']og:title["']\s+content=["']([^"']+)["']/i);
  if(m && m[1]) return decodeHtml(m[1]).trim();
  // twitter:title
  m = html.match(/name=["']twitter:title["']\s+content=["']([^"']+)["']/i);
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

async function fetchChihiroTitle(productId, region){
  // region: "TR" or "UA"
  const country = region === "UA" ? "UA" : "TR";
  const lang = region === "UA" ? "ru" : "en";
  const tries = [
    { age: "999" },
    { age: "19" }
  ];
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
    }catch(e){}
  }
  return null;
}
function extractOg(html, prop){
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i");
  const m = html.match(re);
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

    const makeUrl = (locale) => productId ? `https://store.playstation.com/${locale}/product/${productId}` : url;
    const trLocale = inputLocale || TR_LOCALE;
    const uaLocale = UA_LOCALE;

    const trU = makeUrl(trLocale);
    const uaU = makeUrl(uaLocale);

    const { chromium } = require("playwright");

    async function fetchHtml(u, page){
      let status = 0;
      try{
        const resp = await page.goto(u, { waitUntil:"domcontentloaded", timeout: 90000 });
        status = resp ? resp.status() : 0;
        // иногда нужно чуть подождать и прокрутить, чтобы догрузились данные
        await page.waitForTimeout(1800);
        const html = await page.content();
                const ruInfo = await extractRuInfoFromPage(page);
return { status, html, ruInfo };
      }catch(e){
        return { status, html:"", ruInfo:{ru:"none",ruVoice:false,ruText:false}, error:String(e?.message||e) };
      }
    }

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      viewport: { width: 1280, height: 720 }
    });
    const pageTR = await context.newPage();
    const pageUA = await context.newPage();

    // 3 попытки (часть игр иногда отдаёт пусто/блок)
    let tr = {status:0, html:""}, ua = {status:0, html:""};
    for(let attempt=1; attempt<=3; attempt++){
      tr = await fetchHtml(trU, pageTR);
      ua = await fetchHtml(uaU, pageUA);
      const trBlocked = !tr.html || looksBlocked(tr.html);
      const uaBlocked = !ua.html || looksBlocked(ua.html);
      if(!trBlocked && !uaBlocked) break;
      await new Promise(r=>setTimeout(r, 800*attempt));
    }

    await pageTR.close(); await pageUA.close();
    await context.close(); await browser.close();

    function parse(html){
      if(!html || looksBlocked(html)) return { blocked:true };
      const jsonLd = extractJsonLd(html);
      const h1 = extractH1(html) || extractTitle(html);
      const nameRaw0 = extractOg(html, "og:title") || extractOg(html, "twitter:title") || h1;
      const nameRaw = (nameRaw0 && looksBlocked(nameRaw0)) ? null : nameRaw0;
      let coverRaw = extractOg(html, "og:image") || extractOg(html, "twitter:image") || extractAnyImage(jsonLd);
      if(!coverRaw){
        coverRaw = extractImgByAlt(html, h1) || extractFirstHeroImage(html);
      }
      const offer = extractOfferPrice(jsonLd);
      const name = nameRaw ? String(nameRaw).replace(/\s+/g," ").trim() : null;
      const cover = coverRaw ? String(coverRaw).trim() : null;
      const discPerc = extractDiscountPercent(html);
      const edition = extractEdition(jsonLd, nameRaw0, html);
const until = null; // дату не тянем со Store
      return { blocked:false, name, edition, cover, salePrice: (offer && Number.isFinite(offer.price) ? offer.price : null), currency: offer ? offer.currency : null, discPerc: discPerc || 0, discountedUntil: until || null };
    }

    const parsedTR = parse(tr.html);
    if(tr.ruInfo && tr.ruInfo.ru) parsedTR.ru = tr.ruInfo.ru;
    if(tr.ruInfo && tr.ruInfo.sub) parsedTR.sub = tr.ruInfo.sub;
    // If game is in any subscription, edition is always Standard Edition
    if(parsedTR.sub) parsedTR.edition = "Standard Edition";

    const parsedUA = parse(ua.html);
    if(ua.ruInfo && ua.ruInfo.ru) parsedUA.ru = ua.ruInfo.ru;
    

    // Copy discount percent TR -> UA
    if(parsedTR && !parsedTR.blocked && parsedTR.discPerc != null){
      parsedUA.discPerc = parsedTR.discPerc;
    }

    // Ensure REAL title: if TR title missing/blocked, try chihiro API by productId (only for /product/)
    if((!parsedTR.name || looksBlocked(parsedTR.name)) && productId){
      const t = await fetchChihiroTitle(productId, "TR");
      if(t) parsedTR.name = t;
    }
    if((!parsedUA.name || looksBlocked(parsedUA.name)) && productId){
      const t = await fetchChihiroTitle(productId, "UA");
      if(t) parsedUA.name = t;
    }

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

app.post("/api/admin/games/add", requireAdmin, (req, res) => {
  try{
    const g = req.body || {};
    const store = readStore();
    const defUntil = store?.settings?.defaultDiscountUntil || null;
    if(!g.discountedUntil && defUntil) g.discountedUntil = defUntil;

    if(!g.id || !g.name) return res.status(400).json({ ok:false, error:"id_and_name_required" });
    const doc = readJson(GAMES_PATH, { updatedAt:null, items:[] });
    const items = Array.isArray(doc.items) ? doc.items : [];
    if(items.find(x=>x.id===g.id)) return res.status(409).json({ ok:false, error:"already_exists" });

    const next = {
      id: String(g.id),
      name: String(g.name),
      cover: g.cover ? String(g.cover) : null,
      platform: g.platform ? String(g.platform) : "PS4 / PS5",
      edition: g.edition ? String(g.edition) : null,

      popRank: items.length + 1,
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
items.push(next);
    writeJson(GAMES_PATH, { updatedAt: new Date().toISOString(), items });
    res.json({ ok:true, count: items.length });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});

app.get("/ps95_manage", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.use("/", express.static(path.join(__dirname, "public")));

const PORT = Number(process.env.PORT || ENV.PORT || 3000);
app.listen(PORT, () => console.log("PlayStore95 running on http://localhost:" + PORT));
console.log("PlayStore95 build: DATE_PERSIST_LOCALSTORAGE_RUFORMAT_CJS5 2025-12-22");
