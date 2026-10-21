// ====================================================================
// 🌐 ULTRA METADATA & DEEP SCRAPER API (Production Ready for GitHub & Render)
// ====================================================================

require('dotenv').config();

const express = require('express');
const axios = require('axios');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Sığorta Middleware: Əgər Content-Type headersiz xam body gələrsə oxuyuruq
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
    { start: '169.254.0.0', end: '169.254.255.255' } // AWS / Cloud metadata
];

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

// 🚀 PLAN LİMİTLƏRİ (Ultra və Mega üçün hər şey limitsizdir)
const PLAN_CONTENT_LIMITS = {
    contentLimit: {
        basic: 500,
        pro: 5000,
        ultra: null, // Limitsiz tam məqalə
        mega: null   // Limitsiz tam məqalə
    },
    paragraphLimit: {
        basic: 5,
        pro: 30,
        ultra: null, // Bütün paraqraflar
        mega: null   // Bütün paraqraflar
    },
    imageLimit: {
        basic: 3,
        pro: 30,
        ultra: null, // Bütün şəkillər
        mega: null   // Bütün şəkillər
    },
    linkLimit: {
        basic: 0,
        pro: 50,
        ultra: null, // Bütün keçid linkləri
        mega: null   // Bütün keçid linkləri
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
        .replace(/\[\d+\]/g, '')         // [1], [2] Vikipediya istinadlarını təmizləyir
        .replace(/\[[a-zA-Z]\]/g, '')
        .replace(/[\u200E\u200F\u200B\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// --------------------------------------------------------------------
// 🎯 PLATFORMA MƏLUMAT ÇIXARIŞLARI
// --------------------------------------------------------------------

// 1. YouTube (Lazımsız şablon yazılardan təmizlənmiş versiya)
async function extractYouTubeData(url) {
    const videoIdMatch = url.match(/(?:v=|\/embed\/|youtu\.be\/|\/v\/|\/vi\/|\/shorts\/)([A-Za-z0-9_-]{11})/);
    const videoId = videoIdMatch?.[1];
    if (!videoId) return {};

    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    try {
        const response = await axios.get(oembedUrl, { timeout: 8000, headers: { 'User-Agent': USER_AGENT } });
        const data = response.data;

        return {
            title: data.title || 'YouTube Videosu',
            description: `${data.author_name} (@${(data.author_url || '').split('/@')[1] || data.author_name})`,
            thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
            embedHtml: `<div class="aspect-w-16 aspect-h-9"><iframe width="560" height="315" src="https://www.youtube.com/embed/${videoId}" frameborder="0" allowfullscreen></iframe></div>`,
            is_video: true,
            author_name: data.author_name,
            author_url: data.author_url,
            resolved_url: `https://www.youtube.com/watch?v=${videoId}`
        };
    } catch {
        return {
            title: 'YouTube Videosu',
            description: 'YouTube video məzmunu',
            thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
            embedHtml: `<iframe width="560" height="315" src="https://www.youtube.com/embed/${videoId}" frameborder="0" allowfullscreen></iframe>`,
            is_video: true,
            resolved_url: `https://www.youtube.com/watch?v=${videoId}`
        };
    }
}

// 2. TikTok (Qısa vm/vt linklərini açan və tam linki təqdim edən)
async function extractTikTokData(url) {
    let targetUrl = url;
    if (targetUrl.includes('vm.tiktok.com') || targetUrl.includes('vt.tiktok.com') || targetUrl.includes('/t/')) {
        try {
            const redirect = await axios.get(targetUrl, {
                maxRedirects: 10,
                validateStatus: (s) => s >= 200 && s < 400,
                headers: { 'User-Agent': USER_AGENT }
            });
            const final = redirect.request?.res?.responseUrl || redirect.headers?.location || targetUrl;
            targetUrl = final.split('?')[0];
        } catch (e) {
            if (e.response?.headers?.location) {
                targetUrl = e.response.headers.location.split('?')[0];
            }
        }
    }

    try {
        const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(targetUrl)}`;
        const res = await axios.get(oembedUrl, { timeout: 8000, headers: { 'User-Agent': USER_AGENT } });
        const data = res.data;

        return {
            title: data.title || 'TikTok Videosu',
            description: data.author_name ? `@${data.author_unique_id || data.author_name}` : 'TikTok məzmunu',
            thumbnail: data.thumbnail_url,
            embedHtml: data.html || null,
            is_video: true,
            author_name: data.author_name,
            resolved_url: targetUrl
        };
    } catch {
        return {
            title: 'TikTok Videosu',
            description: 'TikTok məzmunu',
            thumbnail: 'https://via.placeholder.com/640x360?text=TikTok+Media',
            embedHtml: null,
            is_video: true,
            resolved_url: targetUrl
        };
    }
}

// 3. Instagram (Həm brauzer, həm paylaşma linki ilə TAM məlumat çıxarışı)
async function extractInstagramData(url) {
    try {
        // Hər cür linkdən (p, reel, reels, share/p və s.) shortcode çıxarırıq:
        const match = url.match(/(?:p|reel|reels|tv|share\/(?:p|reel))\/([A-Za-z0-9_-]+)/);
        const shortcode = match ? match[1] : null;

        if (!shortcode) return null;

        const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;
        const res = await axios.get(embedUrl, {
            timeout: 10000,
            headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9,az;q=0.8' }
        });
        const html = res.data || '';

        // Şəkil (High-Res Media)
        let thumbnail = null;
        const imgMatch = html.match(/class="EmbeddedMediaImage"[^>]*src="([^"]+)"/) || 
                         html.match(/<img[^>]+class="[^"]*EmbeddedMedia[^"]*"[^>]+src="([^"]+)"/);
        if (imgMatch && imgMatch[1]) {
            thumbnail = imgMatch[1].replace(/&amp;/g, '&');
        }

        // Müəllif
        let author = 'Instagram İstifadəçisi';
        const authorMatch = html.match(/class="UsernameText">([^<]+)<\/span>/) ||
                            html.match(/class="CaptionUsername"[^>]*>([^<]+)<\/a>/);
        if (authorMatch && authorMatch[1]) {
            author = authorMatch[1].trim();
        }

        // Tam Təsvir / Mətn (Caption)
        let caption = '';
        const captionMatch = html.match(/class="Caption"[^>]*>([\s\S]*?)<\/div>/);
        if (captionMatch && captionMatch[1]) {
            caption = captionMatch[1]
                .replace(/<br\s*[\/]?>/gi, '\n')
                .replace(/<[^>]+>/g, '')
                .trim();
        }

        if (!caption) {
            const metaDesc = html.match(/<meta[^>]*property="og:description"[^>]*content="([^"]*)"/i);
            if (metaDesc && metaDesc[1]) {
                caption = metaDesc[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
            }
        }

        const isVideo = url.includes('/reel') || html.includes('EmbeddedMediaVideo');
        const title = caption ? (caption.length > 80 ? caption.substring(0, 80) + '...' : caption) : `@${author} Instagram ${isVideo ? 'Reel' : 'Postu'}`;

        return {
            title: title,
            description: caption || `@${author} tərəfindən Instagram paylaşımı`,
            thumbnail: thumbnail || 'https://via.placeholder.com/640x360?text=Instagram+Media',
            embedHtml: `<iframe src="https://www.instagram.com/p/${shortcode}/embed" width="400" height="480" frameborder="0" scrolling="no"></iframe>`,
            is_video: isVideo,
            author_name: author,
            resolved_url: `https://www.instagram.com/p/${shortcode}/`,
            deepData: {
                author: author,
                shortcode: shortcode,
                pageContent: caption,
                images: thumbnail ? [thumbnail] : [],
                links: [], // İnstaqram login səhifəsindəki saxta 50 link təmizləndi!
                videoSources: [],
                has_video_sources: isVideo,
                type: isVideo ? 'reel' : 'post'
            }
        };
    } catch {
        const match = url.match(/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
        const sc = match ? match[1] : '';
        return {
            title: 'Instagram Postu / Reel',
            description: 'Instagram məzmunu',
            thumbnail: 'https://via.placeholder.com/640x360?text=Instagram+Post',
            embedHtml: sc ? `<iframe src="https://www.instagram.com/p/${sc}/embed" width="400" height="480" frameborder="0"></iframe>` : null,
            is_video: url.includes('/reel'),
            resolved_url: url
        };
    }
}

// 4. GitHub Raw File Handling
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
                embedHtml: null,
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
// 🌐 DƏRİN ÇIXARIŞ (Puppeteer / Chromium - Ümumi Saytlar və Vikipediya)
// --------------------------------------------------------------------

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
            has_video_sources: false
        }
    };

    let executablePath = await chromium.executablePath();
    if (!executablePath) {
        result.deepData.error = "Chromium path tapılmadı";
        return result;
    }

    // Render 512MB RAM üçün zəruri bayraqlar
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
        const responseObj = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

        if (responseObj && responseObj.status() >= 400) {
            result.deepData.error = `SƏHİFƏ XƏTASI: HTTP Status ${responseObj.status()}`;
            return result;
        }

        await new Promise(r => setTimeout(r, 1500));

        const data = await page.evaluate(async (currentPlan, limitsConfig) => {
            const out = {
                ogImage: null,
                ogTitle: null,
                ogDesc: null,
                pageTitle: null,
                pageContent: null,
                images: [],
                links: [],
                videoSources: [],
                has_video_sources: false
            };

            // Metadata
            const ogImg = document.querySelector('meta[property="og:image"]')?.content;
            if (ogImg) {
                try { out.ogImage = new URL(ogImg, document.location.href).href; } catch { out.ogImage = ogImg; }
            }
            out.ogTitle = document.querySelector('meta[property="og:title"]')?.content;
            out.ogDesc = document.querySelector('meta[property="og:description"]')?.content || document.querySelector('meta[name="description"]')?.content;
            out.pageTitle = document.title;

            // Plan limitləri
            const contentLimit = limitsConfig.contentLimit[currentPlan];
            const paragraphLimit = limitsConfig.paragraphLimit[currentPlan];
            const imageLimit = limitsConfig.imageLimit[currentPlan];
            const linkLimit = limitsConfig.linkLimit[currentPlan];

            // Əsas məzmun konteyneri (Vikipediya üçün #mw-content-text, digərləri üçün article/main/body)
            const mainEl = document.querySelector('#mw-content-text') || 
                           document.querySelector('article') || 
                           document.querySelector('main') || 
                           document.querySelector('[role="main"]') || 
                           document.body;

            const clone = mainEl.cloneNode(true);
            // Sayt naviqasiyası, footer, skript və reklamları təmizləyirik
            clone.querySelectorAll('script, style, nav, header, footer, noscript, .mw-editsection, .noprint, .navbox, .vertical-navbox, .catlinks, .printfooter, form, [role="region"], [role="dialog"]').forEach(e => e.remove());

            // Paraqrafları təmiz yığırıq
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
            out.pageContent = contentLimit ? fullText.substring(0, contentLimit) : fullText;

            // Şəkillər (Bütün şəkilləri çıxarırıq)
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

            // Media / Video mənbələri
            out.videoSources = Array.from(document.querySelectorAll('video[src], iframe[src]'))
                .map(el => el.src)
                .filter(Boolean)
                .filter((v, i, self) => self.indexOf(v) === i);
            out.has_video_sources = out.videoSources.length > 0;

            return out;
        }, plan, limits);

        result.thumbnail = data.ogImage || (data.images && data.images[0]) || 'https://via.placeholder.com/640x360?text=No+Thumbnail';
        result.title = data.ogTitle || data.pageTitle || 'Başlıq tapılmadı';
        result.description = data.ogDesc || (data.pageContent ? data.pageContent.substring(0, 200) + '...' : 'Təsvir tapılmadı');

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

// --------------------------------------------------------------------
// 📌 ƏSAS API ENDPOINT: POST /extract
// --------------------------------------------------------------------

app.post('/extract', async (req, res) => {
    const apiKeyCheck = checkApiKey(req);
    if (!apiKeyCheck) {
        return res.status(401).json({ error: "Invalid API key" });
    }

    const url = req.body?.url || req.query.url || req.body?.targetUrl || req.body?.target_url || req.body?.link;
    if (!url || typeof url !== 'string' || url.trim() === '') {
        return res.status(400).json({ error: 'URL sahəsi boş ola bilməz və ya tələb olunur.' });
    }

    let urlObj;
    try {
        if (/(https?:\/\/){2,}/i.test(url)) {
            return res.status(400).json({ status: "error", message: "Təkrarlanan protokol aşkarlandı" });
        }
        urlObj = new URL(url);
        if (!ALLOWED_URL_SCHEMES.includes(urlObj.protocol)) {
            return res.status(400).json({ error: 'Yalnız http və https protokolları dəstəklənir.' });
        }
        if (!urlObj.hostname.includes('.')) {
            return res.status(400).json({ status: "error", message: "Domen adı düzgün deyil" });
        }
        if (isPrivateOrBlockedIP(urlObj.hostname)) {
            return res.status(403).json({ error: 'Təhlükəsizlik Xətası (SSRF): Daxili IP-lər bloklanmışdır.' });
        }
    } catch (e) {
        return res.status(400).json({ status: "error", message: "Yanlış URL formatı" });
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
        return res.status(429).json({ status: "rate_limit_exceeded", message: "Gündəlik limit bitib." });
    }

    // 1. GitHub
    const githubData = await extractGitHubFileData(url);
    if (githubData) {
        return res.status(200).json({ status: 'ok', plan_type: user.plan, ...githubData });
    }

    const isYouTube = url.includes('youtube.com') || url.includes('youtu.be');
    const isInstagram = url.includes('instagram.com');
    const isTikTok = url.includes('tiktok.com');

    try {
        let result = {};

        if (isYouTube) {
            result = await extractYouTubeData(url);
        } else if (isInstagram) {
            // Instagram birbaşa təmiz zəngin məlumat qaytarır (Login divarsız)
            result = await extractInstagramData(url);
        } else if (isTikTok) {
            result = await extractTikTokData(url);
        } else {
            // Vikipediya və digər bütün saytlar üçün Puppeteer işə düşür
            result = await extractDeepData(url, user.plan);
        }

        // Təmizləmə
        result.title = cleanText(result.title);
        result.description = cleanText(result.description);
        if (result.deepData?.pageContent) {
            result.deepData.pageContent = cleanText(result.deepData.pageContent);
        }

        if (result.deepData?.error?.includes("HTTP Status 404") || (result.title === 'Başlıq tapılmadı' && !result.description)) {
            return res.status(404).json({
                status: "error",
                plan_type: user.plan,
                message: result.deepData?.error || "Səhifə və ya məzmun tapılmadı (404)"
            });
        }

        return res.status(200).json({
            status: 'ok',
            plan_type: user.plan,
            name: result.title || 'Başlıq tapılmadı',
            description: result.description || 'Təsvir tapılmadı',
            thumbnail_url: result.thumbnail || 'https://via.placeholder.com/640x360?text=No+Thumbnail',
            full_url: result.resolved_url || url,
            embed_html: result.embedHtml || null,
            is_video: result.is_video || false,
            deep_data: result.deepData || null
        });

    } catch (error) {
        return res.status(500).json({ status: 'error', plan_type: user.plan, error: error.message });
    }
});

// Admin Paneli
app.get('/admin-panel', (req, res) => {
    res.send("Admin Paneli: Sistem aktivdir.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`API işləyir: http://0.0.0.0:${PORT}`);
});
