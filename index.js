// ====================================================================
// 🌐 UNIVERSAL WEB ARTICLE & NEWS EXTRACTOR API (With Smart Embeds)
// ====================================================================

require('dotenv').config();

const express = require('express');
const axios = require('axios');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 🛡️ Sığorta Middleware
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
// 🔑 TƏHLÜKƏSİZLİK VƏ PLAN TƏNZİMLƏMƏLƏRİ
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

// 💎 PLAN LİMİTLƏRİ (Ultra və Mega üçün hər şey limitsizdir)
const PLAN_CONTENT_LIMITS = {
    contentLimit: {
        basic: 500,
        pro: 5000,
        ultra: null,
        mega: null
    },
    paragraphLimit: {
        basic: 5,
        pro: 30,
        ultra: null,
        mega: null
    },
    imageLimit: {
        basic: 3,
        pro: 30,
        ultra: null,
        mega: null
    },
    linkLimit: {
        basic: 0,
        pro: 50,
        ultra: null,
        mega: null
    }
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
                if (ipLong >= ipToLong(range.start) && ipLong <= ipToLong(range.end)) {
                    return true;
                }
            }
            return false;
        }

        if (lower === '[::1]' || lower === '::1') return true;
        return false;
    } catch {
        return true;
    }
}

function checkApiKey(req) {
    const proxySecret = req.headers['x-rapidapi-proxy-secret'];
    if (proxySecret && process.env.RAPIDAPI_PROXY_SECRET && proxySecret === process.env.RAPIDAPI_PROXY_SECRET) {
        return { key: 'rapidapi-proxy' };
    }
    const rapidApiUser = req.headers['x-rapidapi-user'];
    if (rapidApiUser) {
        return { key: rapidApiUser };
    }
    const rawHeader = req.headers['x-api-key'] || req.headers['x-rapidapi-key'] || req.headers['authorization'] || null;
    if (!rawHeader) return null;
    const apiKey = rawHeader.replace(/^(Bearer|Key)\s+/i, '').trim();
    if (process.env.RAPIDAPI_KEY && apiKey !== process.env.RAPIDAPI_KEY) return null;
    return { key: apiKey };
}

async function checkRateLimit(userId, plan) {
    if (!global.rateLimits) global.rateLimits = {};
    const key = userId || "guest";
    const limits = { basic: 10, pro: 400, ultra: 2000, mega: 10000 };
    const limit = limits[String(plan || "basic").toLowerCase()] || limits.basic;

    if (!global.rateLimits[key]) {
        global.rateLimits[key] = { count: 0, createdAt: Date.now() };
    }
    const data = global.rateLimits[key];
    if (Date.now() - data.createdAt > 86400000) {
        data.count = 0;
        data.createdAt = Date.now();
    }
    data.count++;
    if (data.count > limit) {
        return { allowed: false, retryAfter: 86400 };
    }
    return { allowed: true, remaining: limit - data.count };
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

// ⚡ Qısa linkləri (pin.it, bit.ly, t.co və s.) dərhal əsl URL-ə çevirən funksiya (Gecikməni aradan qaldırır)
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
    } catch {
        // Xəta olarsa orijinal link qaytarılır
    }
    return targetUrl;
}

// 📰 Xəbər və Məqalə saytları üçün hazır, responsiv HTML Embed Kartı generasiya edən funksiya
function generateArticleEmbedHtml(title, description, thumbnail, url, siteName) {
    const hasThumb = thumbnail && !thumbnail.includes('No+Thumbnail') && !thumbnail.includes('placeholder');
    return `<div class="web-article-embed" style="max-width:560px;margin:12px 0;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#ffffff;box-shadow:0 2px 8px rgba(0,0,0,0.06);"><a href="${url}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;color:inherit;display:block;">${hasThumb ? `<div style="width:100%;max-height:280px;overflow:hidden;background:#f8fafc;"><img src="${thumbnail}" alt="${title}" style="width:100%;height:auto;display:block;object-fit:cover;" /></div>` : ''}<div style="padding:16px;"><div style="font-size:11px;color:#64748b;text-transform:uppercase;font-weight:700;letter-spacing:0.5px;margin-bottom:6px;">${siteName || 'Xəbər / Məqalə'}</div><h3 style="margin:0 0 8px 0;font-size:17px;font-weight:700;color:#0f172a;line-height:1.35;">${title}</h3><p style="margin:0;font-size:13px;color:#475569;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${description}</p></div></a></div>`;
}

// --------------------------------------------------------------------
// 💻 GITHUB Raw fayl çıxarışı
// --------------------------------------------------------------------
async function extractGitHubFileData(url) {
    try {
        const u = new URL(url);
        if (!u.hostname.includes('github.com')) return null;
        const parts = u.pathname.split('/').filter(Boolean);

        if (parts.length >= 4 && ['blob', 'edit', 'tree'].includes(parts[2])) {
            const [owner, repo, , branch, ...filePaths] = parts;
            const filePath = filePaths.join('/');
            const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;

            const res = await axios.get(rawUrl, { timeout: 15000 });
            const text = String(res.data || '');
            const fileName = filePath.split('/').pop() || 'file';

            return {
                title: `${owner}/${repo} - ${fileName}`,
                description: text.substring(0, 500).replace(/\s+/g, ' ').trim(),
                thumbnail: 'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png',
                is_video: false,
                embed_html: `<pre><code>${text.substring(0, 300)}...</code></pre>`,
                resolved_url: url,
                deepData: {
                    plan: 'github',
                    pageContent: text
                }
            };
        }
        return null;
    } catch {
        return null;
    }
}

// --------------------------------------------------------------------
// 🌐 DƏRİN MƏQALƏ, XƏBƏR VƏ SAYT ÇIXARIŞI (Puppeteer / Chromium)
// --------------------------------------------------------------------
async function extractDeepData(url, plan = 'basic') {
    const limits = PLAN_CONTENT_LIMITS;
    let browser = null;
    let result = {
        thumbnail: null,
        title: 'Başlıq tapılmadı',
        description: 'Təsvir tapılmadı',
        embedHtml: null,
        siteName: null,
        deepData: {
            plan: plan,
            error: null,
            pageContent: null,
            images: [],
            links: [],
            videoSources: [],
            has_video_sources: false
        }
    };

    let executablePath = await chromium.executablePath();
    if (!executablePath) {
        result.deepData.error = "Chromium path tapılmadı";
        return result;
    }

    const launchArgs = [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process'
    ];

    try {
        browser = await puppeteer.launch({
            args: launchArgs,
            headless: chromium.headless,
            defaultViewport: chromium.defaultViewport,
            executablePath: executablePath,
            ignoreHTTPSErrors: true,
            timeout: 120000
        });

        const page = await browser.newPage();
        
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const type = req.resourceType();
            if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.setUserAgent(USER_AGENT);
        const responseObj = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 50000 });

        if (responseObj && responseObj.status() >= 400) {
            result.deepData.error = `SƏHİFƏ XƏTASI: HTTP Status ${responseObj.status()}`;
            return result;
        }

        await new Promise(r => setTimeout(r, 1200));

        const data = await page.evaluate(async (currentPlan, limitsConfig) => {
            const out = {
                ogImage: null,
                ogTitle: null,
                ogDesc: null,
                pageTitle: null,
                siteName: null,
                pageContent: null,
                images: [],
                links: [],
                videoSources: [],
                has_video_sources: false
            };

            // Metadata oxunması
            const ogImg = document.querySelector('meta[property="og:image"]')?.content ||
                          document.querySelector('meta[name="twitter:image"]')?.content;
            if (ogImg) {
                try { out.ogImage = new URL(ogImg, document.location.href).href; } catch { out.ogImage = ogImg; }
            }
            
            out.ogTitle = document.querySelector('meta[property="og:title"]')?.content ||
                          document.querySelector('meta[name="twitter:title"]')?.content;
            out.ogDesc = document.querySelector('meta[property="og:description"]')?.content || 
                         document.querySelector('meta[name="description"]')?.content ||
                         document.querySelector('meta[name="twitter:description"]')?.content;
            out.pageTitle = document.title;
            out.siteName = document.querySelector('meta[property="og:site_name"]')?.content || document.location.hostname;

            const contentLimit = limitsConfig.contentLimit[currentPlan];
            const paragraphLimit = limitsConfig.paragraphLimit[currentPlan];
            const imageLimit = limitsConfig.imageLimit[currentPlan];
            const linkLimit = limitsConfig.linkLimit[currentPlan];

            // Əsas məzmun konteyneri
            const mainEl = document.querySelector('#mw-content-text') || 
                           document.querySelector('article') || 
                           document.querySelector('main') || 
                           document.querySelector('[role="main"]') || 
                           document.body;

            const clone = mainEl.cloneNode(true);
            
            // Reklam, menyu və lazımsız elementləri təmizləyirik
            clone.querySelectorAll('script, style, nav, header, footer, noscript, .mw-editsection, .noprint, .navbox, .vertical-navbox, .catlinks, .printfooter, form, [role="region"], [role="dialog"]').forEach(e => e.remove());

            // Paraqrafları yığırıq
            let pNodes = Array.from(clone.querySelectorAll('p, h1, h2, h3, h4, li'))
                .map(p => p.innerText.replace(/[\u200E\u200F\u200B\uFEFF]/g, '').trim())
                .filter(txt => txt.length > 20);

            if (pNodes.length === 0) {
                pNodes = [clone.innerText.replace(/\s+/g, ' ').trim()];
            }

            if (paragraphLimit) {
                pNodes = pNodes.slice(0, paragraphLimit);
            }

            let fullText = pNodes.join('\n\n');
            
            // Əgər mətnsiz səhifədirsə (məsələn, Pinterest kimi), təsviri mətn kimi istifadə edirik:
            if (!fullText && out.ogDesc) {
                fullText = out.ogDesc;
            }

            out.pageContent = contentLimit ? fullText.substring(0, contentLimit) : fullText;

            // Şəkillərin tam çıxarışı
            const imgElements = Array.from(document.querySelectorAll('img[src], img[srcset], source[srcset]'))
                .flatMap(el => {
                    const list = [];
                    if (el.src) list.push(el.src);
                    if (el.srcset) {
                        const match = el.srcset.match(/^\s*([^,\s]+)/);
                        if (match) list.push(match[1]);
                    }
                    return list;
                })
                .filter(src => src && !src.startsWith('data:image'))
                .map(src => {
                    try { return new URL(src, document.location.href).href; } catch { return src; }
                })
                .filter((v, i, self) => self.indexOf(v) === i);

            // Əgər səhifədə əlavə şəkil tapılmadısa, əsas ogImage-i mütləq daxil edirik:
            if (out.ogImage && !imgElements.includes(out.ogImage)) {
                imgElements.unshift(out.ogImage);
            }

            out.images = imageLimit ? imgElements.slice(0, imageLimit) : imgElements;

            // Keçid linkləri
            if (currentPlan !== 'basic') {
                const links = Array.from(clone.querySelectorAll('a[href]'))
                    .map(a => {
                        try {
                            const parsed = new URL(a.href, document.location.href);
                            return { text: a.innerText.trim().substring(0, 100) || parsed.hostname, href: parsed.href };
                        } catch { return null; }
                    })
                    .filter(Boolean)
                    .filter((v, i, self) => self.findIndex(item => item.href === v.href) === i)
                    .filter(l => l.href.startsWith('http'));

                out.links = linkLimit ? links.slice(0, linkLimit) : links;
            }

            // 🚫 Saxta analitika və reklam iframe-lərini qara siyahıya salırıq:
            const unwantedIframes = [
                'doubleclick', 'google', 'facebook', 'pinterest.com/ct', 'analytics', 
                'clarity', 'adsystem', 'pagead', 'yandex', 'criteo', 'hotjar', 'stats'
            ];

            out.videoSources = Array.from(document.querySelectorAll('video[src], iframe[src]'))
                .map(el => el.src)
                .filter(Boolean)
                .filter(src => !unwantedIframes.some(u => src.toLowerCase().includes(u)))
                .filter((v, i, self) => self.indexOf(v) === i);

            out.has_video_sources = out.videoSources.length > 0;

            return out;
        }, plan, limits);

        result.thumbnail = data.ogImage || (data.images && data.images[0]) || 'https://via.placeholder.com/640x360?text=No+Thumbnail';
        result.title = data.ogTitle || data.pageTitle || 'Başlıq tapılmadı';
        result.description = data.ogDesc || (data.pageContent ? data.pageContent.substring(0, 200) + '...' : 'Təsvir tapılmadı');
        result.siteName = data.siteName;

        result.deepData.pageContent = data.pageContent;
        result.deepData.images = data.images;
        result.deepData.links = data.links;
        result.deepData.videoSources = data.videoSources;
        result.deepData.has_video_sources = data.has_video_sources;

        return result;
    } catch (err) {
        result.deepData.error = `SƏHİFƏ XƏTASI: ${err.message}`;
        return result;
    } finally {
        if (browser) await browser.close();
    }
}

// ----------------------------------------------------
// 📌 ƏSAS API ENDPOINT: POST /extract
// ----------------------------------------------------

app.post('/extract', async (req, res) => {
    const startTime = Date.now();

    const apiKeyCheck = checkApiKey(req);
    if (!apiKeyCheck) {
        return res.status(401).json({ success: false, code: 401, error: "Invalid API key" });
    }

    const rawUrl = req.body?.url || req.query.url || req.body?.targetUrl || req.body?.target_url || req.body?.link;
    if (!rawUrl || typeof rawUrl !== 'string' || rawUrl.trim() === '') {
        return res.status(400).json({ success: false, code: 400, error: 'URL sahəsi boş ola bilməz və ya tələb olunur.' });
    }

    // ⚡ Qısa linkləri (pin.it və s.) dərhal əsl linkə çeviririk ki, vaxt itkisi olmasın
    const url = await resolveShortUrl(rawUrl.trim());

    let urlObj;
    try {
        if (/(https?:\/\/){2,}/i.test(url)) {
            return res.status(400).json({ success: false, code: 400, message: "Təkrarlanan protokol aşkarlandı" });
        }
        urlObj = new URL(url);
        if (!ALLOWED_URL_SCHEMES.includes(urlObj.protocol)) {
            return res.status(400).json({ success: false, code: 400, error: 'Yalnız http və https protokolları dəstəklənir.' });
        }
        if (!urlObj.hostname.includes('.')) {
            return res.status(400).json({ success: false, code: 400, message: "Domen adı düzgün deyil" });
        }
        if (isPrivateOrBlockedIP(urlObj.hostname)) {
            return res.status(403).json({ success: false, code: 403, error: 'Təhlükəsizlik Xətası (SSRF): Daxili IP-lər bloklanmışdır.' });
        }
    } catch (e) {
        return res.status(400).json({ success: false, code: 400, message: "Yanlış URL formatı" });
    }

    // 🚀 Planın Dəqiq Təyini
    const rawPlan = req.body?.plan || req.body?.plan_type || req.query?.plan || req.query?.plan_type || 
                    req.headers['x-rapidapi-subscription'] || req.headers['x-ratelimit-plan'] || '';
    const planStr = String(rawPlan).toLowerCase();

    let userPlan = 'basic';
    if (planStr.includes('mega')) userPlan = 'mega';
    else if (planStr.includes('ultra')) userPlan = 'ultra';
    else if (planStr.includes('pro')) userPlan = 'pro';

    const user = { email: req.headers['x-rapidapi-user'] || 'Anonim İstifadəçi', plan: userPlan };
    const rate = await checkRateLimit(user.email, user.plan);
    if (!rate.allowed) {
        return res.status(429).json({ success: false, code: 429, message: "Gündəlik limit bitib.", retryAfter: rate.retryAfter });
    }

    // 1. GitHub
    const githubData = await extractGitHubFileData(url);
    if (githubData) {
        return res.status(200).json({
            success: true,
            code: 200,
            status: 'ok',
            plan_type: user.plan,
            ...githubData,
            meta: {
                plan_type: user.plan,
                quota_remaining: rate.remaining,
                response_time_ms: Date.now() - startTime,
                timestamp: new Date().toISOString()
            }
        });
    }

    // 2. Mərkəzi Xəbər, Məqalə və Sayt Çıxarışı
    try {
        const result = await extractDeepData(url, user.plan);

        result.title = cleanText(result.title);
        result.description = cleanText(result.description);
        if (result.deepData?.pageContent) {
            result.deepData.pageContent = cleanText(result.deepData.pageContent);
        }

        if (result.deepData?.error?.includes("HTTP Status 404") || (result.title === 'Başlıq tapılmadı' && !result.description)) {
            return res.status(404).json({
                success: false,
                code: 404,
                status: "error",
                plan_type: user.plan,
                message: result.deepData?.error || "Səhifə və ya məzmun tapılmadı (404)"
            });
        }

        // 🌟 AKILLI EMBED: Əgər məqalədə video pleyer varsa videonun embedi, yoxdursa hazır Xəbər/Məqalə Embed Kartı verilir!
        let finalEmbedHtml = null;
        if (result.deepData?.videoSources && result.deepData.videoSources.length > 0) {
            finalEmbedHtml = `<iframe src="${result.deepData.videoSources[0]}" width="560" height="315" frameborder="0" allowfullscreen></iframe>`;
        } else {
            finalEmbedHtml = generateArticleEmbedHtml(result.title, result.description, result.thumbnail, url, result.siteName);
        }

        return res.status(200).json({
            success: true,
            code: 200,
            status: 'ok',
            plan_type: user.plan,
            name: result.title || 'Başlıq tapılmadı',
            description: result.description || 'Təsvir tapılmadı',
            thumbnail_url: result.thumbnail || 'https://via.placeholder.com/640x360?text=No+Thumbnail',
            full_url: url,
            embed_html: finalEmbedHtml, // 👈 İSTƏDİYİNİZ HAZIR İŞLƏK EMBED KODU
            is_video: result.deepData?.has_video_sources || false,
            deep_data: result.deepData || null,
            meta: {
                plan_type: user.plan,
                quota_remaining: rate.remaining,
                response_time_ms: Date.now() - startTime,
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        return res.status(500).json({
            success: false,
            code: 500,
            status: 'error',
            plan_type: user.plan,
            error: error.message
        });
    }
});

// Admin Paneli
app.get('/admin-panel', (req, res) => {
    res.send("Admin Paneli: Universal Xəbər, Məqalə və Veb Scraper aktivdir.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`API uğurla başladı: http://0.0.0.0:${PORT}`);
});
