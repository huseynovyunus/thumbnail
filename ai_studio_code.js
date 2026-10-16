// Asılılıqları daxil edirik
require('dotenv').config();

const express = require('express');
const axios = require('axios');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 2. SIGORTA MIDDLEWARE: Əgər Content-Type undefined gələrsə, xam gövdəni özümüz oxuyub JSON-a çeviririk
app.use((req, res, next) => {
    if (!req.body || Object.keys(req.body).length === 0) {
        let data = '';
        req.on('data', chunk => {
            data += chunk;
        });
        req.on('end', () => {
            if (data) {
                try {
                    req.body = JSON.parse(data);
                    console.log("🛠️ [XAM BODY MANUAL OXUNDU]:", req.body);
                } catch (e) {
                    req.body = { url: data }; // Əgər sadə sətir kimi gəlibsə
                }
            }
            next();
        });
    } else {
        next();
    }
});

function checkApiKey(req) {
    const proxySecret = req.headers['x-rapidapi-proxy-secret'];
    if (proxySecret && process.env.RAPIDAPI_PROXY_SECRET && proxySecret === process.env.RAPIDAPI_PROXY_SECRET) {
        console.log("✅ RapidAPI Proxy təsdiqləndi");
        return { key: 'rapidapi-proxy' };
    }

    // Əgər RapidAPI istifadəçisi kimi gəlibsə
    const rapidApiUser = req.headers['x-rapidapi-user'];
    if (rapidApiUser) {
        console.log("✅ RapidAPI İstifadəçisi təsdiqləndi:", rapidApiUser);
        return { key: rapidApiUser };
    }

    // Kənar sorğular üçün birbaşa Açar yoxlanılması
    const rawHeader =
        req.headers['x-api-key'] ||
        req.headers['x-rapidapi-key'] ||
        req.headers['authorization'] ||
        null;

    if (!rawHeader) {
        console.log("❌ API KEY tapılmadı");
        return null;
    }

    const apiKey = rawHeader.replace(/^(Bearer|Key)\s+/i, '').trim();

    if (process.env.RAPIDAPI_KEY && apiKey !== process.env.RAPIDAPI_KEY) {
        console.log("❌ API KEY düzgün deyil");
        return null;
    }

    console.log("✅ API KEY uğurla qəbul edildi");
    return { key: apiKey };
}

// 🌐 TƏHLÜKƏSİZLİK VƏ PERFORMANS KONFİGURASİYASI
const ALLOWED_URL_SCHEMES = ['http:', 'https:'];
const BLOCKED_HOSTS_EXACT = ['localhost', '0.0.0.0']; 
const PRIVATE_IP_RANGES = [
    { start: '127.0.0.0', end: '127.255.255.255' },       // Loopback
    { start: '10.0.0.0', end: '10.255.255.255' },         // Class A Private
    { start: '172.16.0.0', end: '172.31.255.255' },       // Class B Private
    { start: '192.168.0.0', end: '192.168.255.255' },     // Class C Private
    { start: '169.254.0.0', end: '169.254.255.255' }      // Link-local / Cloud Metadata (SSRF Mühafizəsi)
];

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

function ipToLong(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) return 0;
    return parts.reduce((acc, part) => (acc * 256) + parseInt(part, 10), 0);
}

// 🛡️ URL-in və ya Hostnamenin təhlükəsiz olub olmadığını yoxlayan funksiya
function isPrivateOrBlockedIP(input) {
    try {
        let hostname = input;
        
        if (input && input.includes('://')) {
            const parsedUrl = new URL(input);
            hostname = parsedUrl.hostname;
        }

        if (!hostname) return true;

        const lowerHostname = hostname.toLowerCase();

        // 1. Dəqiq bloklanmış hostlar (localhost, 0.0.0.0 və s.)
        if (BLOCKED_HOSTS_EXACT.includes(lowerHostname)) {
            return true;
        }

        // 2. IP formatındadırsa, private diapazonları yoxlayırıq
        const isIp = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
        if (isIp) {
            const ipLong = ipToLong(hostname);
            for (const range of PRIVATE_IP_RANGES) {
                const startLong = ipToLong(range.start);
                const endLong = ipToLong(range.end);
                if (ipLong >= startLong && ipLong <= endLong) {
                    return true; // Private IP-dir, blokla
                }
            }
            return false; // Public IP-dir, icazə ver
        }
        
        // 3. IPv6 localhost yoxlanışı
        if (lowerHostname === '[::1]' || lowerHostname === '::1') {
            return true;
        }

        return false;
    } catch (error) {
        console.error("SSRF Check Error:", error.message);
        return true;
    }
}

// 💵 Planlar obyekti
const PRICING_PLANS = {
    BASIC: { name: 'Basic', internal: 'basic', accessLevel: 1, dailyLimit: 10, monthlyLimit: 100, price: 0 },
    PRO: { name: 'Pro', internal: 'pro', accessLevel: 2, dailyLimit: 400, monthlyLimit: 10000, price: 20 },
    ULTRA: { name: 'Ultra', internal: 'ultra', accessLevel: 3, dailyLimit: 2000, monthlyLimit: 50000, price: 80 },
    MEGA: { name: 'Mega', internal: 'mega', accessLevel: 4, dailyLimit: 10000, monthlyLimit: 300000, price: 250 },
    basic: { name: 'Basic', internal: 'basic', accessLevel: 1, dailyLimit: 10, monthlyLimit: 100, price: 0 },
    pro: { name: 'Pro', internal: 'pro', accessLevel: 2, dailyLimit: 400, monthlyLimit: 10000, price: 20 },
    ultra: { name: 'Ultra', internal: 'ultra', accessLevel: 3, dailyLimit: 2000, monthlyLimit: 50000, price: 80 },
    mega: { name: 'Mega', internal: 'mega', accessLevel: 4, dailyLimit: 10000, monthlyLimit: 300000, price: 250 }
};

// 📌 MƏLUMAT VƏ SİMVOL LİMİTLƏRİ
const PLAN_CONTENT_LIMITS = {
    contentLimit: {
        basic: 500,
        pro: 5000,
        ultra: null,
        mega: null
    },
    paragraphLimit: {
        basic: 10,
        pro: 30,
        ultra: null,
        mega: null
    },
    imageLimit: {
        basic: 3,
        pro: 30,
        ultra: null,
        mega: null
    }
};

const PLAN_ACCESS = {
    basic: 1,
    pro: 2,
    ultra: 3,
    mega: 4
};

async function checkRateLimit(userId, plan) {
    if (!global.rateLimits) {
        global.rateLimits = {};
    }

    const key = userId || "guest";
    const limits = {
        basic: 10,
        pro: 400,
        ultra: 2000,
        mega: 10000
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

function getRandomProxy() {
    return null;
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
            const response = await axios.get(rawUrl, { timeout: 15000 });
            const text = response.data || '';

            const fileName = filePath.split('/').pop() || 'file';
            const preview = String(text).replace(/\s+/g, ' ').trim().slice(0, 500);

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
    const videoIdMatch = url.match(/(?:v=|\/embed\/|youtu\.be\/|\/v\/|\/vi\/|\/shorts\/)([A-Za-z0-9_-]{11})/);
    const videoId = videoIdMatch?.[1];
    if (!videoId) {
        return {};
    }

    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    try {
        const response = await axios.get(oembedUrl, { 
            timeout: 8000,
            headers: { 'User-Agent': USER_AGENT }
        });
        const data = response.data;

        let channelIdentifier = data.author_name;
        if (data.author_url && data.author_url.includes('/@')) {
            const handleMatch = data.author_url.match(/\/(@[^\/?]+)/);
            if (handleMatch) {
                channelIdentifier = handleMatch[1];
            }
        }

        return {
            thumbnail: data.thumbnail_url,
            title: data.title,
            description: `${channelIdentifier ? channelIdentifier.trim() : 'Müəllif'} tərəfindən. Kanal: ${data.provider_name}`,
            embedHtml: `<div class="aspect-w-16 aspect-h-9">${data.html}</div>`,
            is_video: true,
        };
    } catch (error) {
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
                description: 'TikTok məzmunu.',
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
            description: 'Instagram məzmunu.',
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
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

async function extractDeepData(url, plan = 'basic') {
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

    console.log(`[Puppeteer]: Plan '${plan}' üçün çıxarma işləyir.`);

    const proxy = getRandomProxy();
    let launchArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gl-drawing-for-tests',
    ];

    if (proxy) {
        launchArgs.push(`--proxy-server=${proxy}`);
    }                                                                                                                                 
                                                                         
    let executablePath = '';

    try {
        executablePath = await chromium.executablePath();
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
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'az'] });
        });
        
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'az-AZ, en-US,en;q=0.9,ru;q=0.8',
            'Referer': url 
        });

        await page.setUserAgent(USER_AGENT);

        await page.goto(url, {
            waitUntil: 'domcontentloaded', 
            timeout: 60000 
        });

        await new Promise(resolve => setTimeout(resolve, 2000));

        try {
            await page.waitForSelector('meta[property="og:title"], h1, h2, title, body', { timeout: 10000 });
        } catch (e) {
            console.warn('[Puppeteer]: Əsas element 10 saniyə ərzində tapılmadı.');
        }

        const data = await page.evaluate((currentPlan, limits) => {
            const output = {};

            let rawOgImage = document.querySelector('meta[property="og:image"]')?.content;
            if (rawOgImage) {
                try {
                    const parsed = new URL(rawOgImage, document.location.href);
                    output.ogImage = parsed.origin + parsed.pathname;
                } catch(e) {
                    output.ogImage = rawOgImage;
                }
            } else {
                output.ogImage = null;
            }
            
            output.ogTitle = document.querySelector('meta[property="og:title"]')?.content;
            output.ogDesc = document.querySelector('meta[property="og:description"]')?.content || document.querySelector('meta[name="description"]')?.content || null;
            output.pageTitle = document.title;

            const fallbackImageSrc = Array.from(document.querySelectorAll('img[src]'))
                .map(img => img.src)
                .find(src => src && !src.includes('data:image') && src.length > 5); 

            if (fallbackImageSrc) {
                try {
                    const parsed = new URL(fallbackImageSrc, document.location.href);
                    output.fallbackImage = parsed.origin + parsed.pathname;
                } catch(e) {
                    output.fallbackImage = fallbackImageSrc;
                }
            } else {
                output.fallbackImage = null;
            }

            if (currentPlan === 'basic') {
                return output;
            }

            const contentLimit = limits.contentLimit[currentPlan] || limits.contentLimit.basic;
            const paragraphLimit = limits.paragraphLimit[currentPlan];
            const imageLimit = limits.imageLimit[currentPlan];

            // 1. Məzmun konteyneri
            const contentContainer = document.querySelector('#mw-content-text') || document.querySelector('main') || document.body;
            
            // 2. Təmizləmə
            const clone = contentContainer.cloneNode(true);
            clone.querySelectorAll('script, style, nav, header, footer, .mw-editsection, .noprint, .vector-menu').forEach(el => el.remove());

            // 3. Mətn oxuma (DÜZƏLDİLDİ ✅)
            let lines = clone.innerText
                .replace(/[\u200E\u200F\u200B\uFEFF]/g, '')
                .split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0);

            if (paragraphLimit) {
                lines = lines.slice(0, paragraphLimit);
            }

            const rawContent = lines.join('\n\n');
            output.pageContent = contentLimit ? rawContent.substring(0, contentLimit) : rawContent;

            // Şəkillər
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
                .map(src => {
                    try {
                        const parsed = new URL(src, document.location.href);
                        return parsed.origin + parsed.pathname;
                    } catch(e) {
                        return src;
                    }
                })
                .filter((value, index, self) => self.indexOf(value) === index);

            if (imageLimit) {
                output.images = images.slice(0, imageLimit);
            } else {
                output.images = images;
            }

            // Linklər və Video mənbələri (DÜZƏLDİLDİ ✅)
            if (currentPlan === 'pro' || currentPlan === 'ultra' || currentPlan === 'mega') {
                const unwantedPatterns = [
                    'accounts.google.com',
                    'support.google.com',
                    'developers.google.com',
                    'tv.youtube.com',
                    'music.youtube.com',
                    'youtubekids.com',
                    'reporthistory',
                    '/feed/',
                    '/channel/',
                    '/premium',
                    '/about/',
                    '/about/press/',
                    '/about/copyright/',
                    '/about/policies/',
                    '/t/contact_us',
                    '/creators/',
                    '/ads/',
                    '/t/terms',
                    '/t/privacy',
                    '/howyoutubeworks',
                    '/new',
                    'signin',
                    'support'
                ];

                const allLinks = Array.from(document.querySelectorAll('a[href]'))
                    .map(a => {
                        try {
                            const parsed = new URL(a.href, document.location.href);
                            return {
                                text: a.innerText.trim().substring(0, 100) || parsed.hostname,
                                href: parsed.href
                            };
                        } catch(e) {
                            return null;
                        }
                    })
                    .filter(Boolean)
                    .filter((value, index, self) => self.findIndex(item => item.href === value.href) === index)
                    .filter(link => {
                        const href = link.href;
                        if (!href || !href.startsWith('http')) return false;
                        return !unwantedPatterns.some(pattern => href.includes(pattern));
                    });

                if (currentPlan === 'mega' || currentPlan === 'ultra') {
                    output.links = allLinks; 
                } else {
                    output.links = allLinks.slice(0, 50); 
                }

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

        if (plan !== 'basic') {
            result.deepData.pageContent = data.pageContent;
            result.deepData.images = data.images;

            if (plan === 'pro' || plan === 'ultra' || plan === 'mega') {
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
    console.log("--- YENİ SORĞU GƏLDİ ---");
    console.log("METHOD:", req.method);
    console.log("CONTENT-TYPE:", req.headers['content-type']);
    console.log("BODY:", req.body);

    const apiKeyCheck = checkApiKey(req);  
    if (!apiKeyCheck) {                     
        return res.status(401).json({ error: "Invalid API key" });                    
    }

    const url = req.body?.url || req.query.url || req.body?.targetUrl || req.body?.target_url || req.body?.link || req.body?.input?.url || req.body?.data?.url;
    
    if (!url || typeof url !== 'string' || url.trim() === '') {
        return res.status(400).json({ error: 'URL sahəsi boş ola bilməz və ya tələb olunur.' });
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
        return res.status(400).json({ error: `URL-i emal etmək mümkün olmadı: ${e.message}` });
    }
    
    // GitHub Xüsusi Handling
    const githubData = await extractGitHubFileData(url);
    if (githubData) {
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

    const rawPlanInput = req.body?.plan_type || req.body?.planType || req.body?.plan || req.query.plan_type || req.query.plan || req.headers['x-ratelimit-plan'] || req.headers['x-rapidapi-subscription'] || '';
    const rapidPlanHeader = String(rawPlanInput).toLowerCase();
    
    let userPlan = 'basic';
    if (rapidPlanHeader.includes('mega')) {
        userPlan = 'mega';
    } else if (rapidPlanHeader.includes('ultra')) {
        userPlan = 'ultra';
    } else if (rapidPlanHeader.includes('pro')) {
        userPlan = 'pro';
    } else {
        userPlan = 'basic';
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
        if (extractionPlan !== 'basic') {
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

        return res.status(200).json({
            status: responseStatus,
            plan_type: user.plan,
            name: data.title || 'Başlıq tapılmadı',
            description: data.description || 'Təsvir tapılmadı',
            thumbnail_url: data.thumbnail || 'https://via.placeholder.com/640x360?text=Xəta',
            embed_html: data.embedHtml || null,
            is_video: data.is_video,
            deep_data: data.deepData
        });
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

app.get('/admin-panel', (req, res) => {
    res.send("Admin Panelinə Xoş Gəlmisiniz. Bu hissə hələ hazırlanır.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`API işləyir: http://localhost:${PORT}`);
});