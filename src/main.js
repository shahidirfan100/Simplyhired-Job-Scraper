// SimplyHired Job Scraper - Fast, Stealthy, Production-Ready
// Optimized for speed with advanced anti-detection techniques

import { Actor } from 'apify';
import {
    CheerioCrawler,
    Dataset,
    log,
    createCheerioRouter,
} from 'crawlee';
import { load as loadHtml } from 'cheerio';
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

// -----------------------------------------------------------------------------
// Globals
// -----------------------------------------------------------------------------
let pagesProcessed = 0;
let savedJobs = 0;
let buildId = null;

// -----------------------------------------------------------------------------
// Stealth Configuration
// -----------------------------------------------------------------------------
const headerGenerator = new HeaderGenerator({
    browsers: [
        { name: 'chrome', minVersion: 120, maxVersion: 131 },
        { name: 'firefox', minVersion: 115, maxVersion: 130 },
    ],
    devices: ['desktop'],
    operatingSystems: ['windows', 'macos'],
    locales: ['en-US', 'en-GB', 'en'],
});

// Realistic viewport sizes
const viewports = [
    { width: 1920, height: 1080 },
    { width: 1536, height: 864 },
    { width: 1440, height: 900 },
    { width: 1366, height: 768 },
    { width: 2560, height: 1440 },
];

const getRandomViewport = () => viewports[Math.floor(Math.random() * viewports.length)];

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
const absolute = (href) => {
    if (!href) return null;
    if (href.startsWith('http')) return href;
    if (href.startsWith('/')) return `https://www.simplyhired.com${href}`;
    return `https://www.simplyhired.com/${href}`;
};

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const randomDelay = (min, max) => Math.floor(min + Math.random() * (max - min));
const isBlockedStatus = (code) => code === 403 || code === 429 || code === 503;
const cleanText = (text) => (text || '').replace(/\s+/g, ' ').trim();

// Generate stealth headers - mimics real browser perfectly
const generateHeaders = (session, referer = 'https://www.simplyhired.com/') => {
    const viewport = session?.userData?.viewport || getRandomViewport();
    const headers = headerGenerator.getHeaders();

    // Extract Chrome version for sec-ch-ua
    const chromeMatch = headers['user-agent']?.match(/Chrome\/(\d+)/);
    const chromeVer = chromeMatch ? chromeMatch[1] : '131';

    return {
        ...headers,
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'accept-encoding': 'gzip, deflate, br',
        'cache-control': 'max-age=0',
        'sec-ch-ua': `"Chromium";v="${chromeVer}", "Google Chrome";v="${chromeVer}", "Not_A Brand";v="24"`,
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': referer.includes('simplyhired.com') ? 'same-origin' : 'none',
        'sec-fetch-user': '?1',
        'upgrade-insecure-requests': '1',
        'referer': referer,
        // Viewport hints for additional stealth
        'viewport-width': String(viewport.width),
    };
};

// Fast fetch with got-scraping
const fetchWithGot = async (url, proxyUrl, session) => {
    const headers = generateHeaders(session, 'https://www.simplyhired.com/search');
    const res = await gotScraping({
        url,
        proxyUrl,
        timeout: { request: 25000 },
        retry: { limit: 0 },
        headers,
        http2: true,
        throwHttpErrors: false,
    });
    return { statusCode: res.statusCode, body: res.body?.toString?.() || '' };
};

// -----------------------------------------------------------------------------
// Data Extraction Functions
// -----------------------------------------------------------------------------
const extractFromNextData = (html) => {
    const $ = loadHtml(html);
    const script = $('#__NEXT_DATA__');
    if (!script.length) return { jobs: [], nextCursor: null, extractedBuildId: null };

    try {
        const json = JSON.parse(script.text());
        const extractedBuildId = json?.buildId || null;
        const pageProps = json?.props?.pageProps || {};
        const list = pageProps.jobs || [];
        const pageCursors = pageProps.pageCursors || {};

        const jobs = list.map((item) => {
            const title = item.title || '';
            const company = item.company || item.companyName || '';
            const location = item.location || item.formattedLocation || '';
            const salaryObj = item.salary || item.estimatedSalary || {};
            const salary = typeof salaryObj === 'object'
                ? cleanText([salaryObj.min && `$${salaryObj.min}`, salaryObj.max && `$${salaryObj.max}`, salaryObj.type].filter(Boolean).join(' - '))
                : cleanText(salaryObj);
            const link = item.viewJobLink || item.url || '';
            if (!title || !link) return null;
            return {
                title: cleanText(title),
                company: cleanText(company),
                location: cleanText(location),
                salary,
                job_type: cleanText(item.employmentType || ''),
                date_posted: cleanText(item.datePosted || item.formattedDate || ''),
                summary: cleanText(item.snippet || ''),
                link: absolute(link),
            };
        }).filter(Boolean);

        return { jobs, nextCursor: pageCursors['2'] || null, extractedBuildId };
    } catch {
        return { jobs: [], nextCursor: null, extractedBuildId: null };
    }
};

const extractJobsFromHtml = ($) => {
    const jobs = [];
    const jobCards = $('div[data-testid="searchSerpJob"], li[data-testid="itemListing"]');

    jobCards.each((_, el) => {
        const card = $(el);
        const titleEl = card.find('h2[data-testid="searchSerpJobTitle"], h2 a').first();
        const title = cleanText(titleEl.text());
        const link = titleEl.attr('href') || card.find('a[href*="/job/"]').first().attr('href');

        if (!title || !link) return;

        jobs.push({
            title,
            company: cleanText(card.find('span[data-testid="companyName"]').first().text()),
            location: cleanText(card.find('span[data-testid="jobLocation"]').first().text()),
            salary: cleanText(card.find('span[data-testid="jobSalaryInfo"]').first().text()),
            summary: cleanText(card.find('[data-testid="job-snippet"]').first().text()),
            link: absolute(link),
        });
    });

    const nextLink = $('a[aria-label="Next page"]').first();
    return { jobs, nextUrl: nextLink.length ? absolute(nextLink.attr('href')) : null };
};

const extractJobFromLdJson = ($) => {
    for (const el of $('script[type="application/ld+json"]').toArray()) {
        try {
            const json = JSON.parse($(el).text());
            const posting = Array.isArray(json) ? json.find((j) => j['@type'] === 'JobPosting') : json;
            if (posting?.['@type'] === 'JobPosting') {
                return {
                    title: cleanText(posting.title),
                    company: cleanText(posting.hiringOrganization?.name),
                    location: cleanText(
                        [posting.jobLocation?.address?.addressLocality, posting.jobLocation?.address?.addressRegion]
                            .filter(Boolean).join(', ')
                    ),
                    salary: cleanText(
                        posting.baseSalary?.value?.minValue && posting.baseSalary?.value?.maxValue
                            ? `$${posting.baseSalary.value.minValue}-${posting.baseSalary.value.maxValue}`
                            : posting.baseSalary?.value?.value ? `$${posting.baseSalary.value.value}` : ''
                    ),
                    date_posted: posting.datePosted || '',
                    description_html: posting.description || '',
                };
            }
        } catch { /* ignore */ }
    }
    return {};
};

const buildSearchUrl = (keyword, location) => {
    const params = new URLSearchParams();
    if (keyword) params.set('q', keyword.trim());
    if (location) params.set('l', location.trim());
    return `https://www.simplyhired.com/search?${params.toString()}`;
};

// -----------------------------------------------------------------------------
// Router
// -----------------------------------------------------------------------------
const router = createCheerioRouter();

router.addDefaultHandler(async ({ request, response, session, body, enqueueLinks, crawler, proxyInfo }) => {
    if (request.label === 'DETAIL') return;

    pagesProcessed++;
    const { maxJobs, maxPages } = crawler;
    if (pagesProcessed > maxPages || savedJobs >= maxJobs) return;

    let html = body?.toString?.() || '';
    let status = response?.statusCode;

    // Refetch if blocked
    if (isBlockedStatus(status) || html.length < 500) {
        await sleep(randomDelay(1000, 2000));
        session?.retire();
        const refetch = await fetchWithGot(request.url, proxyInfo?.url, session);
        status = refetch.statusCode;
        html = refetch.body;
    }

    if (isBlockedStatus(status)) throw new Error(`Blocked: ${status}`);

    log.info(`LIST ${pagesProcessed}: ${request.url.split('?')[0]}...`);

    // Extract jobs from __NEXT_DATA__
    const nextDataResult = extractFromNextData(html);
    if (nextDataResult.extractedBuildId && !buildId) {
        buildId = nextDataResult.extractedBuildId;
        log.info(`BuildId: ${buildId}`);
    }

    let jobs = nextDataResult.jobs;
    let nextCursor = nextDataResult.nextCursor;

    // Fallback to HTML
    if (!jobs.length) {
        const htmlResult = extractJobsFromHtml(loadHtml(html));
        jobs = htmlResult.jobs;
    }

    if (!jobs.length) {
        log.warning(`No jobs on page ${pagesProcessed}`);
        return;
    }

    const capacity = maxJobs - savedJobs;
    const limitedJobs = jobs.slice(0, capacity);

    // Enqueue detail pages
    const jobRequests = limitedJobs.map((job) => ({
        url: job.link,
        label: 'DETAIL',
        userData: { jobMeta: job },
    })).filter((r) => r.url);

    if (jobRequests.length) {
        await enqueueLinks({
            urls: jobRequests.map((r) => r.url),
            label: 'DETAIL',
            transformRequestFunction: (req) => {
                const meta = jobRequests.find((r) => r.url === req.url)?.userData?.jobMeta;
                req.userData = { jobMeta: meta, label: 'DETAIL' };
                return req;
            },
        });
        log.info(`Enqueued ${jobRequests.length} details`);
    }

    // Pagination
    if (savedJobs < maxJobs && pagesProcessed < maxPages && nextCursor) {
        const urlObj = new URL(request.url);
        urlObj.searchParams.set('cursor', nextCursor);
        await enqueueLinks({
            urls: [urlObj.toString()],
            label: 'LIST',
            transformRequestFunction: (req) => {
                req.userData = { label: 'LIST' };
                return req;
            },
        });
    }
});

router.addHandler('DETAIL', async ({ request, response, session, crawler, body, proxyInfo }) => {
    const meta = request.userData?.jobMeta || {};
    if (savedJobs >= crawler.maxJobs) return;

    let html = body?.toString?.() || '';
    let status = response?.statusCode;

    // Refetch if needed
    if (isBlockedStatus(status) || html.length < 500) {
        await sleep(randomDelay(500, 1500));
        session?.retire();
        const refetch = await fetchWithGot(request.url, proxyInfo?.url, session);
        status = refetch.statusCode;
        html = refetch.body;
    }

    // Even if blocked, save meta data
    const $page = loadHtml(html || '');
    const ld = status < 400 ? extractJobFromLdJson($page) : {};

    const title = cleanText(ld.title || $page('h1').first().text() || meta.title) || 'N/A';
    const company = cleanText(ld.company || $page('[data-testid="viewJobCompanyName"]').text() || meta.company) || 'N/A';
    const location = cleanText(ld.location || $page('[data-testid="viewJobCompanyLocation"]').text() || meta.location) || 'N/A';
    const salary = cleanText(ld.salary || $page('[data-testid="viewJobBodyJobCompensation"] [data-testid="detailText"]').text() || meta.salary) || '';

    const descContainer = $page('[data-testid="viewJobBodyJobFullDescriptionContent"]').first();
    const description_html = ld.description_html || descContainer.html() || meta.summary || '';
    const description_text = cleanText(ld.description_html ? loadHtml(ld.description_html).text() : descContainer.text()) || cleanText(meta.summary) || '';

    await Dataset.pushData({
        url: request.url,
        title,
        company,
        location,
        salary,
        job_type: cleanText(meta.job_type || $page('[data-testid="viewJobBodyJobDetailsJobType"] [data-testid="detailText"]').text()) || '',
        date_posted: cleanText(ld.date_posted || meta.date_posted || '') || '',
        description_text,
        description_html,
        source: 'SimplyHired',
        scraped_at: new Date().toISOString(),
    });

    savedJobs++;
    if (savedJobs % 10 === 0 || savedJobs === 1) {
        log.info(`Saved ${savedJobs}/${crawler.maxJobs}: ${title.substring(0, 40)}...`);
    }
});

// -----------------------------------------------------------------------------
// Main Entry
// -----------------------------------------------------------------------------
await Actor.init();
const input = (await Actor.getInput()) ?? {};

const maxJobs = input.results_wanted ?? 20;
const maxPages = input.max_pages ?? 5;

// Build start URL
let startUrl;
if (input.startUrls?.length) {
    startUrl = typeof input.startUrls[0] === 'string' ? input.startUrls[0] : input.startUrls[0].url;
} else {
    startUrl = buildSearchUrl(input.keyword || 'software engineer', input.location || 'USA');
}

// Proxy configuration
let proxyConfiguration;
try {
    proxyConfiguration = await Actor.createProxyConfiguration(
        input.proxyConfiguration || { useApifyProxy: true, groups: ['RESIDENTIAL'], countryCode: 'US' }
    );
} catch (err) {
    log.warning(`Residential proxy failed: ${err.message}, using datacenter`);
    proxyConfiguration = await Actor.createProxyConfiguration({ useApifyProxy: true });
}

// Optimized crawler settings
const crawler = new CheerioCrawler({
    proxyConfiguration,
    requestHandler: router,

    // Speed: Higher concurrency (8-10)
    maxConcurrency: 10,
    minConcurrency: 3,

    // Efficiency
    maxRequestsPerCrawl: maxJobs * 8,
    maxRequestRetries: 3,
    requestHandlerTimeoutSecs: 60,

    // Session management for stealth
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: {
        maxPoolSize: 100,
        sessionOptions: {
            maxUsageCount: 15,
            maxErrorScore: 1,
        },
    },

    // Pre-navigation: minimal delays, realistic headers
    preNavigationHooks: [
        async ({ request, session }) => {
            // Initialize session with viewport
            if (!session.userData.viewport) {
                session.userData.viewport = getRandomViewport();
            }

            // Minimal human-like delay (fast but not instant)
            const isDetail = request.userData?.label === 'DETAIL';
            await sleep(randomDelay(isDetail ? 100 : 50, isDetail ? 400 : 200));

            // Stealth headers
            const referer = isDetail
                ? 'https://www.simplyhired.com/search'
                : 'https://www.google.com/';
            request.headers = generateHeaders(session, referer);
        },
    ],

    // Error handling
    failedRequestHandler: async ({ request, error }) => {
        log.debug(`Failed: ${request.url.substring(0, 60)}... - ${error?.message}`);
    },
});

// Attach config
crawler.maxJobs = maxJobs;
crawler.maxPages = maxPages;

log.info(`Starting: ${maxJobs} jobs, ${maxPages} pages, concurrency 10`);
log.info(`URL: ${startUrl}`);

await crawler.run([{ url: startUrl, label: 'LIST' }]);
log.info(`Complete: ${savedJobs} jobs saved`);

await Actor.exit();
