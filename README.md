# Smart Content Extractor API — modular source layout
## Qovluq strukturu

- `src/parts/01-...js` — runtime və konfiqurasiya
- `src/parts/02-...js` — monitoring, middleware, auth və planlar
- `src/parts/03-...js` — request context və timeout
- `src/parts/04-...js` — SSRF, DNS və redirect təhlükəsizliyi
- `src/parts/05-...js` — mətn, şəkil, URL və embed sanitizasiyası
- `src/parts/06-...js` — video aşkarlanması və xətalar
- `src/parts/07-...js` — cavab ölçüsü və sanitizasiya
- `src/parts/08-...js` — browser queue və lifecycle
- `src/parts/09-...js` — əsas Puppeteer scraper mühərriki
- `src/parts/10-...js` — request validation və health
- `src/parts/11-...js` — API endpoint-ləri
- `src/parts/12-...js` — graceful shutdown və exports

## Lokal işə salma

1. Node.js 20+ quraşdırın.
2. `npm install`
3. `.env.example` faylını `.env` adı ilə kopyalayın və gizli dəyərləri doldurun.
4. `npm run check`
5. `npm start`

`npm start` əvvəlcə 12 hissəni `dist/index.js` faylında birləşdirir, sonra serveri başladır. `dist/index.js` avtomatik yaradılır; onu əl ilə redaktə etməyin.

## Render

- Build Command: `npm install`
- Start Command: `npm start`
- Node: 20 və ya daha yeni
- Environment Variables: `.env.example` faylındakı dəyişənləri Render-də ayrıca təyin edin.

**Vacib:** `ENFORCE_GATEWAY_AUTH=true` etdikdə RapidAPI proxy secret və admin test secret düzgün təyin edilməlidir. Əks halda sorğular 403 qaytara bilər. Secret dəyərlərini GitHub-a yükləməyin.

## Qeydlər

Bu mərhələdə əsas məqsəd risksiz modul bölünməsidir. 12 hissə build zamanı eyni lexical scope-da birləşdirilir; buna görə əvvəlki kodun daxili funksiyalararası əlaqələri pozulmur. Production-da deploy etməzdən əvvəl real Render/RapidAPI testləri, SSRF testləri, yük testi və plan kvotalarının yoxlanması yenə vacibdir.
