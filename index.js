   1 | // ====================================================================
   2 | // 🌐 PURE UNIVERSAL WEB & ARTICLE SCRAPER API (RENDER & RAPIDAPI)
   3 | // 🎯 DƏRİN <HEAD>, META VƏ JSON-LD ÇIXARIŞI İLƏ TAM TƏMİZLƏNMİŞ VERSİYA
   4 | // ====================================================================
   5 | 
   6 | require('dotenv').config();
   7 | 
   8 | const express = require('express');
   9 | const cors = require('cors'); // 👈 1. Bunu əlavə et;
  10 | const axios = require('axios');
  11 | const puppeteer = require('puppeteer-extra');
  12 | const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  13 | puppeteer.use(StealthPlugin());
  14 | const chromium = require('@sparticuz/chromium');
  15 | 
  16 | const app = express();
  17 | 
  18 | app.use(cors()); // 👈 2. Bütün origin-lərə icazə vermək üçün aktivləşdir;
  19 | app.use(express.json());
  20 | app.use(express.urlencoded({ extended: true }));
  21 | 
  22 | // 🛡️ Sığorta Middleware: Content-Type yazılmasa belə body-ni təhlükəsiz oxuyur
  23 | app.use((req, res, next) => {
  24 |     if (req.body && Object.keys(req.body).length > 0) return next();
  25 | 
  26 |     let data = '';
  27 |     let finished = false;
  28 | 
  29 |     req.on('data', chunk => { data += chunk; });
  30 |     req.on('end', () => {
  31 |         if (finished) return;
  32 |         finished = true;
  33 |         if (data) {
  34 |             try {
  35 |                 req.body = JSON.parse(data);
  36 |             } catch (e) {
  37 |                 req.body = { url: data.trim() };
  38 |             }
  39 |         } else {
  40 |             req.body = {};
  41 |         }
  42 |         next();
  43 |     });
  44 | 
  45 |     // ⚡ 2 saniyə ərzində 'end' gəlməzsə, asılı qalmanın qarşısını al
  46 |     setTimeout(() => {
  47 |         if (!finished) {
  48 |             finished = true;
  49 |             if (data && !req.body) {
  50 |                 try {
  51 |                     req.body = JSON.parse(data);
  52 |                 } catch (e) {
  53 |                     req.body = { url: data.trim() };
  54 |                 }
  55 |             } else if (!req.body) {
  56 |                 req.body = {};
  57 |             }
  58 |             next();
  59 |         }
  60 |     }, 2000);
  61 | });
  62 | 
  63 | // --------------------------------------------------------------------
  64 | // 🏥 HEALTH CHECK ENDPOINT (Həm GET, həm də POST qəbul edir)
  65 | // --------------------------------------------------------------------
  66 | app.all(['/health', '/healrh'], (req, res) => {
  67 |     return res.status(200).json({
  68 |         status: "ok",
  69 |         message: "Server aktivdir və problemsiz işləyir.",
  70 |         uptime_seconds: Math.floor(process.uptime()),
  71 |         timestamp: new Date().toISOString();
  72 |     });
  73 | });
  74 | 
  75 | // --------------------------------------------------------------------
  76 | // 🔑 TƏHLÜKƏSİZLİK VƏ PLAN TƏNZİMLƏMƏLƏRİ (RAPIDAPI ADLARINA UYĞUNLAŞDIRILDI)
  77 | // --------------------------------------------------------------------
  78 | const ALLOWED_URL_SCHEMES = ['http:', 'https:'];
  79 | const BLOCKED_HOSTS_EXACT = ['localhost', '0.0.0.0']; 
  80 | const PRIVATE_IP_RANGES = [;
  81 |     { start: '127.0.0.0', end: '127.255.255.255' },
  82 |     { start: '10.0.0.0', end: '10.255.255.255' },
  83 |     { start: '172.16.0.0', end: '172.31.255.255' },
  84 |     { start: '192.168.0.0', end: '192.168.255.255' },
  85 |     { start: '169.254.0.0', end: '169.254.255.255' }
  86 | ];
  87 | 
  88 | const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
  89 | 
  90 | // RapidAPI plan adları: basic, pro, ultra, mega
  91 | const PLAN_CONTENT_LIMITS = {
  92 |     contentLimit:   { basic: 1000, pro: 5000, ultra: null, mega: null },
  93 |     paragraphLimit: { basic: 10,   pro: 30,   ultra: null,   mega: null },
  94 |     imageLimit:     { basic: 10,   pro: 30,   ultra: null,   mega: null },
  95 |     linkLimit:      { basic: 10,   pro: 30,   ultra: null,   mega: null }
  96 | };
  97 | 
  98 | const PLAN_ACCESS = { basic: 1, pro: 2, ultra: 3, mega: 4 };
  99 | 
 100 | function ipToLong(ip) {
 101 |     const parts = ip.split('.');
 102 |     if (parts.length !== 4) return 0;
 103 |     return parts.reduce((acc, part) => (acc * 256) + parseInt(part, 10), 0);
 104 | }
 105 | 
 106 | function isPrivateOrBlockedIP(input) {
 107 |     try {
 108 |         let hostname = input;
 109 |         if (input && input.includes('://')) {
 110 |             hostname = new URL(input).hostname;
 111 |         }
 112 |         if (!hostname) return true;
 113 | 
 114 |         const lower = hostname.toLowerCase();
 115 |         if (BLOCKED_HOSTS_EXACT.includes(lower)) return true;
 116 | 
 117 |         const isIp = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
 118 |         if (isIp) {
 119 |             const ipLong = ipToLong(hostname);
 120 |             for (const range of PRIVATE_IP_RANGES) {
 121 |                 if (ipLong >= ipToLong(range.start) && ipLong <= ipToLong(range.end)) return true;
 122 |             }
 123 |             return false;
 124 |         }
 125 | 
 126 |         if (lower === '[::1]' || lower === '::1') return true;
 127 |         return false;
 128 |     } catch {
 129 |         return true;
 130 |     }
 131 | }
 132 | 
 133 | function cleanText(text) {
 134 |     if (!text || typeof text !== 'string') return text;
 135 |     return text;
 136 |         .replace(/\[\d+\]/g, '');
 137 |         .replace(/\[[a-zA-Z]\]/g, '');
 138 |         .replace(/[\u200E\u200F\u200B\uFEFF]/g, '');
 139 |         .replace(/\s+/g, ' ');
 140 |         .trim();
 141 | }
 142 | 
 143 | // ⚡ Qısa linkləri əsl URL-ə çevirir
 144 | async function resolveShortUrl(targetUrl) {
 145 |     try {
 146 |         const u = new URL(targetUrl);
 147 |         const shortHosts = ['pin.it', 'bit.ly', 't.co', 'tinyurl.com', 'is.gd', 'buff.ly', 'ow.ly'];
 148 |         if (shortHosts.includes(u.hostname.toLowerCase())) {
 149 |             const redirect = await axios.get(targetUrl, {
 150 |                 maxRedirects: 5,
 151 |                 timeout: 5000,
 152 |                 validateStatus: (s) => s >= 200 && s < 400,
 153 |                 headers: { 'User-Agent': USER_AGENT }
 154 |             });
 155 |             return redirect.request?.res?.responseUrl || redirect.headers?.location || targetUrl;
 156 |         }
 157 |     } catch {}
 158 |     return targetUrl;
 159 | }
 160 | 
 161 | // 📰 Responsiv Məqalə Embed Kartı
 162 | function generateArticleEmbedHtml(title, description, thumbnail, url, siteName) {
 163 |     const hasThumb = thumbnail && !thumbnail.includes('placeholder') && !thumbnail.includes('No+Thumbnail');
 164 |     return `<div class="web-article-embed" style="max-width:560px;margin:12px 0;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#ffffff;box-shadow:0 2px 8px rgba(0,0,0,0.06);"><a href="${url}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;color:inherit;display:block;">${hasThumb ? `<div style="width:100%;max-height:280px;overflow:hidden;background:#f8fafc;"><img src="${thumbnail}" alt="${title}" style="width:100%;height:auto;display:block;object-fit:cover;" /></div>` : ''}<div style="padding:16px;"><div style="font-size:11px;color:#64748b;text-transform:uppercase;font-weight:700;letter-spacing:0.5px;margin-bottom:6px;">${siteName || 'Veb Məqalə'}</div><h3 style="margin:0 0 8px 0;font-size:17px;font-weight:700;color:#0f172a;line-height:1.35;">${title}</h3><p style="margin:0;font-size:13px;color:#475569;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${description}</p></div></a></div>`;
 165 | }
 166 | 
 167 | function normalizeEmbedUrl(rawUrl) {
 168 |     const clean = String(rawUrl || '').replace(/\\/g, '/').trim();
 169 |     if (!clean || /^(blob:|javascript:|data:)/i.test(clean)) return '';
 170 |     try {
 171 |         const u = new URL(clean);
 172 |         const host = u.hostname.toLowerCase();
 173 |         if (host.includes('youtu.be')) {
 174 |             const vid = u.pathname.replace(/^\/+/, '').split('/')[0];
 175 |             if (vid) return `https://www.youtube.com/embed/${vid}`;
 176 |         }
 177 |         if (host.includes('youtube.com') && u.pathname === '/watch') {
 178 |             const vid = u.searchParams.get('v');
 179 |             if (vid) return `https://www.youtube.com/embed/${vid}`;
 180 |         }
 181 |         return u.href;
 182 |     } catch {
 183 |         return clean;
 184 |     }
 185 | }
 186 | 
 187 | function escapeHtmlAttr(str) {
 188 |     return String(str || '');
 189 |         .replace(/&/g, '&amp;');
 190 |         .replace(/"/g, '&quot;');
 191 |         .replace(/</g, '&lt;');
 192 |         .replace(/>/g, '&gt;');
 193 | }
 194 | 
 195 | function buildVideoEmbeds(videoSources = [], limit = 10) {
 196 |     if (!Array.isArray(videoSources) || videoSources.length === 0) {
 197 |         return { combinedHtml: '', items: [] };
 198 |     }
 199 | 
 200 |     const items = [];
 201 |     for (const rawUrl of videoSources) {
 202 |         if (items.length >= limit) break;
 203 |         const normalizedUrl = normalizeEmbedUrl(rawUrl);
 204 |         if (!normalizedUrl) continue;
 205 | 
 206 |         const safeUrl = escapeHtmlAttr(normalizedUrl);
 207 |         const isDirectMp4 = /\.mp4(\?.*)?$/i.test(normalizedUrl);
 208 |         const isHlsStream = /\.m3u8(\?.*)?$/i.test(normalizedUrl);
 209 |         const type = isDirectMp4 ? 'mp4' : isHlsStream ? 'hls' : 'iframe';
 210 |         const index = items.length;
 211 | 
 212 |         let html = '';
 213 |         if (isDirectMp4) {
 214 |             html = `<div class="web-video-embed" data-video-index="${index}" style="max-width:560px;margin:12px 0;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);"><video controls preload="metadata" src="${safeUrl}" style="width:100%;height:auto;display:block;background:#000;"></video></div>`;
 215 |         } else if (isHlsStream) {
 216 |             html = `<div class="web-video-embed" data-video-index="${index}" style="max-width:560px;margin:12px 0;padding:12px 14px;border:1px solid #e2e8f0;border-radius:12px;background:#0f172a;color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;"><div style="font-weight:600;margin-bottom:6px;">HLS Video Axını (.m3u8)</div><a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="color:#38bdf8;word-break:break-all;">${safeUrl}</a></div>`;
 217 |         } else {
 218 |             html = `<div class="web-video-embed" data-video-index="${index}" style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:12px;margin:12px 0;background:#000;"><iframe src="${safeUrl}" style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;" allowfullscreen loading="lazy"></iframe></div>`;
 219 |         }
 220 | 
 221 |         items.push({ index: index + 1, url: normalizedUrl, type, html });
 222 |     }
 223 | 
 224 |     return {
 225 |         combinedHtml: items.map(item => item.html).join('\n'),
 226 |         items;
 227 |     };
 228 | }
 229 | 
 230 | // --------------------------------------------------------------------
 231 | // 🌐 ƏSAS MƏQALƏ, HEAD VƏ METADATA ÇIXARIŞI (PUPPETEER)
 232 | // --------------------------------------------------------------------
 233 | async function scrapeUniversalWeb(targetUrl, plan = "basic") {
 234 |     let browser = null;
 235 |     try {
 236 |         browser = await puppeteer.launch({
 237 |             args: [;
 238 |                 ...chromium.args,
 239 |                '--no-sandbox',
 240 |                '--disable-setuid-sandbox',
 241 |                '--disable-dev-shm-usage',
 242 |                '--disable-gpu',
 243 |                '--single-process',
 244 |                '--no-zygote',
 245 |                '--disable-blink-features=AutomationControlled', // 👈 Bot deteksiyasını söndürür;
 246 |                '--disable-infobars',
 247 |                '--window-size=1920,1080',
 248 |                '--start-maximized',
 249 |                '--hide-scrollbars',
 250 |                '--disable-web-security',
 251 |                '--lang=az-AZ,az;q=0.9,en-US;q=0.8,en;q=0.7', // 👈 Dil uyğunluğu;
 252 |                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
 253 |             ],
 254 |             defaultViewport: { width: 1280, height: 800 },
 255 |             executablePath: await chromium.executablePath(),
 256 |             headless: chromium.headless,
 257 |             ignoreHTTPSErrors: true;
 258 |         });
 259 | 
 260 |         const page = await browser.newPage();
 261 |         await page.setUserAgent(USER_AGENT);
 262 |         await page.setExtraHTTPHeaders({
 263 |             'Accept-Language': 'az,tr,en-US,en;q=0.9',
 264 |             'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
 265 |         });
 266 | 
 267 |         // 🛡️ Render 512MB RAM mühafizəsi
 268 |         await page.setRequestInterception(true);
 269 |         page.on('request', (req) => {
 270 |              const resource = req.resourceType();
 271 |              const reqUrl = req.url().toLowerCase();
 272 |              const isAdUrl = ['ads2.imv.az', 'doubleclick', 'googlesyndication', '/banner', '/banners/', '/ads/', 'catfish'].some(k => reqUrl.includes(k));
 273 |              if (isAdUrl || ['image', 'media', 'font', 'stylesheet'].includes(resource)) {
 274 |                  req.abort();
 275 |              } else {
 276 |                  req.continue();
 277 |              }
 278 |          });
 279 | 
 280 |         await page.goto(targetUrl, {
 281 |             waitUntil: 'domcontentloaded',
 282 |             timeout: 15000;
 283 |         });
 284 | 
 285 |         const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
 286 | 
 287 |         // Qısa ilkin gözləmə (JS və DOM-un oturması üçün)
 288 |         const quickDelay = Math.floor(Math.random() * 500) + 700; // 0.7 - 1.2 san;
 289 |         await delay(quickDelay);
 290 | 
 291 |         // Cloudflare challenge düşübsə, yalnız o halda bir qədər də gözlə
 292 |         const isChallenge = await page.evaluate(() => {
 293 |             const t = (document.title || '').toLowerCase();
 294 |             const b = (document.body?.innerText || '').toLowerCase();
 295 |             return (;
 296 |                 t.includes('just a moment') ||;
 297 |                 t.includes('bir dakika lütfen') ||;
 298 |                 t.includes('attention required') ||;
 299 |                 b.includes('checking your browser') ||;
 300 |                 b.includes('kötü niyetli botlara karşı');
 301 |             );
 302 |         });
 303 | 
 304 |         if (isChallenge) {
 305 |             await delay(3500);
 306 |         }
 307 | 
 308 |         // Qısa scroll və mouse hərəkəti
 309 |         await page.evaluate(() => {
 310 |             window.scrollBy(0, Math.floor(Math.random() * 250) + 100);
 311 |             window.dispatchEvent(new MouseEvent('mousemove', {
 312 |                 bubbles: true,
 313 |                 clientX: Math.floor(Math.random() * 400) + 100,
 314 |                 clientY: Math.floor(Math.random() * 300) + 100;
 315 |             }));
 316 |         });
 317 | 
 318 |         await delay(300);
 319 |         
 320 |         const extracted = await page.evaluate((pageUrl) => {
 321 |             const out = {
 322 |                 head: {
 323 |                     title: '',
 324 |                     description: '',
 325 |                     site_name: '',
 326 |                     canonical: '',
 327 |                     favicon: '',
 328 |                     author: '',
 329 |                     keywords: '',
 330 |                     language: document.documentElement.lang || '',
 331 |                     charset: document.characterSet || 'UTF-8',
 332 |                     open_graph: {},
 333 |                     twitter: {},
 334 |                     all_meta: {},
 335 |                     json_ld: [];
 336 |                 },
 337 |                 body: {
 338 |                     h1: '',
 339 |                     paragraphs: [],
 340 |                     images: [],
 341 |                     links: [],
 342 |                     videoSources: [];
 343 |                 }
 344 |             };
 345 | 
 346 |             const titleEl = document.querySelector('title');
 347 |             if (titleEl && titleEl.innerText) {
 348 |                 out.head.title = titleEl.innerText.trim();
 349 |             }
 350 | 
 351 |             document.querySelectorAll('meta').forEach(meta => {
 352 |     const name = (meta.getAttribute('name') || meta.getAttribute('property') || meta.getAttribute('http-equiv') || meta.getAttribute('itemprop') || '').trim();
 353 |     const content = (meta.getAttribute('content') || meta.getAttribute('value') || '').trim();
 354 | 
 355 |     if (!name || !content) return;
 356 | 
 357 |     const lowerName = name.toLowerCase();
 358 |     const cleanContent = lowerName.includes('image') || lowerName.includes('url');
 359 |         ? content.replace(/\\/g, '/');
 360 |         : content;
 361 | 
 362 |     if (!lowerName.includes('csrf') && !lowerName.includes('xsrf')) {
 363 |         out.head.all_meta[name] = cleanContent;
 364 |     }
 365 | 
 366 |     if (lowerName.startsWith('og:')) {
 367 |         out.head.open_graph[lowerName.replace(/^og:/, '')] = cleanContent;
 368 |     }
 369 |     if (lowerName.startsWith('twitter:')) {
 370 |         out.head.twitter[lowerName.replace(/^twitter:/, '')] = cleanContent;
 371 |     }
 372 |     if (['description', 'og:description', 'twitter:description'].includes(lowerName) && !out.head.description) {
 373 |         out.head.description = cleanContent;
 374 |     }
 375 |     if (['og:site_name', 'application-name', 'publisher'].includes(lowerName) && !out.head.site_name) {
 376 |         out.head.site_name = cleanContent;
 377 |     }
 378 |     if (['author', 'article:author', 'twitter:creator'].includes(lowerName) && !out.head.author) {
 379 |         out.head.author = cleanContent;
 380 |     }
 381 |     if (lowerName === 'keywords' && !out.head.keywords) {
 382 |         out.head.keywords = cleanContent;
 383 |     }
 384 | });
 385 | 
 386 |             const canonicalEl = document.querySelector('link[rel="canonical"]');
 387 |             if (canonicalEl && canonicalEl.getAttribute('href')) {
 388 |                 out.head.canonical = canonicalEl.getAttribute('href');
 389 |             } else if (out.head.open_graph.url) {
 390 |                 out.head.canonical = out.head.open_graph.url;
 391 |             }
 392 | 
 393 |             const iconEl = document.querySelector('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]');
 394 |             if (iconEl && iconEl.getAttribute('href')) {
 395 |                 try {
 396 |                     out.head.favicon = new URL(iconEl.getAttribute('href'), pageUrl).href;
 397 |                 } catch {
 398 |                     out.head.favicon = iconEl.getAttribute('href');
 399 |                 }
 400 |             } else {
 401 |                 try {
 402 |                     const u = new URL(pageUrl);
 403 |                     out.head.favicon = `${u.origin}/favicon.ico`;
 404 |                 } catch {}
 405 |             }
 406 | 
 407 |             document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
 408 |                 try {
 409 |                     const raw = script.innerText.trim();
 410 |                     if (raw) {
 411 |                         const parsed = JSON.parse(raw);
 412 |                         out.head.json_ld.push(parsed);
 413 |                         if (!out.head.title && parsed.headline) out.head.title = parsed.headline;
 414 |                         if (!out.head.description && parsed.description) out.head.description = parsed.description;
 415 |                     }
 416 |                 } catch {}
 417 |             });
 418 | 
 419 |             if (!out.head.title) {
 420 |                 out.head.title = out.head.open_graph.title || out.head.twitter.title || '';
 421 |             }
 422 | 
 423 |             const h1El = document.querySelector('h1');
 424 |             if (h1El) out.body.h1 = h1El.innerText.trim();
 425 |             if (!out.head.title && out.body.h1) out.head.title = out.body.h1;
 426 | 
 427 |             const contentSelectors = [;
 428 |                 '[itemprop="articleBody"]',
 429 |                 '.article-body',
 430 |                 '.article_body',
 431 |                 '.news-text',
 432 |                 '.news_text',
 433 |                 '.news-inner',
 434 |                 '.news-content',
 435 |                 '.post-content',
 436 |                 '.article-content',
 437 |                 '.entry-content',
 438 |                 '.single-content',
 439 |                 '.content-text',
 440 |                 'main',
 441 |                 '[role="main"]',
 442 |                 'article';
 443 |             ];
 444 | 
 445 |             let contentContainer = null;
 446 |             let bestTextLength = 0;
 447 | 
 448 |             for (const selector of contentSelectors) {
 449 |                 const elements = document.querySelectorAll(selector);
 450 |                 elements.forEach(el => {
 451 |                     const txtLen = (el.innerText || '').trim().length;
 452 |                     if (txtLen > bestTextLength && txtLen >= 150) {
 453 |                         bestTextLength = txtLen;
 454 |                         contentContainer = el;
 455 |                     }
 456 |                 });
 457 |                 if (contentContainer && bestTextLength >= 250 && !['main', '[role="main"]', 'article'].includes(selector)) {
 458 |                     break;
 459 |                 }
 460 |             }
 461 | 
 462 |             contentContainer = contentContainer || document.body;
 463 | 
 464 |             if (contentContainer) {
 465 |                 const clone = contentContainer.cloneNode(true);
 466 | 
 467 |                 const removeSelectors = [;
 468 |                     'script', 'style', 'nav', 'header', 'footer', 'form', 'aside',
 469 |                     '.sidebar', '.related-news', '.widgets', '.banner', '.ads',
 470 |                     '.advertisement', '.social-share', '.tags', '.author-box',
 471 |                     '.read-more', '.other-news', '.news-box', 'figure',
 472 |                     '[class*="related"]', '[class*="share"]', '[class*="social"]',
 473 |                     '[class*="banner"]', '[class*="advert"]', '.poll', '.polls';
 474 |                 ];
 475 |                 clone.querySelectorAll(removeSelectors.join(', ')).forEach(el => el.remove());
 476 | 
 477 |                 const excludedSelector = 'header, nav, footer, aside, [role="navigation"], [aria-hidden="true"]';
 478 |                 const seenTexts = new Set();
 479 | 
 480 |                 function pushCleanText(rawValue, minLength = 25) {
 481 |                     const txt = (rawValue || '').replace(/\s+/g, ' ').trim();
 482 |                     if (!txt || txt.length < minLength) return;
 483 | 
 484 |                     if (/^(keçid|daha ətraflı|read more|login)$/i.test(txt)) return;
 485 | 
 486 |                     const upperTxt = txt.toUpperCase();
 487 |                     const lowerTxt = txt.toLowerCase();
 488 | 
 489 |                     const isJunk =;
 490 |                         upperTxt.includes('ƏMƏLİYYAT İCRA OLUNUR') ||;
 491 |                         lowerTxt.includes('hörmətli istifadəçi') ||;
 492 |                         lowerTxt.includes('ödənişli') ||;
 493 |                         lowerTxt.includes('qeydiyyatdan keçin') ||;
 494 |                         lowerTxt.includes('t.me/') ||;
 495 |                         lowerTxt.includes('instagram.com') ||;
 496 |                         lowerTxt.includes('bizi') ||;
 497 |                         lowerTxt.includes('izləyin');
 498 | 
 499 |                     if (isJunk || seenTexts.has(txt)) return;
 500 | 
 501 |                     seenTexts.add(txt);
 502 |                     out.body.paragraphs.push(txt);
 503 |                 }
 504 | 
 505 |                 // 1. Başlıqları, abzasları, sitatları və siyahı elementlərini topla
 506 |                 clone.querySelectorAll('h1, h2, h3, p, li, blockquote').forEach(node => {
 507 |                     if (node.closest(excludedSelector)) return;
 508 |                     const isHeading = /^H[1-3]$/.test(node.tagName);
 509 |                     pushCleanText(node.innerText, isHeading ? 8 : 30);
 510 |                 });
 511 | 
 512 |                 // 2. Əgər mətn <p> əvəzinə <br> / <div> ilə bölünübsə
 513 |                 if (out.body.paragraphs.length < 2) {
 514 |                     const htmlChunks = clone.innerHTML;
 515 |                         .replace(/<br\s*\/?>/gi, '\n');
 516 |                         .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, '\n');
 517 |                     const tempDiv = document.createElement('div');
 518 |                     tempDiv.innerHTML = htmlChunks;
 519 |                     const lines = (tempDiv.innerText || tempDiv.textContent || '').split('\n');
 520 |                     lines.forEach(line => pushCleanText(line, 30));
 521 |                 }
 522 | 
 523 |                 // 3. Yalnız abzas tapılmadıqda keçid başlıqlarını topla
 524 |                 if (out.body.paragraphs.length === 0) {
 525 |                     const headlineSelectors = [;
 526 |                         'a[href*="/xeber/"]',
 527 |                         '.titleline > a',
 528 |                         'article h1 a',
 529 |                         'article h2 a',
 530 |                         'article h3 a',
 531 |                         '.news-item a[href]',
 532 |                         '.article-item a[href]',
 533 |                         '.post-item a[href]',
 534 |                         '.story a[href]',
 535 |                         '.card a[href]';
 536 |                     ].join(',');
 537 | 
 538 |                     clone.querySelectorAll(headlineSelectors).forEach(link => {
 539 |                         if (link.closest(excludedSelector)) return;
 540 |                         pushCleanText(link.innerText, 8);
 541 |                     });
 542 |                 }
 543 |             }
 544 |             
 545 |             if (!out.head.description && out.body.paragraphs.length > 0) {
 546 |                 out.head.description = out.body.paragraphs[0];
 547 |             }
 548 | 
 549 |             const seenImages = new Set();
 550 | 
 551 |             const adOrUiSelector = [;
 552 |                 'header', 'nav', 'footer', 'aside',
 553 |                 '[class*="banner"]', '[id*="banner"]',
 554 |                 '[class*="advert"]', '[id*="advert"]',
 555 |                 '[class*="sponsor"]', '[id*="sponsor"]',
 556 |                 '[class*="social"]', '[class*="share"]',
 557 |                 '[class*="sidebar"]', '[class*="related"]',
 558 |                 '.ads', '.ad', '.ad-box', '.ad-wrapper', 'ins.adsbygoogle';
 559 |             ].join(',');
 560 | 
 561 |             const isJunkImageUrl = (urlStr) => {
 562 |                 const lower = (urlStr || '').toLowerCase();
 563 |                 return [;
 564 |                     'tracker', 'pixel', '.svg', 'placeholder', 'no+thumbnail',
 565 |                     '/adv/', '/ads/', '/ad/', 'banner', 'banners', 'sponsor',
 566 |                     'doubleclick', 'googlesyndication', 'catfish',
 567 |                     'social2/', '/social/', 'vote_b.gif', 'dloader.gif',
 568 |                     'loader.gif', 'spinner', 'favicon', 'sprite', '/icon', 'icons/';
 569 |                 ].some(k => lower.includes(k));
 570 |             };
 571 | 
 572 |             const isAdOrUiImage = (imgEl) => {
 573 |                 if (!imgEl) return false;
 574 | 
 575 |                 if (typeof imgEl.matches === 'function' && imgEl.matches(adOrUiSelector)) {
 576 |                     return true;
 577 |                 }
 578 | 
 579 |                 if (typeof imgEl.closest === 'function' && imgEl.closest(adOrUiSelector)) {
 580 |                     return true;
 581 |                 }
 582 | 
 583 |                 const w = parseInt(imgEl.getAttribute('width'), 10);
 584 |                 const h = parseInt(imgEl.getAttribute('height'), 10);
 585 |                 if ((!isNaN(w) && w > 0 && w <= 60) || (!isNaN(h) && h > 0 && h <= 60)) {
 586 |                     return true;
 587 |                 }
 588 | 
 589 |                 return false;
 590 |             };
 591 | 
 592 |             const extractImgSrc = (imgEl) => {
 593 |                 const direct =;
 594 |                     imgEl.getAttribute('src') ||;
 595 |                     imgEl.getAttribute('data-src') ||;
 596 |                     imgEl.getAttribute('data-lazy-src') ||;
 597 |                     imgEl.getAttribute('data-original');
 598 | 
 599 |                 if (direct) return direct.trim();
 600 | 
 601 |                 const srcset = imgEl.getAttribute('srcset') || imgEl.getAttribute('data-srcset');
 602 |                 if (srcset) {
 603 |                     const firstCandidate = srcset.split(',')[0]?.trim().split(/\s+/)[0];
 604 |                     if (firstCandidate) return firstCandidate;
 605 |                 }
 606 | 
 607 |                 return '';
 608 |             };
 609 | 
 610 |             const addImageFromEl = (imgEl) => {
 611 |                 if (isAdOrUiImage(imgEl)) return;
 612 |                 const src = extractImgSrc(imgEl);
 613 |                 if (!src || src.startsWith('data:image/')) return;
 614 |                 try {
 615 |                     const abs = new URL(src, pageUrl).href;
 616 |                     if (!isJunkImageUrl(abs) && !seenImages.has(abs)) {
 617 |                         seenImages.add(abs);
 618 |                         out.body.images.push(abs);
 619 |                     }
 620 |                 } catch {}
 621 |             };
 622 | 
 623 |             const pushImageUrl = (rawUrl) => {
 624 |     if (!rawUrl || rawUrl.startsWith('data:image/')) return;
 625 |     try {
 626 |         const abs = new URL(rawUrl, pageUrl).href;
 627 |         if (!isJunkImageUrl(abs) && !seenImages.has(abs)) {
 628 |             seenImages.add(abs);
 629 |             out.body.images.push(abs);
 630 |         }
 631 |     } catch {}
 632 | };
 633 | 
 634 | // 1. Əsas OG / Twitter şəkli
 635 | const ogImg = out.head.open_graph.image || out.head.twitter.image;
 636 | if (ogImg) {
 637 |     pushImageUrl(ogImg);
 638 | }
 639 | 
 640 | // 2. Məqalə konteynerindəki şəkillər
 641 | if (contentContainer && contentContainer !== document.body) {
 642 |     contentContainer.querySelectorAll('img').forEach(addImageFromEl);
 643 | }
 644 | 
 645 | // 3. Heç şəkil tapılmayıbsa, JSON-LD NewsArticle şəkillərinə bax (bütün document-i yığmır)
 646 | if (out.body.images.length === 0 && Array.isArray(out.head.json_ld)) {
 647 |     for (const ld of out.head.json_ld) {
 648 |         if (ld && ld['@type'] === 'NewsArticle' && ld.image) {
 649 |             const imgs = Array.isArray(ld.image) ? ld.image : [ld.image];
 650 |             imgs.forEach(pushImageUrl);
 651 |         }
 652 |     }
 653 | }
 654 | 
 655 |             const seenLinks = new Set();
 656 |             document.querySelectorAll('a').forEach(a => {
 657 |                 const href = a.getAttribute('href');
 658 |                 const text = a.innerText.trim();
 659 |                 if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
 660 |                 try {
 661 |                     const abs = new URL(href, pageUrl).href;
 662 |                     if (!seenLinks.has(abs)) {
 663 |                         seenLinks.add(abs);
 664 |                         out.body.links.push({ text: text || 'Keçid', url: abs });
 665 |                     }
 666 |                 } catch {}
 667 |             });
 668 | 
 669 |             const toAbsoluteVideoUrl = (rawSrc) => {
 670 |                  if (!rawSrc || typeof rawSrc !== 'string') return null;
 671 |                  const trimmed = rawSrc.trim();
 672 |                  if (!trimmed || trimmed.startsWith('blob:') || trimmed.startsWith('javascript:')) {
 673 |                      return null;
 674 |                  }
 675 |                  try {
 676 |                      return new URL(trimmed, pageUrl).href;
 677 |                  } catch {
 678 |                      return trimmed;
 679 |                  }
 680 |              };
 681 | 
 682 |              const isAdVideoUrl = (urlStr) => {
 683 |                   if (!urlStr) return true;
 684 |                   const lower = urlStr.toLowerCase();
 685 |                   return [;
 686 |                       'ads.', 'ad.', '.ads.', 'doubleclick', 'googlesyndication',
 687 |                       '/banner', '/banners/', '/ads/', '/vast', '/preroll',
 688 |                       '/midroll', '/postroll', 'catfish';
 689 |                   ].some((pattern) => lower.includes(pattern));
 690 |               };
 691 | 
 692 |               const isAdElement = (el) => {
 693 |                   if (!el || typeof el.closest !== 'function') return false;
 694 |                   return Boolean(el.closest([;
 695 |                       '[class*="banner"]', '[id*="banner"]',
 696 |                       '[class*="advert"]', '[id*="advert"]',
 697 |                       '[class*="sponsor"]', '[id*="sponsor"]',
 698 |                       '.ads', '.ad-box', '.ad-wrapper', '.video-ad', 'ins.adsbygoogle';
 699 |                   ].join(',')));
 700 |               };
 701 | 
 702 |               const pushUniqueVideo = (rawSrc, sourceEl = null) => {
 703 |                   if (sourceEl && isAdElement(sourceEl)) return;
 704 |                   const fullUrl = toAbsoluteVideoUrl(rawSrc);
 705 |                   if (!fullUrl || isAdVideoUrl(fullUrl)) return;
 706 |                   if (!out.body.videoSources.includes(fullUrl)) {
 707 |                       out.body.videoSources.push(fullUrl);
 708 |                   }
 709 |               };
 710 | 
 711 |              const unwantedIframes = [;
 712 |                  'ct.pinterest.com', 'doubleclick', 'analytics',
 713 |                  'facebook.com/tr', 'clarity.ms', 'unidestin', 'metrix.az';
 714 |              ];
 715 | 
 716 |              document.querySelectorAll('iframe').forEach(iframe => {
 717 |                  const src = iframe.getAttribute('src') || iframe.getAttribute('data-src') || '';
 718 |                  const lowerSrc = src.toLowerCase();
 719 |                  if (src && !unwantedIframes.some(u => lowerSrc.includes(u))) {
 720 |                      if (
 721 |                          lowerSrc.includes('youtube') ||;
 722 |                          lowerSrc.includes('vimeo') ||;
 723 |                          lowerSrc.includes('embed') ||;
 724 |                          lowerSrc.includes('.m3u8') ||;
 725 |                          lowerSrc.includes('.mp4') ||;
 726 |                          lowerSrc.includes('.mpd') ||;
 727 |                          lowerSrc.includes('baku.tv');
 728 |                      ) {
 729 |                          pushUniqueVideo(src, iframe);
 730 |                      }
 731 |                  }
 732 |              });
 733 | 
 734 |              document.querySelectorAll('video, video source').forEach(v => {
 735 |                  const src = v.getAttribute('src') || v.getAttribute('data-src');
 736 |                  pushUniqueVideo(src, v);
 737 |              });
 738 | 
 739 |              // ==========================================
 740 |              // 🌟 GİZLİ VİDEO VƏ AXIN (STREAM) AXTARIŞI
 741 |              // ==========================================
 742 | 
 743 |              // 1. OpenGraph / Twitter Player teqlərindən video yoxla
 744 |              const ogVideo =;
 745 |                  out.head.open_graph.video ||;
 746 |                  out.head.open_graph['video:url'] ||;
 747 |                  out.head.open_graph['video:secure_url'] ||;
 748 |                  out.head.twitter.player;
 749 |              pushUniqueVideo(ogVideo);
 750 | 
 751 |              // 2. JSON-LD (VideoObject) daxilindən video yoxla
 752 |              out.head.json_ld.forEach(item => {
 753 |                  if (item && item['@type'] === 'VideoObject') {
 754 |                      pushUniqueVideo(item.embedUrl || item.contentUrl);
 755 |                  }
 756 |              });
 757 | 
 758 |              // 3. Pleyerlərin gizli data atributlarında .m3u8 / .mpd / .mp4 axınlarını yoxla
 759 |              document.querySelectorAll('[data-src], [data-url], [data-stream], [data-hls]').forEach(el => {
 760 |                  const src =;
 761 |                      el.getAttribute('data-src') ||;
 762 |                      el.getAttribute('data-url') ||;
 763 |                      el.getAttribute('data-stream') ||;
 764 |                      el.getAttribute('data-hls');
 765 |                  if (src && /\.(m3u8|mpd|mp4)(\?|$)/i.test(src)) {
 766 |                      pushUniqueVideo(src, el);
 767 |                  }
 768 |              });
 769 | 
 770 |              // 4. Əgər hələ də tapılmadısa, script teqlərindən stream linkini regex ilə çək
 771 |              if (out.body.videoSources.length === 0) {
 772 |                  document.querySelectorAll('script').forEach(script => {
 773 |                      const text = script.innerText || '';
 774 |                      const match = text.match(/https?:\/\/[^"'\s]+\.(m3u8|mpd|mp4)(?:\?[^"'\s]*)?/i);
 775 |                      if (match && match[0]) {
 776 |                          pushUniqueVideo(match[0]);
 777 |                      }
 778 |                  });
 779 |              }
 780 |              // ==========================================
 781 |             
 782 |             return out;
 783 |         }, targetUrl);
 784 | 
 785 |         await browser.close();
 786 |         browser = null;
 787 | 
 788 |         const pageTitle = extracted.head.title || '';
 789 |         const pageDesc = extracted.head.description || '';
 790 |         
 791 |         if (
 792 |             pageTitle.includes("Bir dakika lütfen") || ;
 793 |             pageTitle.includes("Attention Required") || ;
 794 |             pageDesc.includes("kötü niyetli botlara karşı") ||;
 795 |             pageTitle.includes("Access Denied");
 796 |         ) {
 797 |             return {
 798 |                 success: false,
 799 |                 code: 403,
 800 |                 status: "error",
 801 |                 error: "Target website is protected by Cloudflare or bot verification. Access blocked.",
 802 |                 name: pageTitle,
 803 |                 description: pageDesc,
 804 |                 site_name: new URL(targetUrl).hostname,
 805 |                 is_video: false;
 806 |             };
 807 |         }
 808 | 
 809 |         const limits = {
 810 |             para: PLAN_CONTENT_LIMITS.paragraphLimit[plan] !== undefined ? PLAN_CONTENT_LIMITS.paragraphLimit[plan] : 10,
 811 |             img: PLAN_CONTENT_LIMITS.imageLimit[plan] !== undefined ? PLAN_CONTENT_LIMITS.imageLimit[plan] : 10,
 812 |             link: PLAN_CONTENT_LIMITS.linkLimit[plan] !== undefined ? PLAN_CONTENT_LIMITS.linkLimit[plan] : 10,
 813 |             textLen: PLAN_CONTENT_LIMITS.contentLimit[plan] !== undefined ? PLAN_CONTENT_LIMITS.contentLimit[plan] : 1000;
 814 |         };
 815 | 
 816 |         // 1. Əvvəlcə abzas limitini tətbiq et
 817 |         let finalParagraphs = limits.para === null;
 818 |             ? extracted.body.paragraphs;
 819 |             : extracted.body.paragraphs.slice(0, limits.para);
 820 | 
 821 |         // 2. Mətn yarat
 822 |         let fullText = finalParagraphs.join('\n\n');
 823 | 
 824 |         // 3. Simvol limitini tətbiq et
 825 |         if (limits.textLen !== null && fullText.length > limits.textLen) {
 826 |             fullText = fullText.substring(0, limits.textLen).trimEnd() + '...';
 827 |         }
 828 | 
 829 |         // 4. Abzasları pageContent ilə eyniləşdir
 830 |         finalParagraphs = fullText;
 831 |             ? fullText.split('\n\n');
 832 |             : [];
 833 | 
 834 |         const finalImages = limits.img === null ? extracted.body.images : extracted.body.images.slice(0, limits.img);
 835 |         const finalLinks = limits.link === null ? extracted.body.links : extracted.body.links.slice(0, limits.link);
 836 | 
 837 |         const thumbnail = extracted.head.open_graph.image || extracted.head.twitter.image || (finalImages.length > 0 ? finalImages[0] : null);
 838 |         const finalTitle = cleanText(extracted.head.title || extracted.body.h1 || "Səhifə Başlığı Yoxdur");
 839 |         const finalDescription = cleanText(extracted.head.description || (fullText ? fullText.substring(0, 200) : "Təsvir tapılmadı"));
 840 |         const finalSiteName = extracted.head.site_name || extracted.head.open_graph.site_name || (new URL(targetUrl)).hostname;
 841 | 
 842 |         const finalCanonical = (extracted.head.canonical && extracted.head.canonical !== 'undefined') ;
 843 |             ? extracted.head.canonical ;
 844 |             : targetUrl;
 845 | 
 846 |         const hasVideo = extracted.body.videoSources.length > 0;
 847 |         const videoEmbeds = buildVideoEmbeds(extracted.body.videoSources, 10);
 848 |         let embedHtml = '';
 849 |         if (hasVideo) {
 850 |             embedHtml = videoEmbeds.combinedHtml;
 851 |         } else {
 852 |             embedHtml = generateArticleEmbedHtml(finalTitle, finalDescription, thumbnail, targetUrl, finalSiteName);
 853 |         }
 854 | 
 855 |         return {
 856 |             success: true,
 857 |             code: 200,
 858 |             status: "ok",
 859 |             plan_type: plan,
 860 |             name: finalTitle,
 861 |             description: finalDescription,
 862 |             thumbnail_url: thumbnail,
 863 |             favicon_url: extracted.head.favicon,
 864 |             canonical_url: finalCanonical,
 865 |             author: extracted.head.author || null,
 866 |             site_name: finalSiteName,
 867 |             embed_html: embedHtml,
 868 |             is_video: hasVideo,
 869 |             head: {
 870 |                 title: finalTitle,
 871 |                 description: finalDescription,
 872 |                 site_name: finalSiteName,
 873 |                 canonical_url: finalCanonical,
 874 |                 favicon: extracted.head.favicon,
 875 |                 author: extracted.head.author,
 876 |                 keywords: extracted.head.keywords,
 877 |                 language: extracted.head.language,
 878 |                 charset: extracted.head.charset,
 879 |                 open_graph: extracted.head.open_graph,
 880 |                 twitter: extracted.head.twitter,
 881 |                 json_ld: extracted.head.json_ld,
 882 |                 all_meta_tags: extracted.head.all_meta;
 883 |             },
 884 |             deep_data: {
 885 |                 plan: plan,
 886 |                 error: null,
 887 |                 pageContent: fullText,
 888 |                 paragraphs: finalParagraphs,
 889 |                 images: finalImages,
 890 |                 links: finalLinks,
 891 |                 videoSources: extracted.body.videoSources,
 892 |                 has_video_sources: hasVideo;
 893 |             }
 894 |         };
 895 | 
 896 |     } catch (err) {
 897 |         if (browser) {
 898 |             try { await browser.close(); } catch {}
 899 |         }
 900 |         throw err;
 901 |     }
 902 | }
 903 | 
 904 | // --------------------------------------------------------------------
 905 | // 🚀 ƏSAS API ENDPOINT (HƏM GET, HƏM DƏ POST DƏSTƏKLƏNİR)
 906 | // --------------------------------------------------------------------
 907 | app.all(['/', '/scrape', '/extract'], async (req, res) => {
 908 |     const startTime = Date.now();
 909 | 
 910 |     let targetUrl = req.body?.url || req.query?.url;
 911 |     if (!targetUrl && typeof req.body === 'string') targetUrl = req.body;
 912 | 
 913 |     if (!targetUrl || typeof targetUrl !== 'string') {
 914 |         return res.status(400).json({
 915 |             success: false, 
 916 |             code: 400, 
 917 |             status: "error",
 918 |             error: "Zəhmət olmasa 'url' parametrini daxil edin (məsələn: { \"url\": \"https://example.com\" })";
 919 |         });
 920 |     }
 921 | 
 922 |     targetUrl = targetUrl.trim();
 923 |     if (!/^https?:\/\//i.test(targetUrl)) {
 924 |         targetUrl = 'https://' + targetUrl;
 925 |     }
 926 | 
 927 |     targetUrl = await resolveShortUrl(targetUrl);
 928 |     console.log("Emal olunmuş URL:", targetUrl);
 929 | 
 930 |     let parsed;
 931 |     try {
 932 |         parsed = new URL(targetUrl);
 933 |         if (!ALLOWED_URL_SCHEMES.includes(parsed.protocol)) {
 934 |             return res.status(400).json({ success: false, code: 400, error: "Yalnız HTTP və HTTPS protokolları dəstəklənir." });
 935 |         }
 936 | 
 937 |         if (isPrivateOrBlockedIP(parsed.hostname)) {
 938 |             return res.status(403).json({ success: false, code: 403, error: "Təhlükəsizlik səbəbilə daxili/lokal ünvanlara icazə verilmir." });
 939 |         }
 940 |     } catch (e) {
 941 |         return res.status(400).json({ success: false, code: 400, error: "Etibarsız URL formatı." });
 942 |     }
 943 | 
 944 |     // ====================================================
 945 |     // 🌟 SOSİAL ŞƏBƏKƏLƏRİN BİRBAŞA BLOKLANMASI
 946 |     // ====================================================
 947 |     const BLOCKED_SOCIAL_DOMAINS = [;
 948 |         'youtube.com', 'youtu.be', 
 949 |         'tiktok.com', 
 950 |         'instagram.com', 
 951 |         'facebook.com', 
 952 |         'twitter.com', 'x.com';
 953 |     ];
 954 | 
 955 |     const hostnameLower = parsed.hostname.toLowerCase();
 956 |     const isSocialBlocked = BLOCKED_SOCIAL_DOMAINS.some(domain => hostnameLower.includes(domain));
 957 |     
 958 |     if (isSocialBlocked) {
 959 |         return res.status(400).json({
 960 |             success: false,
 961 |             code: 400,
 962 |             status: "error",
 963 |             error: "Social media platforms (YouTube, TikTok, Instagram, etc.) are not supported by this API. Please use this API for standard web pages and articles.";
 964 |         });
 965 |     }
 966 |     // ====================================================
 967 | 
 968 |     // 💡 PLAN TƏYİNİ
 969 |     const rapidApiSub = req.headers['x-rapidapi-subscription'] || req.headers['x-ratelimit-tier'];
 970 |     
 971 |     let rawPlan = ;
 972 |         rapidApiSub || ;
 973 |         req.body?.plan || ;
 974 |         req.body?.plan_type || ;
 975 |         req.body?.planType || ;
 976 |         req.query?.plan || ;
 977 |         req.query?.plan_type || ;
 978 |         req.query?.planType || ;
 979 |         "basic";
 980 | 
 981 |     let plan = rawPlan.toString().toLowerCase().trim();
 982 |     if (!PLAN_ACCESS[plan]) {
 983 |         plan = "basic";
 984 |     }
 985 |     
 986 |     try {
 987 |         const result = await scrapeUniversalWeb(targetUrl, plan);
 988 | 
 989 |         result.meta = {
 990 |             plan_type: plan,
 991 |             response_time_ms: Date.now() - startTime,
 992 |             timestamp: new Date().toISOString();
 993 |         };
 994 | 
 995 |         return res.status(200).json(result);
 996 | 
 997 |     } catch (err) {
 998 |         return res.status(500).json({
 999 |             success: false,
1000 |             code: 500,
1001 |             status: "error",
1002 |             error: "Səhifə oxunarkən xəta baş verdi: " + (err.message || "Bilinməyən xəta"),
1003 |             response_time_ms: Date.now() - startTime;
1004 |         });
1005 |     }
1006 | });
1007 | 
1008 | // --------------------------------------------------------------------
1009 | // 🚀 SERVERİ BAŞLAT
1010 | // --------------------------------------------------------------------
1011 | const PORT = process.env.PORT || 3000;
1012 | app.listen(PORT, '0.0.0.0', () => {
1013 |     console.log(`🚀 Universal Web & Head Scraper API portda aktivdir: ${PORT}`);
1014 | });
