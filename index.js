// ====================================================================
// 🌐 PURE UNIVERSAL WEB & ARTICLE SCRAPER API (RENDER & RAPIDAPI)
// 🎯 DƏRİN <HEAD>, META VƏ JSON-LD ÇIXARIŞI İLƏ TAM TƏMİZLƏNMİŞ VERSİYA
// ====================================================================

require('dotenv').config();

const express = require('express');
const axios = require('axios');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 🛡️ Sığorta Middleware: Content-Type başlıqsız xam body-ni oxuyur
app.use((req, res, next) => {
    if (!req.body || Object.keys(req.body).length === 0) {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => {
            if (data) {
                try {
                    req.body = JSON.parse(data);
                } catch (e) {
                    req.body = { url: data };
                }
            }
            next();
        });
    } else {
        next();
    }
});

// --------------------------------------------------------------------
// 🏥 HEALTH CHECK ENDPOINT (Həm GET, həm də POST qəbul edir)
// --------------------------------------------------------------------
app.all(['/health', '/healrh'], (req, res) => {
    return res.status(200).json({
        status: "ok",
        message: "Server aktivdir və problemsiz işləyir.",
        uptime_seconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString()
    });
});

// --------------------------------------------------------------------
// 🔑 TƏHLÜKƏSİZLİK VƏ PLAN TƏNZİMLƏMƏLƏRİ (RAPIDAPI ADLARINA UYĞUNLAŞDIRILDI)
// --------------------------------------------------------------------
const ALLOWED_URL_SCHEMES = ['http:', 'https:'];
const BLOCKED_HOSTS_EXACT = ['localhost', '0.0.0.0']; 
const PRIVATE_IP_RANGES = [
    { start: '127.0.0.0', end: '127.255.255.255' },
    { start: '10.0.0.0', end: '10.255.255.255' },
    { start: '172.16.0.0', end: '172.31.255.255' },
    { start: '192.168.0.0', end: '192.168.255.255' },
    { start: '169.254.0.0', end: '169.254.255.255' }
];

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

// RapidAPI plan adları: basic, pro, ultra, mega
const PLAN_CONTENT_LIMITS = {
    contentLimit:   { basic: 2000, pro: 5000, ultra: 15000, mega: null },
    paragraphLimit: { basic: 15,   pro: 30,   ultra: 100,   mega: null },
    imageLimit:     { basic: 10,   pro: 30,   ultra: 100,   mega: null },
    linkLimit:      { basic: 20,   pro: 50,   ultra: 200,   mega: null }
};

const PLAN_ACCESS = { basic: 1, pro: 2, ultra: 3, mega: 4 };

function ipToLong(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) return 0;
    return parts.reduce((acc, part) => (acc * 256) + parseInt(part, 10), 0);
}

function isPrivateOrBlockedIP(input) {
    try {
        let hostname = input;
        if (input && input.includes('://')) {
            hostname = new URL(input).hostname;
        }
        if (!hostname) return true;

        const lower = hostname.toLowerCase();
        if (BLOCKED_HOSTS_EXACT.includes(lower)) return true;

        const isIp = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
        if (isIp) {
            const ipLong = ipToLong(hostname);
            for (const range of PRIVATE_IP_RANGES) {
                if (ipLong >= ipToLong(range.start) && ipLong <= ipToLong(range.end)) return true;
            }
            return false;
        }

        if (lower === '[::1]' || lower === '::1') return true;
        return false;
    } catch {
        return true;
    }
}

function cleanText(text) {
    if (!text || typeof text !== 'string') return text;
    return text
        .replace(/\[\d+\]/g, '')
        .replace(/\[[a-zA-Z]\]/g, '')
        .replace(/[\u200E\u200F\u200B\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// ⚡ Qısa linkləri əsl URL-ə çevirir
async function resolveShortUrl(targetUrl) {
    try {
        const u = new URL(targetUrl);
        const shortHosts = ['pin.it', 'bit.ly', 't.co', 'tinyurl.com', 'is.gd', 'buff.ly', 'ow.ly'];
        if (shortHosts.includes(u.hostname.toLowerCase())) {
            const redirect = await axios.get(targetUrl, {
                maxRedirects: 5,
                timeout: 5000,
                validateStatus: (s) => s >= 200 && s < 400,
                headers: { 'User-Agent': USER_AGENT }
            });
            return redirect.request?.res?.responseUrl || redirect.headers?.location || targetUrl;
        }
    } catch {}
    return targetUrl;
}

// 📰 Responsiv Məqalə Embed Kartı
function generateArticleEmbedHtml(title, description, thumbnail, url, siteName) {
    const hasThumb = thumbnail && !thumbnail.includes('placeholder') && !thumbnail.includes('No+Thumbnail');
    return `<div class="web-article-embed" style="max-width:560px;margin:12px 0;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#ffffff;box-shadow:0 2px 8px rgba(0,0,0,0.06);"><a href="${url}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;color:inherit;display:block;">${hasThumb ? `<div style="width:100%;max-height:280px;overflow:hidden;background:#f8fafc;"><img src="${thumbnail}" alt="${title}" style="width:100%;height:auto;display:block;object-fit:cover;" /></div>` : ''}<div style="padding:16px;"><div style="font-size:11px;color:#64748b;text-transform:uppercase;font-weight:700;letter-spacing:0.5px;margin-bottom:6px;">${siteName || 'Veb Məqalə'}</div><h3 style="margin:0 0 8px 0;font-size:17px;font-weight:700;color:#0f172a;line-height:1.35;">${title}</h3><p style="margin:0;font-size:13px;color:#475569;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${description}</p></div></a></div>`;
}

// --------------------------------------------------------------------
// 🌐 ƏSAS MƏQALƏ, HEAD VƏ METADATA ÇIXARIŞI (PUPPETEER)
// --------------------------------------------------------------------
async function scrapeUniversalWeb(targetUrl, plan = "basic") {
    let browser = null;
    try {
        browser = await puppeteer.launch({
            args: [
                ...chromium.args,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process',
                '--no-zygote'
            ],
            defaultViewport: { width: 1280, height: 800 },
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
            ignoreHTTPSErrors: true
        });

        const page = await browser.newPage();
        await page.setUserAgent(USER_AGENT);
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'az,tr,en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        });

        // 🛡️ Render 512MB RAM mühafizəsi
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const resource = req.resourceType();
            if (['image', 'media', 'font', 'stylesheet'].includes(resource)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.goto(targetUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 25000
        });

        await new Promise(resolve => setTimeout(resolve, 1000));

        const extracted = await page.evaluate((pageUrl) => {
            const out = {
                head: {
                    title: '',
                    description: '',
                    site_name: '',
                    canonical: '',
                    favicon: '',
                    author: '',
                    keywords: '',
                    language: document.documentElement.lang || '',
                    charset: document.characterSet || 'UTF-8',
                    open_graph: {},
                    twitter: {},
                    all_meta: {},
                    json_ld: []
                },
                body: {
                    h1: '',
                    paragraphs: [],
                    images: [],
                    links: [],
                    videoSources: []
                }
            };

            const titleEl = document.querySelector('title');
            if (titleEl && titleEl.innerText) {
                out.head.title = titleEl.innerText.trim();
            }

            document.querySelectorAll('meta').forEach(meta => {
                const name = (meta.getAttribute('name') || meta.getAttribute('property') || meta.getAttribute('http-equiv') || meta.getAttribute('itemprop') || '').trim();
                const content = (meta.getAttribute('content') || meta.getAttribute('value') || '').trim();

                if (!name || !content) return;

                const lowerName = name.toLowerCase();
                out.head.all_meta[name] = content;

                if (lowerName.startsWith('og:')) {
                    out.head.open_graph[lowerName.replace(/^og:/, '')] = content;
                }
                if (lowerName.startsWith('twitter:')) {
                    out.head.twitter[lowerName.replace(/^twitter:/, '')] = content;
                }
                if (['description', 'og:description', 'twitter:description'].includes(lowerName) && !out.head.description) {
                    out.head.description = content;
                }
                if (['og:site_name', 'application-name', 'publisher'].includes(lowerName) && !out.head.site_name) {
                    out.head.site_name = content;
                }
                if (['author', 'article:author', 'twitter:creator'].includes(lowerName) && !out.head.author) {
                    out.head.author = content;
                }
                if (lowerName === 'keywords' && !out.head.keywords) {
                    out.head.keywords = content;
                }
            });

            const canonicalEl = document.querySelector('link[rel="canonical"]');
            if (canonicalEl && canonicalEl.getAttribute('href')) {
                out.head.canonical = canonicalEl.getAttribute('href');
            } else if (out.head.open_graph.url) {
                out.head.canonical = out.head.open_graph.url;
            }

            const iconEl = document.querySelector('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]');
            if (iconEl && iconEl.getAttribute('href')) {
                try {
                    out.head.favicon = new URL(iconEl.getAttribute('href'), pageUrl).href;
                } catch {
                    out.head.favicon = iconEl.getAttribute('href');
                }
            } else {
                try {
                    const u = new URL(pageUrl);
                    out.head.favicon = `${u.origin}/favicon.ico`;
                } catch {}
            }

            document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
                try {
                    const raw = script.innerText.trim();
                    if (raw) {
                        const parsed = JSON.parse(raw);
                        out.head.json_ld.push(parsed);
                        if (!out.head.title && parsed.headline) out.head.title = parsed.headline;
                        if (!out.head.description && parsed.description) out.head.description = parsed.description;
                    }
                } catch {}
            });

            if (!out.head.title) {
                out.head.title = out.head.open_graph.title || out.head.twitter.title || '';
            }

            const h1El = document.querySelector('h1');
            if (h1El) out.body.h1 = h1El.innerText.trim();
            if (!out.head.title && out.body.h1) out.head.title = out.body.h1;

            const contentContainer = document.querySelector('.article-body') || document.querySelector('.news-text') || document.querySelector('.post-content') || document.querySelector('.article-content') || document.querySelector('article') || document.body;
            
            if (contentContainer) {
                const clone = contentContainer.cloneNode(true);
                
                const removeSelectors = [
                    'script', 'style', 'nav', 'header', 'footer', 'form', 'aside', 
                    '.sidebar', '.related-news', '.widgets', '.banner', '.ads', 
                    '.advertisement', '.social-share', '.tags', '.author-box', 
                    '.read-more', '.other-news', '.news-box', 'ul', 'ol', 'figure'
                ];
                clone.querySelectorAll(removeSelectors.join(', ')).forEach(el => el.remove());

                clone.querySelectorAll('p').forEach(p => {
                    const txt = p.innerText.trim();
                    if (txt && txt.length > 30) {
                        const upperTxt = txt.toUpperCase();
                        const lowerTxt = txt.toLowerCase();
                        
                        const isJunk = 
                            upperTxt.includes('ƏMƏLİYYAT İCRA OLUNUR') ||
                            lowerTxt.includes('hörmətli istifadəçi') || 
                            lowerTxt.includes('ödənişli') || 
                            lowerTxt.includes('qeydiyyatdan keçin') ||
                            lowerTxt.includes('t.me/') ||
                            lowerTxt.includes('instagram.com') ||
                            lowerTxt.includes('bizi') ||
                            lowerTxt.includes('izləyin');

                        if (!isJunk) {
                            out.body.paragraphs.push(txt);
                        }
                    }
                });
            }

            if (!out.head.description && out.body.paragraphs.length > 0) {
                out.head.description = out.body.paragraphs[0];
            }

            const seenImages = new Set();
            const ogImg = out.head.open_graph.image || out.head.twitter.image;
            if (ogImg) {
                try {
                    const absoluteOg = new URL(ogImg, pageUrl).href;
                    seenImages.add(absoluteOg);
                    out.body.images.push(absoluteOg);
                } catch {
                    seenImages.add(ogImg);
                    out.body.images.push(ogImg);
                }
            }

            document.querySelectorAll('img').forEach(img => {
                const src = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original');
                if (!src) return;
                try {
                    const abs = new URL(src, pageUrl).href;
                    if (!abs.includes('tracker') && !abs.includes('pixel') && !abs.includes('.svg') && !seenImages.has(abs)) {
                        seenImages.add(abs);
                        out.body.images.push(abs);
                    }
                } catch {}
            });

            const seenLinks = new Set();
            document.querySelectorAll('a').forEach(a => {
                const href = a.getAttribute('href');
                const text = a.innerText.trim();
                if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
                try {
                    const abs = new URL(href, pageUrl).href;
                    if (!seenLinks.has(abs)) {
                        seenLinks.add(abs);
                        out.body.links.push({ text: text || 'Keçid', url: abs });
                    }
                } catch {}
            });

            const unwantedIframes = ['ct.pinterest.com', 'google', 'doubleclick', 'analytics', 'facebook.com/tr', 'clarity.ms', 'unidestin', 'metrix.az'];
            document.querySelectorAll('iframe').forEach(iframe => {
                const src = iframe.getAttribute('src') || iframe.getAttribute('data-src') || '';
                if (src && !unwantedIframes.some(u => src.toLowerCase().includes(u))) {
                    if (src.includes('youtube') || src.includes('vimeo') || src.endsWith('.mp4') || src.includes('embed')) {
                        out.body.videoSources.push(src);
                    }
                }
            });

            document.querySelectorAll('video, video source').forEach(v => {
                const src = v.getAttribute('src');
                if (src) out.body.videoSources.push(src);
            });

            return out;
        }, targetUrl);

        await browser.close();
        browser = null;

        const pageTitle = extracted.head.title || '';
        const pageDesc = extracted.head.description || '';
        
        if (
            pageTitle.includes("Bir dakika lütfen") || 
            pageTitle.includes("Attention Required") || 
            pageDesc.includes("kötü niyetli botlara karşı") ||
            pageTitle.includes("Access Denied")
        ) {
            return {
                success: false,
                code: 403,
                status: "error",
                error: "Target website is protected by Cloudflare or bot verification. Access blocked.",
                name: pageTitle,
                description: pageDesc,
                site_name: new URL(targetUrl).hostname,
                is_video: false
            };
        }

        const limits = {
            para: PLAN_CONTENT_LIMITS.paragraphLimit[plan] !== undefined ? PLAN_CONTENT_LIMITS.paragraphLimit[plan] : 15,
            img: PLAN_CONTENT_LIMITS.imageLimit[plan] !== undefined ? PLAN_CONTENT_LIMITS.imageLimit[plan] : 10,
            link: PLAN_CONTENT_LIMITS.linkLimit[plan] !== undefined ? PLAN_CONTENT_LIMITS.linkLimit[plan] : 20,
            textLen: PLAN_CONTENT_LIMITS.contentLimit[plan] !== undefined ? PLAN_CONTENT_LIMITS.contentLimit[plan] : 2000
        };

        const finalParagraphs = limits.para === null ? extracted.body.paragraphs : extracted.body.paragraphs.slice(0, limits.para);
        let fullText = finalParagraphs.join("\n\n");
        if (limits.textLen !== null && fullText.length > limits.textLen) {
            fullText = fullText.substring(0, limits.textLen) + "...";
        }

        const finalImages = limits.img === null ? extracted.body.images : extracted.body.images.slice(0, limits.img);
        const finalLinks = limits.link === null ? extracted.body.links : extracted.body.links.slice(0, limits.link);

        const thumbnail = extracted.head.open_graph.image || extracted.head.twitter.image || (finalImages.length > 0 ? finalImages[0] : null);
        const finalTitle = cleanText(extracted.head.title || extracted.body.h1 || "Səhifə Başlığı Yoxdur");
        const finalDescription = cleanText(extracted.head.description || (fullText ? fullText.substring(0, 200) : "Təsvir tapılmadı"));
        const finalSiteName = extracted.head.site_name || extracted.head.open_graph.site_name || (new URL(targetUrl)).hostname;

        const finalCanonical = (extracted.head.canonical && extracted.head.canonical !== 'undefined') 
            ? extracted.head.canonical 
            : targetUrl;

        const hasVideo = extracted.body.videoSources.length > 0;
        let embedHtml = '';
        if (hasVideo) {
            embedHtml = `<div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:12px;"><iframe src="${extracted.body.videoSources[0]}" style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;" allowfullscreen></iframe></div>`;
        } else {
            embedHtml = generateArticleEmbedHtml(finalTitle, finalDescription, thumbnail, targetUrl, finalSiteName);
        }

        return {
            success: true,
            code: 200,
            status: "ok",
            plan_type: plan,
            name: finalTitle,
            description: finalDescription,
            thumbnail_url: thumbnail,
            favicon_url: extracted.head.favicon,
            canonical_url: finalCanonical,
            author: extracted.head.author || null,
            site_name: finalSiteName,
            embed_html: embedHtml,
            is_video: hasVideo,
            head: {
                title: finalTitle,
                description: finalDescription,
                site_name: finalSiteName,
                canonical_url: finalCanonical,
                favicon: extracted.head.favicon,
                author: extracted.head.author,
                keywords: extracted.head.keywords,
                language: extracted.head.language,
                charset: extracted.head.charset,
                open_graph: extracted.head.open_graph,
                twitter: extracted.head.twitter,
                json_ld: extracted.head.json_ld,
                all_meta_tags: extracted.head.all_meta
            },
            deep_data: {
                plan: plan,
                error: null,
                pageContent: cleanText(fullText),
                paragraphs: finalParagraphs.map(cleanText),
                images: finalImages,
                links: finalLinks,
                videoSources: extracted.body.videoSources,
                has_video_sources: hasVideo
            }
        };

    } catch (err) {
        if (browser) {
            try { await browser.close(); } catch {}
        }
        throw err;
    }
}

// --------------------------------------------------------------------
// 🚀 ƏSAS API ENDPOINT (HƏM GET, HƏM DƏ POST DƏSTƏKLƏNİR)
// --------------------------------------------------------------------
app.all(['/', '/scrape', '/extract'], async (req, res) => {
    const startTime = Date.now();

    let targetUrl = req.body?.url || req.query?.url;
    if (!targetUrl && typeof req.body === 'string') targetUrl = req.body;

    if (!targetUrl || typeof targetUrl !== 'string') {
        return res.status(400).json({
            success: false,
            code: 400,
            status: "error",
            error: "Zəhmət olmasa 'url' parametrini daxil edin (məsələn: { \"url\": \"https://example.com\" })"
        });
    }

    targetUrl = targetUrl.trim();
    if (!/^https?:\/\//i.test(targetUrl)) {
        targetUrl = 'https://' + targetUrl;
    }

    targetUrl = await resolveShortUrl(targetUrl);

    try {
        const parsed = new URL(targetUrl);
        if (!ALLOWED_URL_SCHEMES.includes(parsed.protocol)) {
            return res.status(400).json({ success: false, code: 400, error: "Yalnız HTTP və HTTPS protokolları dəstəklənir." });
        }
        if (isPrivateOrBlockedIP(parsed.hostname)) {
            return res.status(403).json({ success: false, code: 403, error: "Təhlükəsizlik səbəbilə daxili/lokal ünvanlara icazə verilmir." });
        }
    } catch {
        return res.status(400).json({ success: false, code: 400, error: "Daxil edilən URL düzgün deyil." });
    }

    let plan = (req.body?.plan || req.body?.planType || req.query?.plan || req.query?.planType || "basic").toString().toLowerCase();
    if (!PLAN_ACCESS[plan]) plan = "basic";

    try {
        const result = await scrapeUniversalWeb(targetUrl, plan);

        result.meta = {
            plan_type: plan,
            response_time_ms: Date.now() - startTime,
            timestamp: new Date().toISOString()
        };

        return res.status(200).json(result);

    } catch (err) {
        return res.status(500).json({
            success: false,
            code: 500,
            status: "error",
            error: "Səhifə oxunarkən xəta baş verdi: " + (err.message || "Bilinməyən xəta"),
            response_time_ms: Date.now() - startTime
        });
    }
});

// --------------------------------------------------------------------
// 🚀 SERVERİ BAŞLAT
// --------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Universal Web & Head Scraper API portda aktivdir: ${PORT}`);
});
