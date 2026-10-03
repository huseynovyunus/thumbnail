'use strict';

// ==================================================================
// ASILILIQLAR
// ==================================================================
require('dotenv').config();

const dns = require('dns').promises;
const net = require('net');
const express = require('express');
const axios = require('axios');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
app.disable('x-powered-by');

// ==================================================================
// KONFİQURASİYA
// ==================================================================
const PORT = process.env.PORT || 3000;
const DAY_MS = 86_400_000;

const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

const ALLOWED_URL_SCHEMES = ['http:', 'https:'];
const BLOCKED_HOSTS_EXACT = ['localhost', '0.0.0.0', 'metadata.google.internal'];
const PRIVATE_IPV4_RANGES = [
    ['0.0.0.0', '0.255.255.255'],       // "Bu şəbəkə"
    ['10.0.0.0', '10.255.255.255'],     // Class A Private
    ['100.64.0.0', '100.127.255.255'],  // Carrier-grade NAT
    ['127.0.0.0', '127.255.255.255'],   // Loopback
    ['169.254.0.0', '169.254.255.255'], // Link-local (bulud metadata serverləri)
    ['172.16.0.0', '172.31.255.255'],   // Class B Private
    ['192.168.0.0', '192.168.255.255'], // Class C Private
];

const BLOCKED_RESOURCE_TYPES = new Set(['image', 'font', 'media', 'stylesheet']);
const SENSITIVE_HEADERS = ['authorization', 'x-api-key', 'x-rapidapi-key', 'x-rapidapi-proxy-secret', 'cookie'];
const URL_FIELDS = ['url', 'targetUrl', 'target_url', 'link', 'URL'];

const PROXY_LIST = (process.env.PROXY_LIST || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

const placeholder = (text) => `https://placehold.co/640x360?text=${encodeURIComponent(text)}`;

// ==================================================================
// PLANLAR
// ==================================================================
const PRICING_PLANS = {
    BASIC: {
        name: 'Basic',
        internal: 'basic',
        accessLevel: 0,
        dailyLimit: 50,
        monthlyLimit: 1500,
        price: 0,
        features: ['Thumbnail çıxarışı', 'Başlıq', 'Müəllif məlumatı', 'Əsas metadata'],
    },
    PRO: {
        name: 'Pro',
        internal: 'pro',
        accessLevel: 1,
        dailyLimit: 1000,
        monthlyLimit: 30000,
        price: 19.99,
        features: ['Basic xüsusiyyətləri', 'OpenGraph məlumatları', 'Səhifə təsviri', 'Əsas mətn çıxarışı'],
    },
    ULTRA: {
        name: 'Ultra',
        internal: 'ultra',
        accessLevel: 2,
        dailyLimit: 10000,
        monthlyLimit: 300000,
        price: 79.99,
        features: ['Pro xüsusiyyətləri', 'Tam səhifə məzmunu', 'Şəkillərin çıxarılması', 'Linklərin çıxarılması', 'Video mənbələri'],
    },
    MEGA: {
        name: 'Mega',
        internal: 'mega',
        accessLevel: 3,
        dailyLimit: 50000,
        monthlyLimit: 1500000,
        price: 249.99,
        features: ['Ultra xüsusiyyətləri', 'Prioritet emal', 'Yüksək sorğu limiti', 'Böyük layihələr üçün istifadə'],
    },
};

// null = limitsiz
const PLAN_CONTENT_LIMITS = {
    basic: { content: 500, paragraphs: 10, images: 10 },
    pro: { content: 5000, paragraphs: 50, images: 50 },
    ultra: { content: 10000, paragraphs: 200, images: 200 },
    mega: { content: 100000, paragraphs: null, images: null },
};

const PLAN_ACCESS = { basic: 0, pro: 1, ultra: 2, mega: 3 };
const DEFAULT_PLAN = 'basic';

function getPlanConfig(plan) {
    return PRICING_PLANS[String(plan).toUpperCase()] || PRICING_PLANS.BASIC;
}

function normalizePlan(value) {
    const text = String(value ?? '').toLowerCase();
    if (text.includes('mega')) return 'mega';
    if (text.includes('ultra')) return 'ultra';
    if (text.includes('pro')) return 'pro';
    if (text.includes('basic')) return 'basic';
    return null;
}

// ==================================================================
// BODY PARSER (400 xətasının həlli)
// Bütün formatları qəbul edir: JSON, form, multipart, adi mətn, yalnız link
// ==================================================================
app.use(express.text({ type: () => true, limit: '50mb' }));
app.use(parseFlexibleBody);

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseMultipart(raw) {
    const output = {};
    const pattern = /name="([^"]+)"[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*?\r?\n([^\r\n]*)/g;
    let match;
    while ((match = pattern.exec(raw)) !== null) {
        output[match[1]] = match[2].trim();
    }
    return output;
}

function parseRawBody(raw, contentType) {
    if (contentType.includes('multipart/form-data')) {
        return parseMultipart(raw);
    }
    try {
        const parsed = JSON.parse(raw);
        if (isPlainObject(parsed)) return parsed;
        if (typeof parsed === 'string') return { url: parsed };
    } catch {
        // JSON deyil, digər formatları yoxlayırıq
    }
    if (/^https?:\/\//i.test(raw)) return { url: raw };
    if (raw.includes('=')) return Object.fromEntries(new URLSearchParams(raw));
    return { url: raw };
}

function parseFlexibleBody(req, res, next) {
    const raw = typeof req.body === 'string' ? req.body.trim() : '';
    if (!raw) {
        req.body = isPlainObject(req.body) ? req.body : {};
        return next();
    }
    req.body = parseRawBody(raw, String(req.headers['content-type'] || '').toLowerCase());
    next();
}

// ==================================================================
// LOQLAMA (açarlar gizlədilir)
// ==================================================================
function maskHeaders(headers) {
    const copy = { ...headers };
    for (const name of SENSITIVE_HEADERS) {
        if (copy[name]) copy[name] = '***';
    }
    return copy;
}

app.use((req, res, next) => {
    console.log('\n=== REQUEST DETAILS ===');
    console.log('Method:', req.method);
    console.log('URL:', req.originalUrl);
    console.log('Content-Type:', req.headers['content-type']);
    console.log('Query:', req.query);
    console.log('Body:', JSON.stringify(req.body).slice(0, 1000));
    console.log('Headers:', maskHeaders(req.headers));
    console.log('=======================\n');
    next();
});

// ==================================================================
// AUTENTİFİKASİYA
// ==================================================================
function getAllowedKeys() {
    return (process.env.API_KEYS || '')
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean);
}

function authenticate(req) {
    const rapidUser = req.headers['x-rapidapi-user'];

    // 1. RapidAPI sorğusu
    if (rapidUser) {
        // RAPIDAPI_PROXY_SECRET təyin olunubsa, saxta RapidAPI başlıqları bloklanır
        const expectedSecret = process.env.RAPIDAPI_PROXY_SECRET;
        if (expectedSecret && req.headers['x-rapidapi-proxy-secret'] !== expectedSecret) {
            console.log('RapidAPI proxy secret yanlışdır');
            return null;
        }
        console.log('RapidAPI sorğusu qəbul edildi:', rapidUser, '| Plan:', req.headers['x-rapidapi-subscription']);
        return {
            source: 'rapidapi',
            user: String(rapidUser),
            subscription: req.headers['x-rapidapi-subscription'],
        };
    }

    // 2. Birbaşa sorğu (Postman -> Render)
    const rawHeader = req.headers['x-api-key'] || req.headers['authorization'];
    if (!rawHeader) {
        console.log('API KEY tapılmadı');
        return null;
    }

    const apiKey = String(rawHeader).replace(/^(Bearer|Key)\s+/i, '').trim();
    if (!getAllowedKeys().includes(apiKey)) {
        console.log('Birbaşa API açarı səhvdir');
        return null;
    }

    console.log('Birbaşa API açarı qəbul edildi');
    return { source: 'direct', user: `key:${apiKey.slice(0, 4)}***` };
}

function resolvePlan(auth, req) {
    const requested =
        auth.source === 'rapidapi'
            ? auth.subscription
            : req.body?.planType ?? req.query?.planType;
    return normalizePlan(requested) || DEFAULT_PLAN;
}

// ==================================================================
// RATE LIMIT (hər planın öz gündəlik limiti)
// ==================================================================
const rateLimits = new Map();

function checkRateLimit(userId, plan) {
    const limit = getPlanConfig(plan).dailyLimit;
    const key = userId || 'guest';
    const now = Date.now();

    let entry = rateLimits.get(key);
    if (!entry || now - entry.createdAt > DAY_MS) {
        entry = { count: 0, createdAt: now };
        rateLimits.set(key, entry);
    }

    entry.count++;

    if (entry.count > limit) {
        return {
            allowed: false,
            limit,
            remaining: 0,
            retryAfter: Math.ceil((entry.createdAt + DAY_MS - now) / 1000),
        };
    }
    return { allowed: true, limit, remaining: limit - entry.count };
}

// ==================================================================
// SSRF MÜDAFİƏSİ
// ==================================================================
function ipv4ToLong(ip) {
    return ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
}

function isPrivateIPv4(ip) {
    const value = ipv4ToLong(ip);
    return PRIVATE_IPV4_RANGES.some(([start, end]) => value >= ipv4ToLong(start) && value <= ipv4ToLong(end));
}

function isPrivateIPv6(ip) {
    const value = ip.toLowerCase();
    if (value === '::' || value === '::1') return true;
    if (value.startsWith('::ffff:')) {
        const mapped = value.slice(7);
        return net.isIPv4(mapped) ? isPrivateIPv4(mapped) : true;
    }
    return /^(fc|fd|fe8|fe9|fea|feb)/.test(value);
}

function isPrivateIP(ip) {
    if (net.isIPv4(ip)) return isPrivateIPv4(ip);
    if (net.isIPv6(ip)) return isPrivateIPv6(ip);
    return false;
}

function cleanHostname(hostname) {
    return String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
}

function isBlockedHostLiteral(hostname) {
    const host = cleanHostname(hostname);
    if (BLOCKED_HOSTS_EXACT.includes(host) || host.endsWith('.localhost')) return true;
    return net.isIP(host) ? isPrivateIP(host) : false;
}

// Domen adının daxili IP-yə yönəlib-yönəlmədiyini də yoxlayır
async function isBlockedHost(hostname) {
    if (isBlockedHostLiteral(hostname)) return true;
    const host = cleanHostname(hostname);
    if (net.isIP(host)) return false;
    try {
        const records = await dns.lookup(host, { all: true });
        return records.some((record) => isPrivateIP(record.address));
    } catch {
        return false; // DNS tapılmasa, səhifə yüklənməsi özü xəta verəcək
    }
}

function isBlockedRequestUrl(requestUrl) {
    try {
        const parsed = new URL(requestUrl);
        return ALLOWED_URL_SCHEMES.includes(parsed.protocol) && isBlockedHostLiteral(parsed.hostname);
    } catch {
        return false;
    }
}

// ==================================================================
// URL KÖMƏKÇİLƏRİ
// ==================================================================
function getUrlFromRequest(req) {
    for (const source of [req.body || {}, req.query || {}]) {
        for (const field of URL_FIELDS) {
            const value = source[field];
            if (typeof value === 'string' && value.trim()) return value.trim();
        }
    }
    return null;
}

async function validateTargetUrl(rawUrl) {
    // "example.com" kimi protokolsuz linklərə avtomatik https:// əlavə olunur
    const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;

    let parsed;
    try {
        parsed = new URL(candidate);
    } catch (error) {
        return { ok: false, status: 400, body: { status: 'error', error: `URL-i emal etmək mümkün olmadı: ${error.message}` } };
    }

    if (!ALLOWED_URL_SCHEMES.includes(parsed.protocol)) {
        return {
            ok: false,
            status: 400,
            body: { status: 'error', error: `Yanlış protokol. Yalnız ${ALLOWED_URL_SCHEMES.join(' və ')} dəstəklənir.` },
        };
    }

    if (await isBlockedHost(parsed.hostname)) {
        return {
            ok: false,
            status: 403,
            body: {
                status: 'error',
                error: 'Təhlükəsizlik Xətası (SSRF): Daxili, private və lokal host IP-lər bloklanmışdır.',
                hostname: parsed.hostname,
            },
        };
    }

    return { ok: true, url: parsed.href };
}

function getRandomProxy() {
    if (PROXY_LIST.length === 0) return null;
    return PROXY_LIST[Math.floor(Math.random() * PROXY_LIST.length)];
}

// ==================================================================
// GITHUB
// ==================================================================
async function extractGitHubFileData(url) {
    try {
        const parsed = new URL(url);
        if (!parsed.hostname.endsWith('github.com')) return null;

        const parts = parsed.pathname.split('/').filter(Boolean);
        if (parts.length < 5 || !['blob', 'edit', 'tree'].includes(parts[2])) return null;

        const [owner, repo, , branch] = parts;
        const filePath = parts.slice(4).join('/');
        const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;

        console.log(`[GitHub]: ${owner}/${repo} | Branch: ${branch} | File: ${filePath}`);

        // Məzmun həmişə mətn kimi oxunur (JSON fayllar da daxil)
        const response = await axios.get(rawUrl, {
            timeout: 15000,
            responseType: 'text',
            transformResponse: [(data) => data],
        });

        const text = String(response.data || '');
        const fileName = filePath.split('/').pop() || 'file';
        const preview = text.replace(/\s+/g, ' ').trim().slice(0, 500);

        return {
            title: `${owner}/${repo} - ${fileName}`,
            description: preview || 'GitHub faylı məzmunu',
            thumbnail: 'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png',
            is_video: false,
            embedHtml: null,
        };
    } catch (error) {
        console.error(`[GitHub]: Fayl çıxarılmadı: ${error.message}`);
        return null;
    }
}

// ==================================================================
// OEMBED EXTRACTOR-LAR
// ==================================================================
async function extractVimeoData(url) {
    try {
        const { data } = await axios.get(
            `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`,
            { timeout: 5000 }
        );
        if (!data || (!data.thumbnail_url && !data.html)) return null;
        return {
            thumbnail: data.thumbnail_url,
            title: data.title,
            description: data.description || 'OEmbed vasitəsilə çıxarılıb.',
            embedHtml: data.html,
            is_video: true,
        };
    } catch {
        return null;
    }
}

async function extractYouTubeData(url) {
    const videoId = url.match(/(?:v=|\/embed\/|youtu\.be\/|\/v\/|\/vi\/|\/shorts\/)([A-Za-z0-9_-]{11})/)?.[1];
    if (!videoId) {
        console.log('[YouTube]: Video ID tapılmadı:', url);
        return null;
    }

    try {
        const { data } = await axios.get(
            `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
            { timeout: 8000, headers: { 'User-Agent': USER_AGENT } }
        );
        return {
            thumbnail: data.thumbnail_url,
            title: data.title,
            description: `${data.author_name} tərəfindən. Kanal: ${data.provider_name}`,
            embedHtml: `<div class="aspect-w-16 aspect-h-9">${data.html}</div>`,
            is_video: true,
        };
    } catch {
        console.log('[YouTube]: OEmbed alınmadı, fallback istifadə olunur:', videoId);
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
    try {
        const { data } = await axios.get(
            `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`,
            { timeout: 5000 }
        );
        return {
            thumbnail: data.thumbnail_url,
            title: data.title || 'TikTok Videosu',
            description: data.author_name ? `${data.author_name} tərəfindən.` : 'TikTok məzmunu',
            embedHtml: data.html || null,
            is_video: true,
        };
    } catch {
        return {
            thumbnail: placeholder('TikTok Content'),
            title: 'TikTok Məzmunu (OEmbed Xətası)',
            description: 'TikTok məzmunu (API vasitəsilə çıxarılmadı).',
            embedHtml: null,
            is_video: true,
        };
    }
}

// Instagram OEmbed tez-tez bloklanır, ona görə dərhal fallback qaytarılır
async function extractInstagramData() {
    return {
        thumbnail: placeholder('Instagram Post'),
        title: 'Instagram Postu/Videosu',
        description: 'Instagram məzmunu. Dərin çıxarış tələb oluna bilər.',
        embedHtml: null,
        is_video: true,
    };
}

async function extractDailyMotionData(url) {
    try {
        const { data } = await axios.get(
            `https://www.dailymotion.com/services/oembed?url=${encodeURIComponent(url)}`,
            { timeout: 5000 }
        );
        return {
            thumbnail: data.thumbnail_url,
            title: data.title || 'DailyMotion Videosu',
            description: data.author_name ? `${data.author_name} tərəfindən.` : 'DailyMotion məzmunu',
            embedHtml: data.html,
            is_video: true,
        };
    } catch {
        return null;
    }
}

async function getOembedData(url) {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes('youtube.com') || host.includes('youtu.be')) return extractYouTubeData(url);
    if (host.includes('instagram.com')) return extractInstagramData(url);
    if (host.includes('tiktok.com')) return extractTikTokData(url);
    if (host.includes('dailymotion.com')) return extractDailyMotionData(url);
    return extractVimeoData(url);
}

// ==================================================================
// PUPPETEER
// ==================================================================
async function buildLaunchConfig() {
    const executablePath = await chromium.executablePath();
    if (!executablePath) throw new Error('Chromium path boş qaytarıldı');
    console.log('Chromium path:', executablePath);

    const args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gl-drawing-for-tests'];

    const proxy = getRandomProxy();
    if (proxy) {
        console.log(`[Puppeteer]: Proksi istifadə olunur: ${proxy}`);
        args.push(`--proxy-server=${proxy}`);
    }

    return {
        args,
        headless: true,
        defaultViewport: chromium.defaultViewport ?? { width: 1280, height: 800 },
        executablePath,
        ignoreHTTPSErrors: true,  // köhnə Puppeteer versiyaları üçün
        acceptInsecureCerts: true, // yeni Puppeteer versiyaları üçün
        timeout: 120000,
    };
}

async function launchBrowserWithRetry(launchConfig, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const browser = await puppeteer.launch(launchConfig);
            console.log(`[Puppeteer]: Browser işə salındı (Cəhd ${attempt}).`);
            return browser;
        } catch (error) {
            console.warn(`[Puppeteer]: Launch xətası (Cəhd ${attempt}/${maxRetries}): ${error.message}`);
            if (attempt === maxRetries) throw error;
            const delay = 1000 * 2 ** (attempt - 1);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
    throw new Error('Browser işə salınmadı');
}

async function preparePage(page, url) {
    // Sürət üçün şəkil/font/media/CSS bloklanır, daxili ünvanlara yönləndirmələr də bloklanır
    await page.setRequestInterception(true);
    page.on('request', (request) => {
        if (BLOCKED_RESOURCE_TYPES.has(request.resourceType()) || isBlockedRequestUrl(request.url())) {
            request.abort().catch(() => {});
            return;
        }
        request.continue().catch(() => {});
    });

    // Bot aşkarlanmasının qarşısını almaq üçün manual fikslər
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'az'] });

        if (navigator.permissions && navigator.permissions.query) {
            const originalQuery = navigator.permissions.query.bind(navigator.permissions);
            navigator.permissions.query = (parameters) =>
                parameters.name === 'notifications' && typeof Notification !== 'undefined'
                    ? Promise.resolve({ state: Notification.permission })
                    : originalQuery(parameters);
        }

        Object.defineProperty(HTMLCanvasElement.prototype, 'toDataURL', {
            value: () =>
                'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAASwAAACWCAYAAABap0dnAAABiklEQVR4Xu3WMQEAIAIEwHj/p0R9ZtDBGeLNAgAAAAAAAAB2X9f1AQAAAAAAAACAVw4AAAAAAAAAAMCtBgAAAAAAAAAAgFsNAAAAAA',
        });
    });

    await page.setExtraHTTPHeaders({
        'Accept-Language': 'az-AZ,en-US,en;q=0.9,ru;q=0.8',
        Referer: url,
    });
    await page.setUserAgent(USER_AGENT);
}

// Bu funksiya brauzerin içində işləyir, xaricdəki dəyişənlərə toxunmamalıdır
function scrapePage({ limits, includeMedia }) {
    const meta = (selector) => document.querySelector(selector)?.content || null;
    const unique = (items) => [...new Set(items)];
    const toAbsolute = (href) => {
        try {
            return new URL(href, document.location.href).href;
        } catch {
            return null;
        }
    };
    const applyLimit = (items, limit) => (limit ? items.slice(0, limit) : items);

    const output = {
        ogImage: meta('meta[property="og:image"]'),
        ogTitle: meta('meta[property="og:title"]'),
        ogDesc: meta('meta[property="og:description"]') || meta('meta[name="description"]'),
        pageTitle: document.title || null,
        fallbackImage:
            Array.from(document.querySelectorAll('img[src]'))
                .map((img) => img.src)
                .find((src) => src && !src.startsWith('data:image') && src.length > 5) || null,
    };

    // Mətn
    const paragraphs = unique(
        Array.from(document.querySelectorAll('p, li, article p, main p, div[role="main"] p, section > p, [data-testid*="content"]'))
            .map((node) => (node.innerText || '').trim())
            .filter((text) => text.length > 50 && text.length < 500)
    );
    output.pageContent = applyLimit(paragraphs, limits.paragraphs).join('\n\n').substring(0, limits.content);

    // Şəkillər
    const images = unique(
        Array.from(document.querySelectorAll('img[src], img[srcset], source[src], source[srcset]'))
            .flatMap((el) => {
                const sources = [];
                if (el.src) sources.push(el.src);
                const srcset = el.getAttribute('srcset');
                const firstSrcset = srcset?.match(/^\s*([^,\s]+)/)?.[1];
                if (firstSrcset) sources.push(firstSrcset);
                return sources;
            })
            .filter((src) => src && !src.startsWith('data:image'))
            .map(toAbsolute)
            .filter(Boolean)
    );
    output.images = applyLimit(images, limits.images);

    // Yalnız Ultra və Mega: linklər və video mənbələri
    output.links = [];
    output.videoSources = [];
    if (includeMedia) {
        const seen = new Set();
        output.links = Array.from(document.querySelectorAll('a[href]'))
            .map((a) => {
                const href = toAbsolute(a.getAttribute('href'));
                if (!href || !/^https?:/i.test(href) || seen.has(href)) return null;
                seen.add(href);
                return {
                    text: (a.innerText || '').trim().substring(0, 100) || new URL(href).hostname,
                    href,
                };
            })
            .filter(Boolean);

        output.videoSources = unique(
            Array.from(document.querySelectorAll('video[src], audio[src], iframe[src], iframe[srcdoc]'))
                .map((el) => el.src || el.getAttribute('srcdoc'))
                .filter(Boolean)
        );
    }

    return output;
}

async function extractDeepData(url, plan) {
    const limits = PLAN_CONTENT_LIMITS[plan] || PLAN_CONTENT_LIMITS[DEFAULT_PLAN];
    const includeMedia = PLAN_ACCESS[plan] >= PLAN_ACCESS.ultra;

    const result = {
        title: null,
        description: null,
        thumbnail: null,
        launchFailed: false,
        deepData: {
            plan,
            error: null,
            pageContent: null,
            images: [],
            links: [],
            videoSources: [],
            has_video_sources: false,
            stealth_mode_enabled: false,
        },
    };

    console.log(`[Puppeteer]: '${plan}' planı üçün dərin çıxarma başlayır.`);

    let browser = null;
    try {
        const launchConfig = await buildLaunchConfig();
        browser = await launchBrowserWithRetry(launchConfig);
    } catch (error) {
        console.error('[Puppeteer]: Launch xətası:', error.message);
        result.launchFailed = true;
        result.deepData.error = `PUPPETEER LAUNCH CRITICAL ERROR: ${error.message}`;
        return result;
    }

    try {
        const page = await browser.newPage();
        await preparePage(page, url);

        console.log(`[Puppeteer]: URL-ə keçid edilir: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

        await page
            .waitForSelector('meta[property="og:title"], h1, h2, title, body', { timeout: 10000 })
            .catch(() => console.warn('[Puppeteer]: Əsas element 10 saniyədə tapılmadı, davam edilir.'));

        const data = await page.evaluate(scrapePage, { limits, includeMedia });

        result.title = data.ogTitle || data.pageTitle;
        result.description = data.ogDesc;
        result.thumbnail = data.ogImage || data.fallbackImage;

        Object.assign(result.deepData, {
            pageContent: data.pageContent,
            images: data.images,
            links: data.links,
            videoSources: data.videoSources,
            has_video_sources: data.videoSources.length > 0,
        });
    } catch (error) {
        console.error(`[Puppeteer]: Səhifə xətası (${url}): ${error.message}`);
        result.title = 'Səhifə yüklənmədi (Timeout/Bot Blok)';
        result.thumbnail = placeholder('Error Loading Page');
        result.deepData.error = `SƏHİFƏ XƏTASI: ${error.message}`;
    } finally {
        await browser.close().catch(() => {});
        console.log('[Puppeteer]: Browser bağlandı.');
    }

    return result;
}

// ==================================================================
// ƏSAS ÇIXARMA MƏNTİQİ
// ==================================================================
function getResponseStatus({ deepResult, title, thumbnail }) {
    if (deepResult.deepData.error) {
        return deepResult.launchFailed && !title ? 'critical_failed' : 'partial_success';
    }
    return title && thumbnail ? 'ok' : 'partial_success';
}

async function extractAll(url, plan) {
    const oembed = (await getOembedData(url)) || {};
    const deepResult = await extractDeepData(url, plan);

    const title = oembed.title || deepResult.title;
    const description = oembed.description || deepResult.description;
    const thumbnail = oembed.thumbnail || deepResult.thumbnail;

    return {
        status: getResponseStatus({ deepResult, title, thumbnail }),
        plan_type: plan,
        name: title || 'Başlıq tapılmadı',
        description: description || 'Təsvir tapılmadı',
        thumbnail_url: thumbnail || placeholder('No Thumbnail Found'),
        embed_html: oembed.embedHtml || null,
        is_video: Boolean(oembed.is_video || deepResult.deepData.has_video_sources),
        deep_data: deepResult.deepData,
    };
}

function buildGitHubResponse(githubData) {
    return {
        status: 'ok',
        plan_type: 'github',
        name: githubData.title,
        description: githubData.description,
        thumbnail_url: githubData.thumbnail,
        embed_html: githubData.embedHtml,
        is_video: githubData.is_video,
        deep_data: { plan: 'github', source: 'github_raw' },
    };
}

// ==================================================================
// ROUTE-LAR
// ==================================================================

// Health check
app.get('/', (req, res) => {
    res.json({ status: 'API is running', time: new Date().toISOString() });
});

// Əsas API (həm POST, həm GET ilə işləyir)
async function handleExtract(req, res) {
    const auth = authenticate(req);
    if (!auth) {
        return res.status(401).json({ status: 'error', error: 'Invalid API key' });
    }

    const rawUrl = getUrlFromRequest(req);
    if (!rawUrl) {
        return res.status(400).json({
            status: 'error',
            error: 'URL sahəsi tələb olunur.',
            hint: 'Body-də {"url": "https://..."} göndərin və ya ?url=https://... istifadə edin.',
        });
    }

    const validation = await validateTargetUrl(rawUrl);
    if (!validation.ok) {
        return res.status(validation.status).json(validation.body);
    }
    const url = validation.url;

    const plan = resolvePlan(auth, req);
    const rate = checkRateLimit(auth.user, plan);
    res.set('X-RateLimit-Limit', String(rate.limit));
    res.set('X-RateLimit-Remaining', String(rate.remaining));

    if (!rate.allowed) {
        res.set('Retry-After', String(rate.retryAfter));
        return res.status(429).json({
            status: 'rate_limit_exceeded',
            message: 'Gündəlik limit bitib.',
            retryAfter: rate.retryAfter,
        });
    }

    console.log(`Giriş: ${auth.user} | Mənbə: ${auth.source} | Plan: ${plan.toUpperCase()}`);

    try {
        const githubData = await extractGitHubFileData(url);
        if (githubData) {
            console.log('[API]: GitHub URL aşkarlandı');
            return res.status(200).json(buildGitHubResponse(githubData));
        }

        const responseBody = await extractAll(url, plan);
        return res.status(200).json(responseBody);
    } catch (error) {
        console.error('Ümumi API xətası:', error.message);
        return res.status(500).json({
            status: 'error',
            plan_type: plan,
            error: error.message,
            message: 'API xətası',
        });
    }
}

app.route('/extract').get(handleExtract).post(handleExtract);

// Admin panel
app.post('/admin-panel', (req, res) => {
    const auth = authenticate(req);
    if (!auth) {
        console.log('Admin panelə icazəsiz giriş');
        return res.status(401).json({ error: 'Unauthorized - Admin panel üçün API KEY lazımdır' });
    }

    console.log('Admin panelə giriş:', auth.user);
    res.json({
        message: 'Admin Panelinə POST sorğusu qəbul edildi.',
        user: auth.user,
        source: auth.source,
        data: req.body,
        query: req.query,
    });
});

// Planlar haqqında məlumat
app.get('/plans', (req, res) => {
    res.json({ plans: Object.values(PRICING_PLANS) });
});

// 404
app.use((req, res) => {
    res.status(404).json({ status: 'error', error: `Route tapılmadı: ${req.method} ${req.originalUrl}` });
});

// Ümumi xəta handler-i (server heç vaxt HTML xəta səhifəsi qaytarmır)
app.use((err, req, res, next) => {
    console.error('Gözlənilməz xəta:', err.message);
    if (res.headersSent) return next(err);
    const status = err.type === 'entity.too.large' ? 413 : err.status || 500;
    res.status(status).json({ status: 'error', error: err.message || 'Server xətası' });
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
});

// ==================================================================
// SERVERİN BAŞLADILMASI
// ==================================================================
app.listen(PORT, () => {
    console.log(`API işləyir: http://localhost:${PORT}`);
});
