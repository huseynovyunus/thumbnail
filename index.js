// Asılılıqları daxil edirik
const express = require('express');
const axios = require('axios');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();

app.use(express.json());


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

function ipToLong(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) return 0;
    return parts.reduce((acc, part) => (acc * 256) + parseInt(part, 10), 0);
}

// 🌐 SSRF-dən müdafiə: Yalnız daxili/private IP-ləri bloklayır, public IP-lərə icazə verir.
function isPrivateOrBlockedIP(hostname) {
    const lowerHostname = hostname.toLowerCase();

    // 1. Exact host yoxlaması
    if (BLOCKED_HOSTS_EXACT.includes(lowerHostname)) {
        return true;
    }

    const isIp = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
    
    // 2. IP Diapazon yoxlaması (SSRF-in əsas hədəfi)
    if (isIp) {
        const ipLong = ipToLong(hostname);
        
        // Private IP diapazonlarını yoxla
        for (const range of PRIVATE_IP_RANGES) {
            const startLong = ipToLong(range.start);
            const endLong = ipToLong(range.end);
            if (ipLong >= startLong && ipLong <= endLong) {
                // Daxili/Private IP tapıldı - BLOKLA
                return true; 
            }
        }
        
        // Əgər IP-dirsə, amma heç bir private diapazona düşmürsə (yəni Public-dirsə), icazə verilir (return false).
        return false; 
    }
    
    // 3. IPv6 localhost yoxlaması
    if (lowerHostname === '[::1]' || lowerHostname === '::1') {
        return true;
    }

    // IP olmayan domenlər həmişə icazəlidir (DNS yoxlaması server tərəfindən aparılır)
    return false;
}

const PROXY_LIST = (process.env.PROXY_LIST || '').split(',').filter(Boolean);

function getRandomProxy() {
    if (PROXY_LIST.length === 0) return null;
    return PROXY_LIST[Math.floor(Math.random() * PROXY_LIST.length)];
}


// OEmbed funksiyaları (Dəyişməz)
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
    if (!videoId) return {};
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    try {
        const response = await axios.get(oembedUrl, { timeout: 5000 });
        const data = response.data;
        return {
            thumbnail: data.thumbnail_url,
            title: data.title,
            description: `${data.author_name} tərəfindən. Kanal: ${data.provider_name}`,
            embedHtml: `<div class="aspect-w-16 aspect-h-9">${data.html}</div>`,
            is_video: true,
        };
    } catch (error) {
        return {
            thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
            title: null,
            description: null,
            embedHtml: `<div class="aspect-w-16 aspect-h-9"><iframe width="200" height="113" src="https://www.youtube.com/embed/${videoId}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen title="${videoId}"></iframe></div>`,
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
        // TƏKMİLLƏŞDİRMƏ #3: TikTok üçün ağıllı fallback extractor
        if (url.includes('tiktok.com')) {
            // Yükləməyə çalışmadan, sadəcə placeholder qaytar
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

// Instagram üçün Fallback Extractor (Yeni Təkmilləşdirmə)
async function extractInstagramData(url) {
    if (url.includes('instagram.com')) {
        // Instagram-ın OEmbed-i çox tez-tez dəyişir/bloklanır, ona görə dərhal fallback veririk
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


// TƏKMİLLƏŞDİRMƏ #4: Crash-proof üçün Puppeteer Launch Retry Sistemi
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
                // Son cəhd uğursuz oldu
                throw error;
            }
            const delay = initialDelay * Math.pow(2, i);
            console.warn(`[Puppeteer]: Yenidən cəhd etmək üçün ${delay}ms gözlənilir.`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}


/**
 * 🚀 PUPPETEER ilə DƏRİN MƏLUMAT ÇIXARMA
 * Bu, Puppeteer-core və Sparticuz Chromium ilə ən STABİL versiyadır.
 */
async function extractDeepData(url, plan = PRICING_PLANS.FREE.internal) {    const limits = PLAN_CONTENT_LIMITS; 
    
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
    // TƏKMİLLƏŞDİRMƏ #1: Performans üçün kritik resursları blokla (Səhifə yüklənməsini sürətləndirir)
    const sparticuzArgs = Array.isArray(chromium.args) 
        ? chromium.args 
        : [];
                                                                         
    let launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gl-drawing-for-tests',
    ];                                                             

    let headlessMode = true;                                                                     

    if (proxy) {
        console.log(`[Puppeteer]: 🔄 İstifadə olunan Proksi: ${proxy} (Launch Args-a əlavə edildi)`);
        launchArgs.push(`--proxy-server=${proxy}`);
    }
    
    let executablePath = '';
    try {
        executablePath = await chromium.executablePath();
    } catch (pathError) {
        console.error(`❌ Chromium yolu hesablanmadı: ${pathError.message}`);
        result.deepData.error = `PUPPETEER LAUNCH PATH ERROR: Chromium yolu tapılmadı/hesablanmadı.`;
        return result;
    }
    
    // Launch Konfiqurasiyası
    const launchConfig = {
        args: launchArgs, 
        headless: headlessMode, 
        defaultViewport: chromium.defaultViewport,
        executablePath: executablePath, 
        ignoreHTTPSErrors: true,
        timeout: 120000,
    };

    try {
        // 1. PUPPETEER BAŞLANĞICI (Retry sistemi ilə)
        browser = await launchBrowserWithRetry(launchConfig);

        // 2. SƏHİFƏYƏ KEÇİD VƏ SCRAPING MƏNTİQİ
        const page = await browser.newPage();

        // TƏKMİLLƏŞDİRMƏ #1: Səhifə yüklənməsini sürətləndirmək üçün şəkilləri/fontları/mediayı blokla
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const resourceType = req.resourceType();
            if (resourceType === 'image' || resourceType === 'font' || resourceType === 'media' || resourceType === 'stylesheet') {
                req.abort();
            } else {
                req.continue();
            }
        });


        // TƏKMİLLƏŞDİRMƏ #2: Bot detection bypass üçün 4 manual fix
        await page.evaluateOnNewDocument(() => {
            // Fix 1: navigator.webdriver dəyərini gizlədir (Ən vacib fix)
            Object.defineProperty(navigator, 'webdriver', {
                get: () => false
            });
            // Fix 2: Chrome (not Headless) kimi davranmaq üçün 'languages' fixi
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en', 'az']
            });
            // Fix 3: 'permissions' sorğusunu aradan qaldırır
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) => (
                parameters.name === 'notifications' ?
                Promise.resolve({ state: Notification.permission }) :
                originalQuery(parameters)
            );
            // Fix 4: WebGL vendor/renderer spoofing (Bəzi bot blokları WebGL məlumatına baxır)
             Object.defineProperty(HTMLCanvasElement.prototype, 'toDataURL', {
                value: function () {
                    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAASwAAACWCAYAAABap0dnAAABiklEQVR4Xu3WMQEAIAIEwHj/p0R9ZtDBGeLNAgAAAAAAAAB2X9f1AQAAAAAAAACAVw4AAAAAAAAAAMCtBgAAAAAAAAAAgFsNAAAAAAAAAACAVw4AAAAAAAAAAMCtBgAAAAAAAAAAgFsNAAAAAAAAAACAVw4AAAAAAAAAAMCtBgAAAAAAAAAAgFsNAAAAAAAAAACAVw4AAAAAAAAAAMCtBgAAAAAAAAAAgFsNAAAAAAAAAACAVw4AAAAAAAAAAMCtBgAAAAAAAAAAgFsNAAAAAAAAAACAVw4AAAAAAAAAAMCtBgAAAAAAAAAAgFsNAAAAAAAAAACAVw4AAAAAAAAAAMCtBgAAAAAAAAAAgFsNAAAAAAAAAACAVw4AAAAAAAAAAMCtBgAAAAAAAAAAgFsNAAAAAAAAAACAVw4AAAAAAAAAAMCtBgAAAAAAAAAAgFsNAAAAAAAAAACAVw4AAAAAAAAAAMCtBgAAAAAAAAAAgFsNAAAAAAAAAACAVw4AAAAAAAAAAMCtBgAAAAAAAAAAgFsNAAAAAAAAAACAVw4AAAAAAAAAAMCtBgAAAAAAAAAAgFsNAAAAAAAAAACAVw4AAAAAAAAAAMCtBgAAAAAAAAAAgFsNAAAAAAAAAACAVw4AAAAAAAAAAMCtBgAAAAAAAAAAgFsNAAAAAAAAAACAVw4AAAAAAAAAAMCtBgAAAAAAAAAAgFsNAAAAAAAAAACAVw4AAAAAAAAAAMCtBgAAAAAAAAAAgFsNAAAAAAAAAACAVw4A9d42p7Bq7g8AAAAASUVORK5CYII='
                }
            });

        });
        
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'az-AZ, en-US,en;q=0.9,ru;q=0.8',
            'Referer': url // Bəzi saytlar üçün referer tələb oluna bilər
        });

        await page.setUserAgent(USER_AGENT);

        console.log(`[Puppeteer]: URL-ə keçid edilir: ${url}`);
        
        // waitUntil: 'domcontentloaded' daha sürətli yüklənmə üçün
        await page.goto(url, {
            waitUntil: 'domcontentloaded', 
            timeout: 60000 
        });
        console.log(`[Puppeteer]: URL-ə keçid uğurlu oldu (domcontentloaded event).`);

        // ... Səhifə yüklənməsi və məzmun çıxarma məntiqi (Dəyişməz)

        try {
            await page.waitForSelector('meta[property="og:title"], h1, h2, title, body', { timeout: 10000 });
        } catch (e) {
            console.warn('[Puppeteer]: Əsas element 10 saniyə ərzində tapılmadı. Qiymətləndirmə davam edir.');
        }

        const data = await page.evaluate((currentPlan, limits) => {
            const output = {};

            // 1. Əsas Meta Məlumatlar
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

            // 2. LİMİTLƏRİ TƏYİN ETMƏ
            const contentLimit = limits.contentLimit[currentPlan] || limits.contentLimit.free;
            const paragraphLimit = limits.paragraphLimit[currentPlan];
            const imageLimit = limits.imageLimit[currentPlan];

            // 3. MƏTNİN ÇIXARILMASI VƏ LİMİTLƏNMƏSİ
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

            // 4. ŞƏKİLLƏRİN ÇIXARILMASI
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


            // --- YALNIZ PRO VƏ ULTRA PLAN ÜÇÜN ---
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

        // Məlumatın qaytarılması
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
        console.error(`❌ Puppeteer Səhifə Yüklənməsi/Qiymətləndirilməsi Xətası URL ${url}: ${error.message}. Stack: ${error.stack}`);
        
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
    // 1. URL DOĞRULAMASI VƏ TƏHLÜKƏSİZLİK (SSRF qarşısının alınması)
    // ----------------------------------------------------
    app.post('/extract', async (req, res) => {
    console.log("YENİ KOD İŞLƏYİR");
    console.log("ALL HEADERS:", req.headers);
    const url = req.body?.url || req.query.url;
    const planType = req.body?.planType || req.query.planType;

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

        // TƏHLÜKƏSİZLİK: Yalnız private/daxili IP-lər bloklanır, public IP-lərə icazə verilir.
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

    // ----------------------------------------------------
    // 2. AUTHENTICATION (RapidAPI başlığı əsasında)
    // ----------------------------------------------------
    const rapidPlanHeader = (
        req.headers['x-rapidapi-subscription'] ||
        'free'
    ).toLowerCase();
        
    console.log("PLAN HEADER:", rapidPlanHeader);
        
    let userPlan = 'free';
    
    if (rapidPlanHeader.includes('ultra')) {
        userPlan = 'ultra';
    }
    else if (rapidPlanHeader.includes('pro')) {
        userPlan = 'pro';
    }
    else if (rapidPlanHeader.includes('basic')) {
        userPlan = 'basic';
    }

    const requiredInternalPlan = userPlan;    

    const user = {
      email: req.headers['x-rapidapi-user'] || 'Anonim İstifadəçi',
      plan: userPlan
    };
    PLAN HEADER: pro
        🔑 RapidAPI Girişi: huseynovyunis359 (Daxili Plan: PRO)

    // ----------------------------------------------------
    // 3. PLAN VƏ LİMİT CHECK
    // ----------------------------------------------------
    const requiredLevel = PLAN_ACCESS[requiredInternalPlan] ?? 0;
    const userLevel = PLAN_ACCESS[user.plan];
    const currentPlanConfig = Object.values(PRICING_PLANS).find(p => p.internal === user.plan);
    const dailyLimit = currentPlanConfig ? currentPlanConfig.dailyLimit : 0;
    
    if (requiredLevel > userLevel) {
        const requiredPlanInfo = PRICING_PLANS[requiredInternalPlan.toUpperCase()]?.name || "Ödənişli Plan";
    
        return res.status(403).json({
            status: 'denied',
            error: '🚫 Premium Xidmət Tələb Olunur',
            message: `Bu dərinlikdə məlumat çıxarmaq üçün minimum RapidAPI ${requiredPlanInfo} planına abunə olmalısınız. Hazırkı daxili planınız: ${user.plan.toUpperCase()}.`
        });
    }

    
    // ----------------------------------------------------
    // 4. ƏSAS MƏNTİQ
    // ----------------------------------------------------
    const isYouTubeUrl = url.includes('youtube.com') || url.includes('youtu.be');
    const isInstagramUrl = url.includes('instagram.com');

    try {
        let data = { deepData: null, is_video: false, embedHtml: null };
        const extractionPlan = user.plan;

        // 1. Oembed yoxlaması
        let oembedResult = {};

        if (isYouTubeUrl) {
            oembedResult = await extractYouTubeData(url);
        } else if (isInstagramUrl) {
            // Instagram üçün fallback dərhal istifadə edilir
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


        // Deep Extract məntiqi: Pullu planlar üçün işə salınır.
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
             // Free plan məhdudiyyəti qeyd edilir (5. Qeydi)
             data.deepData = {
                plan: extractionPlan,
                status: 'limited', 
                message: "Dərin məlumat çıxarışı Free Plan tərəfindən məhdudlaşdırılıb.",
                stealth_mode_enabled: false 
             };
        }


        // 5. Final Nəticənin Qurulması
        
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
        
        res.status(200).json(responseBody);
    } catch (error) {
        console.error('❌ Ümumi API Xətası:', error.message);

        return res.status(200).json({
            status: 'partial_success',
            plan_type: user.plan,
            error: error.message,
            message: 'Daxili xəta oldu, amma plan və çıxarılan məlumat göstərilir.'
        });
    }

});

console.log("SERVER BAŞLAYIR...");

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`API işləyir: http://localhost:${PORT}`);
});
