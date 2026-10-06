// Asılılıqları daxil edirik
require('dotenv').config();

const express = require('express');
const axios = require('axios');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function checkApiKey(req) {
    const proxySecret = req.headers['x-rapidapi-proxy-secret'];
    if (proxySecret && proxySecret === process.env.RAPIDAPI_PROXY_SECRET) {
        console.log("✅ RapidAPI Proxy təsdiqləndi");
        return { key: 'rapidapi-proxy' };
    }

    // Əgər sorğu RapidAPI üzərindən gəlibsə, RapidAPI özü bu başlıqları əlavə edir:
    const rapidApiUser = req.headers['x-rapidapi-user'];
    const rapidApiSub = req.headers['x-rapidapi-subscription'];

    if (rapidApiUser || rapidApiSub) {
        console.log("✅ RapidAPI Qapısından keçdi, İstifadəçi:", rapidApiUser);
        return { key: rapidApiUser || 'rapidapi-user' };
    }

    // Əgər kənardan birbaşa (Postman ilə birbaşa Render-ə) sorğu gələrsə:
    const rawHeader =
        req.headers['x-api-key'] ||
        req.headers['x-rapidapi-key'] ||
        req.headers['authorization'] ||
        null;

    if (!rawHeader) {
        console.log("❌ API KEY tapılmadı");
        return null;
    }

    const apiKey = rawHeader
        .replace(/^(Bearer|Key)\s+/i, '')
        .trim();

    console.log("✅ API KEY uğurla qəbul edildi");
    return { key: apiKey };
}

// ------------------------------------------------------------------
// KRİTİK FİKS #1: Stealth Plugin çıxarıldı. Stabil Launch əsas prioritetdir.
// ------------------------------------------------------------------

// 🌐 TƏHLÜKƏSİZLİK VƏ PERFORMANS KONFİGURASİYASI (Dəyişməz)
const ALLOWED_URL_SCHEMES = ['http:', 'https:'];
const BLOCKED_HOSTS_EXACT = ['localhost', '0.0.0.0']; 
const PRIVATE_IP_RANGES = [
    { start: '127.0.0.0', end: '127.255.255.255' }, // Loopback
    { start: '10.0.0.0', end: '10.255.255.255' }, // Class A Private
    { start: '172.16.0.0', end: '172.31.255.255' }, // Class B Private
    { start: '192.168.0.0', end: '192.168.255.255' } // Class C Private
];

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

// 💵 RAPIDAPI PLANLARI VƏ DƏRİN ÇIXARMA SƏVİYYƏLƏRİ (Dəyişməz)
const PRICING_PLANS = {
    FREE: { 
        name: 'Free',
        internal: 'free',
        accessLevel: 0,
        dailyLimit: 50,
        monthlyLimit: 1500,
        price: 0,
        features: [
            'Thumbnail çıxarışı',
            'Başlıq',
            'Müəllif məlumatı',
            'Əsas metadata'
        ]
    },

    BASIC: { 
        name: 'Basic',
        internal: 'basic',
        accessLevel: 1,
        dailyLimit: 1000,
        monthlyLimit: 30000,
        price: 19.99,
        features: [
            'Free xüsusiyyətləri',
            'OpenGraph məlumatları',
            'Səhifə təsviri',
            'Əsas mətn çıxarışı'
        ]
    },

    PRO: { 
        name: 'Pro',
        internal: 'pro',
        accessLevel: 2,
        dailyLimit: 10000,
        monthlyLimit: 300000,
        price: 79.99,
        features: [
            'Basic xüsusiyyətləri',
            'Tam səhifə məzmunu',
            'Şəkillərin çıxarılması',
            'Linklərin çıxarılması',
            'Video mənbələri'
        ]
    },

    ULTRA: { 
        name: 'Ultra',
        internal: 'ultra',
        accessLevel: 3,
        dailyLimit: 50000,
        monthlyLimit: 1500000,
        price: 249.99,
        features: [
            'Pro xüsusiyyətləri',
            'Prioritet emal',
            'Yüksək sorğu limiti',
            'Böyük layihələr üçün istifadə'
        ]
    }
};

// 📌 KONFİGURASİYA: PLANLAR ÜZRƏ MƏLUMAT LİMİTLƏRİ (Dəyişməz)
const PLAN_CONTENT_LIMITS = {
    contentLimit: {
        basic: 5000,
        pro: 10000,
        ultra: 100000,
        free: 500 
    },
    paragraphLimit: {
        basic: 10,
        pro: 50,
        ultra: 200
    },
    imageLimit: {
        basic: 10,
        pro: 50,
        ultra: 200
    }
};

const PLAN_ACCESS = {
    free: 0,
    basic: 1,
    pro: 2,
    ultra: 3
};

// ------------------------------------------------------------------
// 🛠️ KÖMƏKÇİ FUNTKİYALAR (Dəyişməz)
// ------------------------------------------------------------------

async function checkRateLimit(userId, plan) {
    if (!global.rateLimits) {
        global.rateLimits = {};
    }

    const key = userId || "guest";

    const limits = {
        basic: 50,
        pro: 1000,
        ultra: 10000,
        mega: 50000
    };

    const normalizedPlan = String(plan || "basic").toLowerCase();
    const limit = limits[normalizedPlan] || limits.basic;

    if (!global.rateLimits[key]) {
        global.rateLimits[key] = {
            count: 0,
            createdAt: Date.now()
        };
    }

    const data = global.rateLimits[key];

    // 24 saat keçibsə limiti sıfırla
    if (Date.now() - data.createdAt > 86400000) {
        data.count = 0;
        data.createdAt = Date.now();
    }

    data.count++;

    if (data.count > limit) {
        return {
            allowed: false,
            retryAfter: 86400
        };
    }

    return {
        allowed: true,
        remaining: limit - data.count
    };
}

function ipToLong(ip) {
    const parts = ip.split('.');

    if (parts.length !== 4) return 0;

    return parts.reduce(
        (acc, part) => (acc * 256) + parseInt(part, 10),
        0
    );
}

// 🌐 SSRF-dən müdafiə: Yalnız daxili/private IP-ləri bloklayır, public IP-lərə icazə verir.
function isPrivateOrBlockedIP(hostname) {
    const lowerHostname = hostname.toLowerCase();

    if (BLOCKED_HOSTS_EXACT.includes(lowerHostname)) {
        return true;
    }

    const isIp = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
    
    if (isIp) {
        const ipLong = ipToLong(hostname);
        for (const range of PRIVATE_IP_RANGES) {
            const startLong = ipToLong(range.start);
            const endLong = ipToLong(range.end);
            if (ipLong >= startLong && ipLong <= endLong) {
                return true; 
            }
        }
        return false; 
    }
    
    if (lowerHostname === '[::1]' || lowerHostname === '::1') {
        return true;
    }

    return false;
}

const PROXY_LIST = (process.env.PROXY_LIST || '').split(',').filter(Boolean);

function getRandomProxy() {
    if (PROXY_LIST.length === 0) return null;
    return PROXY_LIST[Math.floor(Math.random() * PROXY_LIST.length)];
}

// 🔧 GitHub File Data Extraction
async function extractGitHubFileData(url) {
    try {
        const u = new URL(url);
        if (!u.hostname.includes('github.com')) return null;

        const parts = u.pathname.split('/').filter(Boolean);

        if (parts.length >= 4 && ['blob', 'edit', 'tree'].includes(parts[2])) {
            const owner = parts[0];
            const repo = parts[1];
            const branch = parts[3];
            const filePath = parts.slice(4).join('/');

            console.log(`[GitHub]: Owner: ${owner}, Repo: ${repo}, Branch: ${branch}, File: ${filePath}`);

            const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
            console.log(`[GitHub]: Raw URL: ${rawUrl}`);

            const response = await axios.get(rawUrl, { timeout: 15000 });
            const text = response.data || '';

            const fileName = filePath.split('/').pop() || 'file';
            const preview = text.replace(/\s+/g, ' ').trim().slice(0, 500);

            console.log(`[GitHub]: File extracted successfully - ${fileName}`);

            return {
                title: `${owner}/${repo} - ${fileName}`,
                description: preview || 'GitHub faylı məzmunu',
                thumbnail: 'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png',
                is_video: false,
                embedHtml: null,
                source: 'github'
            };
        }

        return null;
    } catch (error) {
        console.error(`[GitHub]: Error extracting file: ${error.message}`);
        return null;
    }
}

// OEmbed funksiyaları
async function extractOembedData(url) {
    const oembedEndpoints = [
        `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`,
    ];
    for (const endpoint of oembedEndpoints) {
        try {
            const response = await axios.get(endpoint, { timeout: 5000 });
            const data = response.data;
            if (data && (data.thumbnail_url || data.html)) {
                return {
                    thumbnail: data.thumbnail_url,
                    title: data.title,
                    description: data.description || 'OEmbed vasitəsilə çıxarılıb.',
                    embedHtml: data.html,
                    is_video: true,
                };
            }
        } catch (error) { /* Ignore */ }
    }
    return null;
}

async function extractYouTubeData(url) {
    const videoIdMatch = url.match(/(?:v=|\/embed\/|youtu\.be\/|\/v\/|\/vi\/)([A-Za-z0-9_-]{11})/);
    const videoId = videoIdMatch?.[1];
    if (!videoId) {
        console.log("[YouTube]: Video ID not found for URL:", url);
        return {};
    }

    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    try {
        const response = await axios.get(oembedUrl, { 
            timeout: 8000,
            headers: {
                'User-Agent': USER_AGENT
            }
        });
        const data = response.data;
        return {
            thumbnail: data.thumbnail_url,
            title: data.title,
            description: `${data.author_name} tərəfindən. Kanal: ${data.provider_name}`,
            embedHtml: `<div class="aspect-w-16 aspect-h-9">${data.html}</div>`,
            is_video: true,
        };
    } catch (error) {
        console.log("[YouTube]: OEmbed failed, using fallback for videoId:", videoId);
        return {
            thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
            title: 'YouTube Video',
            description: 'YouTube videonun əsas məlumatı',
            embedHtml: `<div class="aspect-w-16 aspect-h-9"><iframe width="560" height="315" src="https://www.youtube.com/embed/${videoId}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>`,
            is_video: true,
        };
    }
}

async function extractTikTokData(url) {
    const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
    try {
        const response = await axios.get(oembedUrl, { timeout: 5000 });
        const data = response.data;
        return {
            thumbnail: data.thumbnail_url,
            title: data.title || 'TikTok Videosu',
            description: data.author_name ? `${data.author_name} tərəfindən.` : 'TikTok məzmunu',
            embedHtml: data.html || null,
            is_video: true,
        };
    } catch (error) {
        if (url.includes('tiktok.com')) {
            return {
                thumbnail: 'https://via.placeholder.com/640x360?text=TikTok+Content',
                title: 'TikTok Məzmunu (OEmbed Xətası)',
                description: 'TikTok məzmunu (API vasitəsilə çıxarılmadı).',
                embedHtml: null,
                is_video: true,
            };
        }
        return null;
    }
}

async function extractInstagramData(url) {
    if (url.includes('instagram.com')) {
        return {
            thumbnail: 'https://via.placeholder.com/640x360?text=Instagram+Post',
            title: 'Instagram Postu/Videosu',
            description: 'Instagram məzmunu. Dərin çıxarış tələb oluna bilər.',
            embedHtml: null,
            is_video: true,
        };
    }
    return null;
}

async function extractDailyMotionData(url) {
    const oembedUrl = `https://www.dailymotion.com/services/oembed?url=${encodeURIComponent(url)}`;
    try {
        const response = await axios.get(oembedUrl, { timeout: 5000 });
        const data = response.data;
        return {
            thumbnail: data.thumbnail_url,
            title: data.title || 'DailyMotion Videosu',
            description: data.author_name ? `${data.author_name} tərəfindən.` : 'DailyMotion məzmunu',
            embedHtml: data.html,
            is_video: true,
        };
    } catch (error) {
        return null;
    }
}

async function launchBrowserWithRetry(launchConfig) {
    const MAX_RETRIES = 3;
    const initialDelay = 1000;

    for (let i = 0; i < MAX_RETRIES; i++) {
        try {
            const browser = await puppeteer.launch(launchConfig);
            console.log(`[Puppeteer]: Browser uğurla işə salındı (Cəhd ${i + 1}).`);
            return browser;
        } catch (error) {
            console.warn(`[Puppeteer]: Launch Xətası (Cəhd ${i + 1}/${MAX_RETRIES}): ${error.message}`);
            if (i === MAX_RETRIES - 1) {
                throw error;
            }
            const delay = initialDelay * Math.pow(2, i);
            console.warn(`[Puppeteer]: Yenidən cəhd etmək üçün ${delay}ms gözlənilir.`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

async function extractDeepData(url, plan = PRICING_PLANS.FREE.internal) {
    const limits = PLAN_CONTENT_LIMITS;
    let browser = null;
    
    let result = {
        thumbnail: null,
        title: 'Başlıq tapılmadı',
        description: 'Təsvir tapılmadı',
        embedHtml: null, 
        deepData: {
            plan: plan,
            error: null, 
            pageContent: null,
            images: [],
            links: [],
            videoSources: [],
            has_video_sources: false, 
            stealth_mode_enabled: false 
        }
    };

    console.log(`[Puppeteer]: Plan '${plan}' üçün çıxarma işləyir. Core + Sparticuz konfiqurasiyası.`);

    const proxy = getRandomProxy();
    let launchArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gl-drawing-for-tests',
    ];

    if (proxy) {
        console.log(`[Puppeteer]: 🔄 İstifadə olunan Proksi: ${proxy}`);
        launchArgs.push(`--proxy-server=${proxy}`);
    }                                                                                                                                 
                                                                         
    let executablePath = '';

    try {
        executablePath = await chromium.executablePath();
        console.log("✅ Chromium path:", executablePath);

        if (!executablePath) {
            throw new Error("Chromium path boş qaytarıldı");
        }
    } catch (pathError) {
        console.error("❌ Chromium PATH ERROR:", pathError);
        result.deepData.error = `PUPPETEER LAUNCH PATH ERROR: ${pathError.message}`;
        return result;
    }                                                                

    const launchConfig = {
        args: launchArgs,
        headless: true, 
        defaultViewport: chromium.defaultViewport,
        executablePath: executablePath, 
        ignoreHTTPSErrors: true,
        timeout: 120000,
    };

    try {
        browser = await launchBrowserWithRetry(launchConfig);
        const page = await browser.newPage();

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const resourceType = req.resourceType();
            if (resourceType === 'image' || resourceType === 'font' || resourceType === 'media' || resourceType === 'stylesheet') {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => false
            });
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en', 'az']
            });
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) => (
                parameters.name === 'notifications' ?
                Promise.resolve({ state: Notification.permission }) :
                originalQuery(parameters)
            );
            Object.defineProperty(HTMLCanvasElement.prototype, 'toDataURL', {
                value: function () {
                    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAASwAAACWCAYAAABap0dnAAABiklEQVR4Xu3WMQEAIAIEwHj/p0R9ZtDBGeLNAgAAAAAAAAB2X9f1AQAAAAAAAACAVw4AAAAAAAAAAMCtBgAAAAAAAAAAgFsNAAAAAA';
                }
            });
        });
        
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'az-AZ, en-US,en;q=0.9,ru;q=0.8',
            'Referer': url 
        });

        await page.setUserAgent(USER_AGENT);

        console.log(`[Puppeteer]: URL-ə keçid edilir: ${url}`);
        
        await page.goto(url, {
            waitUntil: 'domcontentloaded', 
            timeout: 60000 
        });
        console.log(`[Puppeteer]: URL-ə keçid uğurlu oldu.`);

        try {
            await page.waitForSelector('meta[property="og:title"], h1, h2, title, body', { timeout: 10000 });
        } catch (e) {
            console.warn('[Puppeteer]: Əsas element 10 saniyə ərzində tapılmadı.');
        }

        const data = await page.evaluate((currentPlan, limits) => {
            const output = {};

            output.ogImage = document.querySelector('meta[property="og:image"]')?.content;
            output.ogTitle = document.querySelector('meta[property="og:title"]')?.content;
            output.ogDesc = document.querySelector('meta[property="og:description"]')?.content;
            output.pageTitle = document.title;

            const fallbackImage = Array.from(document.querySelectorAll('img[src]'))
                .map(img => img.src)
                .find(src => src && !src.includes('data:image') && src.length > 5); 
            output.fallbackImage = fallbackImage || null;

            if (currentPlan === 'free') {
                return output;
            }

            const contentLimit = limits.contentLimit[currentPlan] || limits.contentLimit.free;
            const paragraphLimit = limits.paragraphLimit[currentPlan];
            const imageLimit = limits.imageLimit[currentPlan];

            const textNodes = Array.from(document.querySelectorAll('p, li, article p, main p, div[role="main"] p, section > p, [data-testid*="content"]'));
            let paragraphs = [];

            textNodes.forEach(node => {
                const text = node.innerText.trim();
                if (text.length > 50 && text.length < 500) {
                    paragraphs.push(text);
                }
            });

            let paragraphsToUse = paragraphs;
            if (paragraphLimit) {
                paragraphsToUse = paragraphs.slice(0, paragraphLimit);
            }

            output.pageContent = paragraphsToUse.join('\n\n').substring(0, contentLimit);

            const images = Array.from(document.querySelectorAll('img[src], img[srcset], source[src], source[srcset]'))
                .flatMap(el => {
                    const sources = [];
                    if (el.src) sources.push(el.src);
                    if (el.srcset) {
                        const firstSrcsetMatch = el.srcset.match(/^\s*([^,\s]+)/); 
                        if (firstSrcsetMatch) sources.push(firstSrcsetMatch[1]);
                    }
                    return sources;
                })
                .filter(src => src && !src.includes('data:image'))
                .map(src => new URL(src, document.location.href).href)
                .filter((value, index, self) => self.indexOf(value) === index); 

            if (imageLimit) {
                output.images = images.slice(0, imageLimit);
            } else {
                output.images = images;
            }

            if (currentPlan === 'pro' || currentPlan === 'ultra') {
                output.links = Array.from(document.querySelectorAll('a[href]'))
                    .map(a => ({
                        text: a.innerText.trim().substring(0, 100) || new URL(a.href, document.location.href).hostname,
                        href: new URL(a.href, document.location.href).href
                    }))
                    .filter((value, index, self) => self.findIndex(item => item.href === value.href) === index);

                output.videoSources = Array.from(document.querySelectorAll('video[src], audio[src], iframe[src], iframe[srcdoc]'))
                    .map(el => el.src || el.getAttribute('srcdoc')) 
                    .filter(Boolean)
                    .filter((value, index, self) => self.indexOf(value) === index);
                
                output.has_video_sources = output.videoSources.length > 0;
            }

            return output;
        }, plan, limits); 

        result.thumbnail = data.ogImage || data.fallbackImage || 'https://via.placeholder.com/640x360?text=No+Thumbnail+Found';
        result.title = data.ogTitle || data.pageTitle || 'Başlıq tapılmadı';
        result.description = data.ogDesc || 'Təsvir tapılmadı';

        if (plan !== PRICING_PLANS.FREE.internal) {
            result.deepData.pageContent = data.pageContent;
            result.deepData.images = data.images;
            
            if (plan === PRICING_PLANS.PRO.internal || plan === PRICING_PLANS.ULTRA.internal) {
                result.deepData.links = data.links || [];
                result.deepData.videoSources = data.videoSources || [];
                result.deepData.has_video_sources = data.has_video_sources || false;
            }
        }

        return result;

    } catch (error) {
        console.error(`❌ Puppeteer Xətası URL ${url}: ${error.message}`);
        
        result.thumbnail = 'https://via.placeholder.com/640x360?text=Error+Loading+Page';
        result.title = result.title === 'Başlıq tapılmadı' ? 'Səhifə yüklənmədi (Timeout/Bot Blok)' : result.title;
        result.deepData.error = (result.deepData.error ? result.deepData.error + ' | ' : '') + `SƏHİFƏ XƏTASI: ${error.message}`;

        return result;
    } finally {
        if (browser) {
            await browser.close();
            console.log(`[Puppeteer]: Browser bağlandı.`);
        }
    }
}

// ----------------------------------------------------
// 📌 API ENDPOINT: /extract
// ----------------------------------------------------
app.post('/extract', async (req, res) => {
    console.log("YENİ KOD İŞLƏYİR");
    console.log("ALL HEADERS:", req.headers);
    console.log("BODY:", req.body);
    console.log("QUERY:", req.query);

    const apiKeyCheck = checkApiKey(req);  
    if (!apiKeyCheck) {                     
        console.log("API KEY BLOKLANDI");   
        return res.status(401).json({      
            error: "Invalid API key"       
        });                    
    }
    console.log("API KEY QƏBUL EDİLDİ");   

    const url = req.body?.url;
    
    if (!url) {
        return res.status(400).json({
            error: 'URL sahəsi tələb olunur.'
        });
    }

    let urlObj;
    try {
        urlObj = new URL(url);

        if (!ALLOWED_URL_SCHEMES.includes(urlObj.protocol)) {
            return res.status(400).json({
                error: `Yanlış protokol. Yalnız ${ALLOWED_URL_SCHEMES.join(' və ')} dəstəklənir.`
            });
        }

        if (isPrivateOrBlockedIP(urlObj.hostname)) {
            return res.status(403).json({
                error: 'Təhlükəsizlik Xətası (SSRF): Daxili, private və lokal host IP-lər bloklanmışdır.',
                hostname: urlObj.hostname
            });
        }
    } catch (e) {
        return res.status(400).json({
            error: `URL-i emal etmək mümkün olmadı: ${e.message}`
        });
    }

    // GitHub Xüsusi Handling
    const githubData = await extractGitHubFileData(url);
    if (githubData) {
        console.log("[API]: GitHub URL detected, returning GitHub data");
        return res.status(200).json({
            status: 'ok',
            plan_type: 'github',
            name: githubData.title,
            description: githubData.description,
            thumbnail_url: githubData.thumbnail,
            embed_html: githubData.embedHtml,
            is_video: githubData.is_video,
            deep_data: {
                plan: 'github',
                source: 'github_raw'
            }
        });
    }

    const rapidPlanHeader = req.body?.planType || 'basic';
    
    let userPlan = 'basic';
    if (rapidPlanHeader.includes('ultra')) {
        userPlan = 'ultra';
    } else if (rapidPlanHeader.includes('pro')) {
        userPlan = 'pro';
    } else if (rapidPlanHeader.includes('free')) {
        userPlan = 'free';
    }

    const requiredInternalPlan = userPlan;
    const user = {
        email: req.headers['x-rapidapi-user'] || 'Anonim İstifadəçi',
        plan: userPlan
    };

    const rate = await checkRateLimit(user.email, user.plan);
    if (!rate.allowed) {
        return res.status(429).json({
            status: "rate_limit_exceeded",
            message: "Gündəlik limit bitib.",
            retryAfter: rate.retryAfter
        });
    }
    
    console.log("🔑 RapidAPI Girişi:", user.email, "(Daxili Plan:", userPlan.toUpperCase() + ")");

    const requiredLevel = PLAN_ACCESS[requiredInternalPlan] ?? 0;
    const userLevel = PLAN_ACCESS[user.plan];
    
    if (requiredLevel > userLevel) {
        const requiredPlanInfo = PRICING_PLANS[requiredInternalPlan.toUpperCase()]?.name || "Ödənişli Plan";
        return res.status(403).json({
            status: 'denied',
            error: '🚫 Premium Xidmət Tələb Olunur',
            message: `Bu dərinlikdə məlumat çıxarmaq üçün minimum RapidAPI ${requiredPlanInfo} planına abunə olmalısınız. Hazırkı daxili planınız: ${user.plan.toUpperCase()}.`
        });
    }

    const isYouTubeUrl = url.includes('youtube.com') || url.includes('youtu.be');
    const isInstagramUrl = url.includes('instagram.com');

    try {
        let data = { deepData: null, is_video: false, embedHtml: null };
        const extractionPlan = user.plan;
        let oembedResult = {};

        if (isYouTubeUrl) {
            oembedResult = await extractYouTubeData(url);
        } else if (isInstagramUrl) {
            oembedResult = await extractInstagramData(url) || {};
        } else if (url.includes('tiktok.com/')) {
            oembedResult = await extractTikTokData(url) || {};
        } else if (url.includes('dailymotion.com')) {
            oembedResult = await extractDailyMotionData(url) || {};
        } else {
            oembedResult = await extractOembedData(url) || {};
        }

        data.is_video = oembedResult.is_video || false;
        data.embedHtml = oembedResult.embedHtml || null;
        data.thumbnail = oembedResult.thumbnail || null;
        data.title = oembedResult.title || null;
        data.description = oembedResult.description || null;

        let deepResult = {};
        if (extractionPlan !== PRICING_PLANS.FREE.internal) {
            console.log(`[API]: ${extractionPlan.toUpperCase()} planı üçün dərin çıxarma işə salınır...`);
            
            deepResult = await extractDeepData(url, extractionPlan);
            data.deepData = deepResult.deepData || {};

            if (!data.title) data.title = deepResult.title;
            if (!data.description) data.description = deepResult.description;
            if (!data.thumbnail) data.thumbnail = deepResult.thumbnail;
            
            if (data.deepData.has_video_sources) {
                 data.is_video = true;
            }
        } else {
             data.deepData = {
                plan: extractionPlan,
                status: 'limited', 
                message: "Dərin məlumat çıxarışı Free Plan tərəfindən məhdudlaşdırılıb.",
                stealth_mode_enabled: false 
             };
        }

        let responseStatus = 'ok';
        if (data.deepData?.error?.includes("PUPPETEER LAUNCH CRITICAL ERROR")) {
            responseStatus = 'critical_failed';
        } else if (data.deepData?.error) {
            responseStatus = 'partial_success'; 
        } else if (!data.title || !data.thumbnail) {
             responseStatus = 'partial_success'; 
        }

        const responseBody = {
            status: responseStatus,
            plan_type: user.plan,
            name: data.title || 'Başlıq tapılmadı',
            description: data.description || 'Təsvir tapılmadı',
            thumbnail_url: data.thumbnail || 'https://via.placeholder.com/640x360?text=Xəta',
            embed_html: data.embedHtml || null,
            is_video: data.is_video,
            deep_data: data.deepData
        };
        
        return res.status(200).json(responseBody);
    } catch (error) {
        console.error('❌ Ümumi API Xətası:', error.message);
        return res.status(500).json({
            status: 'error',
            plan_type: user.plan,
            error: error.message,
            message: 'API xətası'
        });
    }
});

// Admin panel marşrutu
app.get('/admin-panel', (req, res) => {
    res.send("Admin Panelinə Xoş Gəlmisiniz. Bu hissə hələ hazırlanır.");
});

console.log("SERVER BAŞLAYIR...");

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`API işləyir: http://localhost:${PORT}`);
});
