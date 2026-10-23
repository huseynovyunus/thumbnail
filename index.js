// Asılılıqları daxil edirik
require('dotenv').config();

const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Sığorta Middleware: Əgər Content-Type undefined gələrsə, xam gövdəni oxuyuruq
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

function checkApiKey(req) {
    const proxySecret = req.headers['x-rapidapi-proxy-secret'];
    if (proxySecret && process.env.RAPIDAPI_PROXY_SECRET && proxySecret === process.env.RAPIDAPI_PROXY_SECRET) {
        return { key: 'rapidapi-proxy' };
    }

    const rapidApiUser = req.headers['x-rapidapi-user'];
    if (rapidApiUser) {
        return { key: rapidApiUser };
    }

    const rawHeader =
        req.headers['x-api-key'] ||
        req.headers['x-rapidapi-key'] ||
        req.headers['authorization'] ||
        null;

    if (!rawHeader) return null;

    const apiKey = rawHeader.replace(/^(Bearer|Key)\s+/i, '').trim();

    if (process.env.RAPIDAPI_KEY && apiKey !== process.env.RAPIDAPI_KEY) {
        return null;
    }

    return { key: apiKey };
}

// IP-ni rəqəmsal formata çevirən köməkçi funksiya (SSRF yoxlaması üçün vacibdir)
function ipToLong(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) return 0;
    return parts.reduce((acc, part) => (acc * 256) + parseInt(part, 10), 0);
}

function isPrivateOrBlockedIP(input) {
    try {
        let hostname = input;
        if (input && input.includes('://')) {
            const parsedUrl = new URL(input);
            hostname = parsedUrl.hostname;
        }

        if (!hostname) return true;
        const lowerHostname = hostname.toLowerCase();

        if (BLOCKED_HOSTS_EXACT.includes(lowerHostname)) return true;

        const isIp = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
        if (isIp) {
            const ipLong = ipToLong(hostname);
            for (const range of PRIVATE_IP_RANGES) {
                const startLong = ipToLong(range.start);
                const endLong = ipToLong(range.end);
                if (ipLong >= startLong && ipLong <= endLong) return true;
            }
            return false;
        }
        
        if (lowerHostname === '[::1]' || lowerHostname === '::1') return true;

        return false;
    } catch (error) {
        return true;
    }
}

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

const PLAN_CONTENT_LIMITS = {
    contentLimit: { basic: 500, pro: 5000, ultra: null, mega: null },
    paragraphLimit: { basic: 10, pro: 30, ultra: null, mega: null },
    imageLimit: { basic: 3, pro: 30, ultra: null, mega: null }
};

function cleanText(text) {
    if (!text || typeof text !== 'string') return text;
    return text
        .replace(/\[\d+\]/g, '')
        .replace(/\[…\]/g, '')
        .replace(/\[[a-z0-9]+\]/gi, '')
        .replace(/[\r\n]+/g, ' ') 
        .replace(/\s+/g, ' ') 
        .trim();
}

async function checkRateLimit(userId, plan) {
    if (!global.rateLimits) global.rateLimits = {};

    const key = userId || "guest";
    const limits = { basic: 10, pro: 400, ultra: 2000, mega: 10000 };
    const normalizedPlan = String(plan || "basic").toLowerCase();
    const limit = limits[normalizedPlan] || limits.basic;

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

async function launchBrowserWithRetry(launchConfig) {
    const MAX_RETRIES = 3;
    const initialDelay = 1000;

    for (let i = 0; i < MAX_RETRIES; i++) {
        try {
            return await puppeteer.launch(launchConfig);
        } catch (error) {
            if (i === MAX_RETRIES - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, initialDelay * Math.pow(2, i)));
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
        deepData: {
            plan: plan,
            error: null, 
            pageContent: null,
            images: [],
            links: []
        }
    };

    let executablePath = '';
    try {
        executablePath = await chromium.executablePath();
        if (!executablePath) throw new Error("Chromium path boş qaytarıldı");
    } catch (pathError) {
        result.deepData.error = `PUPPETEER LAUNCH PATH ERROR: ${pathError.message}`;
        return result;
    }                                                                

    const launchConfig = {
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
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
            if (['image', 'font', 'media', 'stylesheet'].includes(resourceType)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.setUserAgent(USER_AGENT);
        
        const responseObj = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

        if (responseObj && responseObj.status() >= 400) {
            result.thumbnail = 'https://via.placeholder.com/640x360?text=Page+Not+Found';
            result.deepData.error = `SƏHİFƏ XƏTASI: HTTP Status ${responseObj.status()}`;
            return result;
        }

        await new Promise(resolve => setTimeout(resolve, 2000));

        const data = await page.evaluate(async (plan, limits) => {
            let output = {
                ogImage: null,
                ogTitle: null,
                ogDesc: null,
                pageTitle: null,
                fallbackImage: null,
                pageContent: null,
                images: [],
                links: []
            };

            output.ogImage = document.querySelector('meta[property="og:image"]')?.content || null;
            output.ogTitle = document.querySelector('meta[property="og:title"]')?.content;
            output.ogDesc = document.querySelector('meta[property="og:description"]')?.content || document.querySelector('meta[name="description"]')?.content || null;
            output.pageTitle = document.title;

            if (plan === 'basic') return output;

            const contentLimit = limits.contentLimit[plan] || limits.contentLimit.basic;
            const contentContainer = document.querySelector('article') || document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
            
            const clone = contentContainer.cloneNode(true);
            clone.querySelectorAll('script, style, nav, header, footer, form, [role="region"], [role="dialog"], ul, ol, comment, .comments').forEach(el => el.remove());
            
            let rawContent = clone.innerText.replace(/\s+/g, ' ').trim();
            output.pageContent = contentLimit ? rawContent.substring(0, contentLimit) : rawContent;

            output.images = Array.from(document.querySelectorAll('img[src]'))
                .map(img => img.src)
                .filter(src => src && !src.includes('data:image'))
                .slice(0, limits.imageLimit[plan] || 10);

            output.links = Array.from(contentContainer.querySelectorAll('a[href]'))
                .map(a => ({ text: a.innerText.trim().substring(0, 100), href: a.href }))
                .filter(link => link.href && link.href.startsWith('http'))
                .slice(0, 50);

            return output;
        }, plan, limits);

        result.thumbnail = data.ogImage || 'https://via.placeholder.com/640x360?text=No+Thumbnail+Found';
        result.title = data.ogTitle || data.pageTitle || 'Başlıq tapılmadı';
        result.description = data.ogDesc || 'Təsvir tapılmadı';

        if (plan !== 'basic') {
            result.deepData.pageContent = data.pageContent;
            result.deepData.images = data.images;
            result.deepData.links = data.links || [];
        }

        return result;
    } catch (error) {
        result.deepData.error = `SƏHİFƏ XƏTASI: ${error.message}`;
        return result;
    } finally {
        if (browser) await browser.close();
    }
}

app.post('/extract', async (req, res) => {
    const apiKeyCheck = checkApiKey(req);  
    if (!apiKeyCheck) {                     
        return res.status(401).json({ error: "Invalid API key" });                    
    }

    const url = req.body?.url || req.query.url;
    if (!url || typeof url !== 'string' || url.trim() === '') {
        return res.status(400).json({ error: 'URL sahəsi boş ola bilməz.' });
    }

    let urlObj;
    try {
        urlObj = new URL(url);
        if (!ALLOWED_URL_SCHEMES.includes(urlObj.protocol)) {
            return res.status(400).json({ error: `Yanlış protokol.` });
        }
        if (isPrivateOrBlockedIP(urlObj.hostname)) {
            return res.status(403).json({ error: 'Təhlükəsizlik Xətası (SSRF): Daxili IP-lər bloklanmışdır.' });
        }
    } catch (e) {
        return res.status(404).json({ status: "error", message: "Yanlış URL formatı" });
    }

    const rawPlanInput = req.body?.plan || req.query.plan || 'basic';
    const userPlan = String(rawPlanInput).toLowerCase();
    
    const rate = await checkRateLimit(req.headers['x-rapidapi-user'] || 'guest', userPlan);
    if (!rate.allowed) {
        return res.status(429).json({ status: "rate_limit_exceeded", message: "Gündəlik limit bitib." });
    }

    try {
        const deepResult = await extractDeepData(url, userPlan);

        if (deepResult.deepData?.error || !deepResult.title || deepResult.title === 'Başlıq tapılmadı') {
            return res.status(404).json({
                status: "error",
                plan_type: userPlan,
                message: deepResult.deepData?.error || "Səhifə və ya məzmun tapılmadı"
            });
        }

        return res.status(200).json({
            status: 'ok',
            plan_type: userPlan,
            name: cleanText(deepResult.title),
            description: cleanText(deepResult.description),
            thumbnail_url: deepResult.thumbnail,
            deep_data: deepResult.deepData
        });
        
    } catch (error) {
        return res.status(500).json({ status: 'error', error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Ümumi Veb Hörümçək API işləyir: http://0.0.0.0:${PORT}`);
});
