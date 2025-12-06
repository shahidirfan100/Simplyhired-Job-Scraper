// SimplyHired Job Scraper - JSON-first, hardened, production-ready
// Uses CheerioCrawler (HTTP-based) with JSON-first listing extraction and HTML fallback

import { Actor } from 'apify';
import {
    CheerioCrawler,
    Dataset,
    log,
    createCheerioRouter,
} from 'crawlee';
import { load as loadHtml } from 'cheerio';
import { gotScraping } from 'got-scraping';

// -----------------------------------------------------------------------------
// Globals / counters
// -----------------------------------------------------------------------------
let pagesProcessed = 0;
let enqueuedDetails = 0;
let savedJobs = 0;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
const absolute = (href) => {
    if (!href) return null;
    if (href.startsWith('http')) return href;
    if (href.startsWith('/')) return `https://www.simplyhired.com${href}`;
    return `https://www.simplyhired.com/${href}`;
};

const userAgents = [
    // Latest realistic desktop UAs (Dec 2025)
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0',
];
const randomUA = () => userAgents[Math.floor(Math.random() * userAgents.length)];

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const isBlockedStatus = (code) => code === 403 || code === 429;

const cleanText = (text) => (text || '').replace(/\s+/g, ' ').trim();

// Fetch with got-scraping using strong browser-like headers and http2 when available
const fetchWithGot = async (url, proxyUrl, ua) => {
    const res = await gotScraping({
        url,
        proxyUrl,
        timeout: { request: 30000 },
        retry: { limit: 0 },
        headerGeneratorOptions: {
            browsers: [{ name: 'chrome', minVersion: 120, httpVersion: '2' }],
            devices: ['desktop'],
            locales: ['en-US', 'en'],
        },
        headers: {
            'user-agent': ua || randomUA(),
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'accept-language': 'en-US,en;q=0.9',
            'accept-encoding': 'gzip, deflate, br',
            'sec-ch-ua-platform': '"Windows"',
            'upgrade-insecure-requests': '1',
            dnt: '1',
            pragma: 'no-cache',
            'cache-control': 'no-cache',
        },
        http2: true,
        compression: true,
    });
    return { statusCode: res.statusCode, body: res.body?.toString?.() || res.body || '' };
};

// JSON-first list extraction
const extractJobsFromJson = (html, currentUrl) => {
    const $ = loadHtml(html);
    const scripts = $('script[type="application/json"], script[id="__NEXT_DATA__"]');
    const jobs = [];
    let nextCursor = null;

    const normalize = (item) => {
        if (!item || typeof item !== 'object') return null;
        const title = item.title || item.jobTitle || item.positionTitle;
        const company = item.company || item.companyName || item.hiringCompany || item.hiring_company?.name;
        const location = item.location || item.jobLocation || item.cityState || item.city_state || item.locationName;
        const salary = item.salary || item.compensation || item.pay || item.compensationText;
        const summary = item.snippet || item.descriptionSnippet || item.shortDescription;
        const link = item.url || item.viewJobUrl || item.viewJobLink || item.jobUrl || item.jobLink || item.detailUrl;
        if (!title || !link) return null;
        return {
            title: cleanText(title),
            company: cleanText(company),
            location: cleanText(location),
            salary: cleanText(salary),
            summary: cleanText(summary),
            link,
        };
    };

    const walk = (node) => {
        if (!node) return;
        if (Array.isArray(node)) {
            if (node.length && typeof node[0] === 'object') {
                const mapped = node.map(normalize).filter(Boolean);
                if (mapped.length) jobs.push(...mapped);
            }
            node.forEach(walk);
            return;
        }
        if (typeof node === 'object') {
            Object.entries(node).forEach(([key, val]) => {
                if (key.toLowerCase().includes('cursor') && typeof val === 'string') {
                    nextCursor = val;
                }
                walk(val);
            });
        }
    };

    scripts.each((_, el) => {
        try {
            const txt = $(el).contents().text();
            const json = JSON.parse(txt);
            walk(json);
        } catch {
            // ignore parse errors
        }
    });

    let nextUrl = null;
    if (nextCursor) {
        try {
            const url = new URL(currentUrl);
            url.searchParams.set('cursor', nextCursor);
            nextUrl = url.toString();
        } catch {
            nextUrl = null;
        }
    }

    return { jobs, nextUrl };
};

// HTML fallback list extraction
const extractJobsFromHtml = ($) => {
    const jobs = [];
    const cards = $('a[href*="/job/"], h2 a[href*="/job/"]');
    cards.each((_, el) => {
        const link = $(el).attr('href');
        const title = $(el).text();
        if (!link || !title) return;

        const container = $(el).closest('article, section, div');
        let company = '';
        let location = '';
        let salary = '';
        let summary = '';

        container.find('*').each((__, child) => {
            const text = cleanText($(child).text());
            if (!company && text && text !== cleanText(title) && text.length < 80 && !text.match(/^\$[\d,]/)) {
                company = text;
            }
            if (!location && text && (text.includes(',') || text.toLowerCase() === 'remote')) {
                location = text;
            }
            if (!salary && text.match(/\$[\d,]/)) {
                salary = text;
            }
            if (!summary && text.length > 60 && text !== cleanText(title)) {
                summary = text;
            }
        });

        jobs.push({
            title: cleanText(title),
            company,
            location,
            salary,
            summary,
            link,
        });
    });

    // pagination link
    let nextUrl = null;
    const nextLink = $('a[aria-label*="Next"], a:contains("Next"), a[href*="cursor="]').first();
    if (nextLink && nextLink.attr('href')) {
        nextUrl = absolute(nextLink.attr('href'));
    }
    return { jobs, nextUrl };
};

const extractJobFromLdJson = ($) => {
    const scripts = $('script[type="application/ld+json"]');
    for (const el of scripts.toArray()) {
        try {
            const json = JSON.parse($(el).contents().text());
            const posting = Array.isArray(json) ? json.find((j) => j['@type'] === 'JobPosting') : json;
            if (posting && posting['@type'] === 'JobPosting') {
                return {
                    title: cleanText(posting.title),
                    company: cleanText(posting.hiringOrganization?.name),
                    location: cleanText(
                        posting.jobLocation?.address?.addressLocality &&
                            posting.jobLocation?.address?.addressRegion
                            ? `${posting.jobLocation.address.addressLocality}, ${posting.jobLocation.address.addressRegion}`
                            : posting.jobLocation?.address?.addressLocality ||
                              posting.jobLocation?.address?.addressRegion ||
                              posting.jobLocation?.address?.addressCountry,
                    ),
                    salary: cleanText(
                        posting.baseSalary?.value?.value
                            ? `$${posting.baseSalary.value.value} ${posting.baseSalary.value?.unitText || ''}`
                            : posting.baseSalary?.value?.minValue && posting.baseSalary?.value?.maxValue
                              ? `$${posting.baseSalary.value.minValue}-${posting.baseSalary.value.maxValue} ${posting.baseSalary.value?.unitText || ''}`
                              : posting.baseSalary?.value || '',
                    ),
                    date_posted: posting.datePosted || '',
                    description_html: posting.description || '',
                };
            }
        } catch {
            // ignore
        }
    }
    return {};
};

const buildSearchUrls = (keywords, location, datePosted, remoteOnly) => {
    const baseUrl = 'https://www.simplyhired.com/search';
    const urls = [];
    const keywordList = keywords ? keywords.split(',').map((k) => k.trim()).filter(Boolean) : [''];
    const locationParam = remoteOnly ? 'Remote' : (location || '').trim();
    for (const keyword of keywordList) {
        const params = new URLSearchParams();
        if (keyword) params.set('q', keyword);
        if (locationParam) params.set('l', locationParam);
        if (datePosted && datePosted !== 'any') params.set('fdb', datePosted);
        params.set('job', '');
        urls.push(`${baseUrl}?${params.toString()}`);
    }
    return urls;
};

// -----------------------------------------------------------------------------
// Router
// -----------------------------------------------------------------------------
const router = createCheerioRouter();

router.addDefaultHandler(async ({ request, response, session, body, enqueueLinks, crawler, proxyInfo }) => {
    pagesProcessed += 1;
    const maxJobs = crawler.maxJobs;
    const maxPages = crawler.maxPagesPerList;
    const capacity = Math.max(0, maxJobs - savedJobs);
    let status = response?.statusCode;

    if (pagesProcessed > maxPages) {
        log.info(`Max pages reached (${maxPages}), skipping further pagination.`);
        return;
    }

    let html = body?.toString?.() || '';
    // If blocked or HTML suspiciously short, refetch with got-scraping (browser TLS + H2)
    if (isBlockedStatus(status) || html.length < 800) {
        const retry = request.retryCount || 0;
        const backoff = Math.min(5000, 500 * Math.pow(2, retry)) + Math.random() * 400;
        if (isBlockedStatus(status)) {
            log.warning(`List blocked (${status}). Backing off ${Math.round(backoff)}ms and rotating session before refetch.`);
            await sleep(backoff);
            session.markBad();
            session.retire();
        }
        const refetch = await fetchWithGot(request.url, proxyInfo?.url, session.userData?.ua || randomUA());
        status = refetch.statusCode;
        html = refetch.body;
    }

    if (isBlockedStatus(status)) {
        throw new Error(`Blocked with status ${status} on list page`);
    }

    log.info(`LIST ${pagesProcessed}: ${request.url}`);

    const $page = loadHtml(html || '');
    let jobs = [];
    let nextUrl = null;

    // JSON-first
    const jsonResult = extractJobsFromJson(html, request.url);
    if (jsonResult.jobs.length) {
        jobs = jsonResult.jobs;
        nextUrl = jsonResult.nextUrl;
        log.debug(`JSON list extraction success: ${jobs.length} jobs`);
    }

    // Fallback to HTML
    if (!jobs.length) {
        const htmlResult = extractJobsFromHtml($page);
        jobs = htmlResult.jobs;
        nextUrl = nextUrl || htmlResult.nextUrl;
        log.debug(`HTML list extraction: ${jobs.length} jobs`);
    }

    if (!jobs.length) {
        log.warning(`No jobs found on page ${pagesProcessed}`);
        return;
    }

    const limitedJobs = jobs.slice(0, capacity);
    if (!limitedJobs.length) {
        log.info(`Capacity reached (${savedJobs}/${maxJobs}), skipping enqueue.`);
        return;
    }

    const jobUrls = limitedJobs.map((job) => {
        const url = absolute(job.link);
        return { url, job };
    }).filter((r) => r.url);

    await enqueueLinks({
        urls: jobUrls.map((r) => r.url),
        label: 'DETAIL',
        transformRequestFunction: (req) => {
            // attach meta per matching url
            const meta = jobUrls.find((r) => r.url === req.url)?.job;
            req.userData = { jobMeta: meta };
            req.uniqueKey = req.url;
            return req;
        },
    });
    enqueuedDetails += jobUrls.length;
    log.info(`Enqueued ${jobUrls.length} detail pages (total enqueued: ${enqueuedDetails})`);

    // Pagination
    if (nextUrl && savedJobs < maxJobs && pagesProcessed < maxPages) {
        const next = absolute(nextUrl);
        await enqueueLinks({
            urls: [next],
            label: 'LIST',
            transformRequestFunction: (req) => {
                req.uniqueKey = req.url;
                return req;
            },
        });
        log.info(`Enqueued next listing page: ${absolute(nextUrl)}`);
    } else if (!nextUrl) {
        log.info('No next page detected.');
    }
});

router.addHandler('DETAIL', async ({ request, response, session, crawler, body, proxyInfo }) => {
    let status = response?.statusCode;

    const meta = request.userData?.jobMeta || {};
    const maxJobs = crawler.maxJobs;
    if (savedJobs >= maxJobs) return;

    let html = body?.toString?.() || '';
    if (isBlockedStatus(status) || html.length < 800) {
        const retry = request.retryCount || 0;
        const backoff = Math.min(6000, 700 * Math.pow(2, retry)) + Math.random() * 500;
        if (isBlockedStatus(status)) {
            log.warning(`Detail blocked (${status}). Backing off ${Math.round(backoff)}ms and rotating session before refetch.`);
            await sleep(backoff);
            session.markBad();
            session.retire();
        }
        const refetch = await fetchWithGot(request.url, proxyInfo?.url, session.userData?.ua || randomUA());
        status = refetch.statusCode;
        html = refetch.body;
    }

    if (isBlockedStatus(status)) {
        throw new Error(`Blocked with status ${status} on detail page`);
    }

    const $page = loadHtml(html || '');
    const ld = extractJobFromLdJson($page);

    let title = cleanText(ld.title || $page('h1').first().text() || meta.title);
    let company = cleanText(ld.company || $page('[data-testid="viewJobCompanyName"]').first().text() || meta.company);
    let location = cleanText(ld.location || $page('[data-testid="viewJobCompanyLocation"]').first().text() || meta.location);
    let salary = cleanText(ld.salary || $page('[data-testid="viewJobBodyJobCompensation"] [data-testid="detailText"]').first().text() || meta.salary);
    const job_type = cleanText($page('[data-testid="viewJobBodyJobDetailsJobType"] [data-testid="detailText"]').first().text());
    const date_posted = cleanText(ld.date_posted || $page('[data-testid="viewJobBodyJobPostingTimestamp"] [data-testid="detailText"]').first().text());

    const descContainer = $page('[data-testid="viewJobBodyJobFullDescriptionContent"]').first();
    let description_html = ld.description_html || (descContainer.html() || '').trim();
    let description_text = cleanText(ld.description_html ? loadHtml(ld.description_html).text() : descContainer.text());

    // Fallbacks to avoid skipping saves
    if (!title) title = cleanText(meta.title) || 'N/A';
    if (!company) company = cleanText(meta.company) || 'N/A';
    if (!location) location = cleanText(meta.location) || 'N/A';
    if (!salary) salary = cleanText(meta.salary) || '';
    if (!description_text) {
        description_text = cleanText(description_html) || cleanText(meta.summary) || 'N/A';
    }
    if (!description_html) {
        description_html = meta.summary || '';
    }

    const jobData = {
        url: request.url,
        title: title || 'N/A',
        company: company || 'N/A',
        location: location || 'N/A',
        salary: salary || 'N/A',
        job_type: job_type || 'N/A',
        date_posted: date_posted || 'N/A',
        description_text,
        description_html,
        benefits: '',
        qualifications: '',
        source: 'SimplyHired',
        scraped_at: new Date().toISOString(),
    };

    await Dataset.pushData(jobData);
    savedJobs += 1;

    if (savedJobs % 5 === 0 || savedJobs === 1) {
        log.info(`Saved ${savedJobs}/${maxJobs}: ${title}`);
    }
});

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

await Actor.init();
const input = (await Actor.getInput()) ?? {};

const maxJobs = input.results_wanted ?? 200;
const maxPages = input.maxPagesPerList ?? 20;
const maxConcurrency = Math.min(input.maxConcurrency ?? 3, 15); // default lower to reduce blocks

// Start URLs
let startUrls = [];
if (input.startUrls && input.startUrls.length) {
    startUrls = input.startUrls.map((u) => (typeof u === 'string' ? u : u.url)).filter(Boolean);
} else if (input.keywords || input.location || input.remote_only) {
    startUrls = buildSearchUrls(input.keywords, input.location, input.date_posted, input.remote_only);
} else {
    startUrls = ['https://www.simplyhired.com/search?q=software+engineer&l='];
}
if (!startUrls.length) throw new Error('No start URLs provided.');

// Proxy config
let proxyConfiguration;
try {
    if (input.proxyConfiguration) {
        const cfg = { ...input.proxyConfiguration };
        if (cfg.useApifyProxy && (!cfg.apifyProxyGroups || !cfg.apifyProxyGroups.length)) {
            cfg.apifyProxyGroups = ['RESIDENTIAL'];
        }
        proxyConfiguration = await Actor.createProxyConfiguration(cfg);
    } else {
        proxyConfiguration = await Actor.createProxyConfiguration({
            useApifyProxy: true,
            groups: ['RESIDENTIAL'],
            countryCode: 'US',
        });
    }
} catch (err) {
    log.warning(`Primary proxy configuration failed: ${err.message}. Falling back to Apify datacenter proxy (auto).`);
    try {
        proxyConfiguration = await Actor.createProxyConfiguration({ useApifyProxy: true });
    } catch (err2) {
        log.warning(`Datacenter proxy fallback also failed: ${err2.message}. Continuing without proxy (likely to be blocked).`);
    }
}

const crawler = new CheerioCrawler({
    proxyConfiguration,
    requestHandler: router,
    maxConcurrency,
    maxRequestsPerCrawl: Math.min(maxJobs * 10, 5000),
    maxRequestRetries: 6,
    requestHandlerTimeoutSecs: 90,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: {
        maxPoolSize: 80,
        sessionOptions: {
            maxUsageCount: 8, // aggressive rotation
            maxErrorScore: 0.5, // retire sooner
            maxAgeSecs: 3600,
        },
    },
    minConcurrency: Math.max(2, Math.floor(maxConcurrency / 3)),
    preNavigationHooks: [
        async ({ request, session }) => {
            if (!session.userData.ua) session.userData.ua = randomUA();
            const isDetail = request.userData?.label === 'DETAIL';
            // Human-like dwell time + network jitter
            const dwell = isDetail ? 450 + Math.random() * 1200 : 220 + Math.random() * 700;
            const latency = 80 + Math.random() * 200;
            await sleep(dwell + latency);

            // Derive consistent client hints from UA (Chrome-like)
            const ua = session.userData.ua;
            const chromeMatch = ua.match(/Chrome\/(\d+)/);
            const chromeVer = chromeMatch ? chromeMatch[1] : '131';
            const secChUa = `"Chromium";v="${chromeVer}", "Not_A Brand";v="24", "Google Chrome";v="${chromeVer}"`;

            request.headers = {
                'user-agent': ua,
                accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'accept-language': 'en-US,en;q=0.9',
                'accept-encoding': 'gzip, deflate, br',
                'cache-control': 'no-cache',
                pragma: 'no-cache',
                'sec-ch-ua': secChUa,
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
                'sec-ch-ua-platform-version': '"15.0.0"',
                'sec-ch-ua-arch': '"x86"',
                'sec-ch-ua-bitness': '"64"',
                'sec-ch-ua-full-version': `"${chromeVer}.0.0.0"`,
                'sec-ch-ua-full-version-list': secChUa.replace(/Chromium/, 'Google Chrome'),
                'sec-fetch-dest': 'document',
                'sec-fetch-mode': 'navigate',
                'sec-fetch-site': isDetail ? 'same-origin' : 'none',
                'sec-fetch-user': '?1',
                'upgrade-insecure-requests': '1',
                dnt: '1',
                connection: 'keep-alive',
            };
            if (isDetail) request.headers.referer = 'https://www.simplyhired.com/';
        },
    ],
    failedRequestHandler: async ({ request, error }) => {
        log.warning(`Request failed after retries (${request.url}): ${error?.message}`);
    },
});

// expose limits
crawler.maxJobs = maxJobs;
crawler.maxPagesPerList = maxPages;

log.info(`Starting SimplyHired scraper with ${startUrls.length} start URLs, target ${maxJobs} jobs, ${maxPages} pages max, concurrency ${maxConcurrency}`);
if (proxyConfiguration) {
    const cfg = proxyConfiguration || {};
    const groups = cfg.groups || cfg.apifyProxyGroups;
    log.info(`Proxy: Apify Proxy ${groups ? `groups=${groups.join(',')}` : '(auto)'}`);
} else {
    log.warning('Proxy: NONE configured. SimplyHired is likely to block non-proxy traffic.');
}
startUrls.forEach((u, i) => log.info(`Start URL ${i + 1}: ${u}`));

try {
    await crawler.run(startUrls.map((url) => ({ url, label: 'LIST', uniqueKey: url })));
    log.info(`Run complete. Saved ${savedJobs} jobs.`);
    if (savedJobs < maxJobs) {
        log.warning(`Target not reached (${savedJobs}/${maxJobs}). Could be blocks or limited results.`);
    }
} finally {
    await Actor.exit();
}
