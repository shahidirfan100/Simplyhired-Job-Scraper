// SimplyHired Job Scraper - Production-Ready with Next.js API Priority
// Uses CheerioCrawler with Next.js internal API, __NEXT_DATA__, and HTML fallback

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
// Globals / counters
// -----------------------------------------------------------------------------
let pagesProcessed = 0;
let enqueuedDetails = 0;
let savedJobs = 0;
let buildId = null; // Next.js build ID extracted from first page

// -----------------------------------------------------------------------------
// Header Generator for realistic browser fingerprints
// -----------------------------------------------------------------------------
const headerGenerator = new HeaderGenerator({
    browsers: [{ name: 'chrome', minVersion: 120 }],
    devices: ['desktop'],
    operatingSystems: ['windows'],
    locales: ['en-US', 'en'],
});

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

const isBlockedStatus = (code) => code === 403 || code === 429;

const cleanText = (text) => (text || '').replace(/\s+/g, ' ').trim();

// Generate realistic headers
const generateHeaders = (referer = 'https://www.simplyhired.com/') => {
    const headers = headerGenerator.getHeaders();
    return {
        ...headers,
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'accept-encoding': 'gzip, deflate, br',
        'cache-control': 'no-cache',
        'pragma': 'no-cache',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-user': '?1',
        'upgrade-insecure-requests': '1',
        'dnt': '1',
        'referer': referer,
    };
};

// Fetch with got-scraping using strong browser-like headers
const fetchWithGot = async (url, proxyUrl, headers = {}) => {
    const defaultHeaders = generateHeaders();
    const res = await gotScraping({
        url,
        proxyUrl,
        timeout: { request: 30000 },
        retry: { limit: 0 },
        headers: { ...defaultHeaders, ...headers },
        http2: true,
        compression: true,
    });
    return { statusCode: res.statusCode, body: res.body?.toString?.() || res.body || '' };
};

// -----------------------------------------------------------------------------
// PRIORITY 1: Next.js Internal API Fetcher
// -----------------------------------------------------------------------------
const fetchNextJsApi = async ({ q, l, cursor, proxyUrl }) => {
    if (!buildId) {
        log.debug('No buildId available, skipping Next.js API');
        return { jobs: [], nextCursor: null, blocked: false };
    }

    try {
        const apiUrl = new URL(`https://www.simplyhired.com/_next/data/${buildId}/search.json`);
        if (q) apiUrl.searchParams.set('q', q);
        if (l) apiUrl.searchParams.set('l', l);
        if (cursor) apiUrl.searchParams.set('cursor', cursor);

        const headers = generateHeaders(`https://www.simplyhired.com/search?q=${encodeURIComponent(q || '')}&l=${encodeURIComponent(l || '')}`);
        headers['accept'] = 'application/json, text/plain, */*';
        headers['x-nextjs-data'] = '1';

        const res = await gotScraping({
            url: apiUrl.toString(),
            proxyUrl,
            timeout: { request: 20000 },
            retry: { limit: 0 },
            headers,
            http2: true,
            throwHttpErrors: false,
        });

        if (res.statusCode >= 400) {
            return { jobs: [], nextCursor: null, blocked: isBlockedStatus(res.statusCode) };
        }

        const body = typeof res.body === 'string' ? res.body : res.body?.toString?.() || '';
        let json;
        try {
            json = JSON.parse(body);
        } catch {
            return { jobs: [], nextCursor: null, blocked: false };
        }

        const pageProps = json?.pageProps || {};
        const list = pageProps.jobs || [];
        const pageCursors = pageProps.pageCursors || {};

        const jobs = Array.isArray(list)
            ? list.map((item) => {
                const title = item.title || item.jobTitle || '';
                const company = item.company || item.companyName || item.hiringOrganization?.name || '';
                const location = item.location || item.jobLocation || item.formattedLocation || '';
                const salaryObj = item.salary || item.estimatedSalary || item.salarySnippet || {};
                const salary = typeof salaryObj === 'object'
                    ? cleanText([salaryObj.min && `$${salaryObj.min}`, salaryObj.max && salaryObj.max !== salaryObj.min && `$${salaryObj.max}`, salaryObj.type].filter(Boolean).join(' - '))
                    : cleanText(salaryObj);
                const job_type = item.employmentType || item.jobType || '';
                const date_posted = item.datePosted || item.pubDate || item.formattedDate || '';
                const summary = item.snippet || item.description || item.descriptionSnippet || '';
                const link = item.viewJobLink || item.url || item.jobUrl || item.link || '';
                if (!title || !link) return null;
                return {
                    title: cleanText(title),
                    company: cleanText(company),
                    location: cleanText(location),
                    salary: salary || '',
                    job_type: cleanText(job_type),
                    date_posted: cleanText(date_posted),
                    summary: cleanText(summary),
                    link: absolute(link),
                };
            }).filter(Boolean)
            : [];

        // Get next cursor (page 2 cursor if we're on page 1, etc.)
        const cursorKeys = Object.keys(pageCursors).map(Number).sort((a, b) => a - b);
        let nextCursor = null;
        if (cursorKeys.length > 0) {
            // If no current cursor, get page 2; otherwise get next sequential
            const currentPage = cursor ? cursorKeys.findIndex(k => pageCursors[k] === cursor) + 1 : 0;
            const nextPage = currentPage + 2; // +2 because cursors are keyed by page number
            if (pageCursors[nextPage]) {
                nextCursor = pageCursors[nextPage];
            }
        }

        log.debug(`Next.js API: Found ${jobs.length} jobs, nextCursor: ${nextCursor ? 'yes' : 'no'}`);
        return { jobs, nextCursor, blocked: false };
    } catch (err) {
        log.debug(`Next.js API error: ${err.message}`);
        return { jobs: [], nextCursor: null, blocked: false };
    }
};

// -----------------------------------------------------------------------------
// PRIORITY 2: Extract from __NEXT_DATA__ embedded JSON
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

        const jobs = Array.isArray(list)
            ? list.map((item) => {
                const title = item.title || item.jobTitle || '';
                const company = item.company || item.companyName || item.hiringOrganization?.name || '';
                const location = item.location || item.jobLocation || item.formattedLocation || '';
                const salaryObj = item.salary || item.estimatedSalary || item.salarySnippet || {};
                const salary = typeof salaryObj === 'object'
                    ? cleanText([salaryObj.min && `$${salaryObj.min}`, salaryObj.max && salaryObj.max !== salaryObj.min && `$${salaryObj.max}`, salaryObj.type].filter(Boolean).join(' - '))
                    : cleanText(salaryObj);
                const job_type = item.employmentType || item.jobType || '';
                const date_posted = item.datePosted || item.pubDate || item.formattedDate || '';
                const summary = item.snippet || item.description || item.descriptionSnippet || '';
                const link = item.viewJobLink || item.url || item.jobUrl || item.link || '';
                if (!title || !link) return null;
                return {
                    title: cleanText(title),
                    company: cleanText(company),
                    location: cleanText(location),
                    salary: salary || '',
                    job_type: cleanText(job_type),
                    date_posted: cleanText(date_posted),
                    summary: cleanText(summary),
                    link: absolute(link),
                };
            }).filter(Boolean)
            : [];

        // Get first available cursor for page 2
        const nextCursor = pageCursors['2'] || null;

        return { jobs, nextCursor, extractedBuildId };
    } catch {
        return { jobs: [], nextCursor: null, extractedBuildId: null };
    }
};

// -----------------------------------------------------------------------------
// PRIORITY 3: HTML Fallback with updated data-testid selectors
// -----------------------------------------------------------------------------
const extractJobsFromHtml = ($) => {
    const jobs = [];

    // Updated selectors based on current SimplyHired structure
    const jobCards = $('div[data-testid="searchSerpJob"], li[data-testid="itemListing"], article[data-cy="job-card"]');

    jobCards.each((_, el) => {
        const card = $(el);

        // Title extraction with multiple fallbacks
        const titleEl = card.find('h2[data-testid="searchSerpJobTitle"], h2[data-testid="jobTitle"], h2 a, a[data-testid="job-link"]').first();
        const title = cleanText(titleEl.text());
        const link = titleEl.attr('href') || card.find('a[href*="/job/"]').first().attr('href');

        if (!title || !link) return;

        // Company
        const company = cleanText(
            card.find('span[data-testid="companyName"], [data-testid="company-name"], .company').first().text()
        );

        // Location
        const location = cleanText(
            card.find('span[data-testid="jobLocation"], [data-testid="job-location"], .location').first().text()
        );

        // Salary
        const salary = cleanText(
            card.find('span[data-testid="jobSalaryInfo"], [data-testid="salary"], .salary').first().text()
        );

        // Summary/snippet
        const summary = cleanText(
            card.find('[data-testid="job-snippet"], .snippet, .description').first().text()
        );

        jobs.push({
            title,
            company,
            location,
            salary,
            summary,
            link: absolute(link),
        });
    });

    // Pagination - find next page link
    let nextUrl = null;
    const nextLink = $('a[aria-label="Next page"], a[aria-label*="Next"], a:contains("Next")').first();
    if (nextLink.length && nextLink.attr('href')) {
        nextUrl = absolute(nextLink.attr('href'));
    }

    return { jobs, nextUrl };
};

// -----------------------------------------------------------------------------
// Extract JSON-LD for detail pages
// -----------------------------------------------------------------------------
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

// Build search URLs from input parameters
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
        urls.push(`${baseUrl}?${params.toString()}`);
    }
    return urls;
};

// -----------------------------------------------------------------------------
// Router
// -----------------------------------------------------------------------------
const router = createCheerioRouter();

router.addDefaultHandler(async ({ request, response, session, body, enqueueLinks, crawler, proxyInfo }) => {
    // Skip if this is a DETAIL request that landed here by mistake
    if (request.label === 'DETAIL' || request.userData?.label === 'DETAIL') return;

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

    // If blocked or HTML too short, refetch with got-scraping
    if (isBlockedStatus(status) || html.length < 800) {
        const retry = request.retryCount || 0;
        const backoff = Math.min(5000, 500 * Math.pow(2, retry)) + Math.random() * 400;
        if (isBlockedStatus(status)) {
            log.warning(`List blocked (${status}). Backing off ${Math.round(backoff)}ms`);
            await sleep(backoff);
            session.markBad();
            session.retire();
        }
        const refetch = await fetchWithGot(request.url, proxyInfo?.url);
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
    let nextCursor = null;

    // Extract URL params for API calls
    const urlObj = new URL(request.url);
    const qParam = urlObj.searchParams.get('q') || '';
    const lParam = urlObj.searchParams.get('l') || '';
    const currentCursor = urlObj.searchParams.get('cursor') || request.userData?.cursor || null;

    // PRIORITY 1: Try __NEXT_DATA__ first (also extracts buildId)
    const nextDataResult = extractFromNextData(html);
    if (nextDataResult.extractedBuildId && !buildId) {
        buildId = nextDataResult.extractedBuildId;
        log.info(`Extracted buildId: ${buildId}`);
    }

    if (nextDataResult.jobs.length) {
        jobs = nextDataResult.jobs;
        nextCursor = nextDataResult.nextCursor;
        log.debug(`__NEXT_DATA__ extraction: ${jobs.length} jobs`);
    }

    // PRIORITY 2: Try Next.js API if we have buildId and need more jobs or pagination
    if (buildId && (!jobs.length || (nextCursor && pagesProcessed > 1))) {
        const apiResult = await fetchNextJsApi({
            q: qParam,
            l: lParam,
            cursor: currentCursor,
            proxyUrl: proxyInfo?.url,
        });
        if (apiResult.jobs.length) {
            jobs = apiResult.jobs;
            nextCursor = apiResult.nextCursor;
            log.debug(`Next.js API extraction: ${jobs.length} jobs`);
        }
    }

    // PRIORITY 3: HTML fallback
    if (!jobs.length) {
        const htmlResult = extractJobsFromHtml($page);
        jobs = htmlResult.jobs;
        nextUrl = htmlResult.nextUrl;
        log.debug(`HTML extraction: ${jobs.length} jobs`);
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

    // Enqueue detail pages
    const jobUrls = limitedJobs.map((job) => ({
        url: absolute(job.link),
        job,
    })).filter((r) => r.url);

    await enqueueLinks({
        urls: jobUrls.map((r) => r.url),
        label: 'DETAIL',
        transformRequestFunction: (req) => {
            const meta = jobUrls.find((r) => r.url === req.url)?.job;
            req.userData = { jobMeta: meta, label: 'DETAIL' };
            req.label = 'DETAIL';
            req.uniqueKey = req.url;
            return req;
        },
    });
    enqueuedDetails += jobUrls.length;
    log.info(`Enqueued ${jobUrls.length} detail pages (total: ${enqueuedDetails})`);

    // Pagination - prefer cursor-based
    if (savedJobs < maxJobs && pagesProcessed < maxPages) {
        if (nextCursor) {
            const nextPageUrl = new URL('https://www.simplyhired.com/search');
            if (qParam) nextPageUrl.searchParams.set('q', qParam);
            if (lParam) nextPageUrl.searchParams.set('l', lParam);
            nextPageUrl.searchParams.set('cursor', nextCursor);
            nextUrl = nextPageUrl.toString();
        }

        if (nextUrl) {
            await enqueueLinks({
                urls: [nextUrl],
                label: 'LIST',
                transformRequestFunction: (req) => {
                    req.userData = { label: 'LIST', cursor: nextCursor };
                    req.label = 'LIST';
                    req.uniqueKey = req.url;
                    return req;
                },
            });
            log.info(`Enqueued next page: ${nextUrl}`);
        } else {
            log.info('No next page detected.');
        }
    }
});

router.addHandler('DETAIL', async ({ request, response, session, crawler, body, proxyInfo }) => {
    const meta = request.userData?.jobMeta || {};
    const maxJobs = crawler.maxJobs;
    if (savedJobs >= maxJobs) return;

    try {
        let status = response?.statusCode;
        let html = body?.toString?.() || '';

        if (isBlockedStatus(status) || html.length < 800) {
            const retry = request.retryCount || 0;
            const backoff = Math.min(6000, 700 * Math.pow(2, retry)) + Math.random() * 500;
            if (isBlockedStatus(status)) {
                log.warning(`Detail blocked (${status}). Backing off ${Math.round(backoff)}ms`);
                await sleep(backoff);
                session.markBad();
                session.retire();
            }
            const refetch = await fetchWithGot(request.url, proxyInfo?.url);
            status = refetch.statusCode;
            html = refetch.body;
        }

        if (isBlockedStatus(status)) {
            throw new Error(`Blocked with status ${status} on detail page`);
        }

        const $page = loadHtml(html || '');
        const ld = extractJobFromLdJson($page);

        let title = cleanText(ld.title || $page('h1').first().text() || meta.title);
        let company = cleanText(ld.company || $page('[data-testid="viewJobCompanyName"], [data-testid="company-name"]').first().text() || meta.company);
        let location = cleanText(ld.location || $page('[data-testid="viewJobCompanyLocation"], [data-testid="job-location"]').first().text() || meta.location);
        let salary = cleanText(ld.salary || $page('[data-testid="viewJobBodyJobCompensation"] [data-testid="detailText"], [data-testid="salary"]').first().text() || meta.salary);
        const job_type = cleanText(
            meta.job_type ||
            $page('[data-testid="viewJobBodyJobDetailsJobType"] [data-testid="detailText"], [data-testid="job-type"]').first().text()
        );
        const date_posted = cleanText(
            ld.date_posted ||
            meta.date_posted ||
            $page('[data-testid="viewJobBodyJobPostingTimestamp"] [data-testid="detailText"]').first().text()
        );

        const descContainer = $page('[data-testid="viewJobBodyJobFullDescriptionContent"], [data-testid="job-description"], .job-description').first();
        let description_html = ld.description_html || (descContainer.html() || '').trim();
        let description_text = cleanText(ld.description_html ? loadHtml(ld.description_html).text() : descContainer.text());

        // Fallbacks
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
    } catch (err) {
        // Fallback: push meta-only data
        log.warning(`Detail error for ${request.url}: ${err.message}. Pushing fallback.`);
        const fallback = {
            url: request.url,
            title: cleanText(meta.title) || 'N/A',
            company: cleanText(meta.company) || 'N/A',
            location: cleanText(meta.location) || 'N/A',
            salary: cleanText(meta.salary) || '',
            job_type: meta.job_type || '',
            date_posted: meta.date_posted || '',
            description_text: cleanText(meta.summary) || 'N/A',
            description_html: meta.summary || '',
            source: 'SimplyHired',
            scraped_at: new Date().toISOString(),
        };
        await Dataset.pushData(fallback);
        savedJobs += 1;
    }
});

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

await Actor.init();
const input = (await Actor.getInput()) ?? {};

const maxJobs = input.results_wanted ?? 200;
const maxPages = input.maxPagesPerList ?? 20;
const maxConcurrency = Math.min(input.maxConcurrency ?? 5, 15);

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
    log.warning(`Primary proxy failed: ${err.message}. Trying datacenter proxy.`);
    try {
        proxyConfiguration = await Actor.createProxyConfiguration({ useApifyProxy: true });
    } catch (err2) {
        log.warning(`Datacenter proxy failed: ${err2.message}. Running without proxy.`);
    }
}

const crawler = new CheerioCrawler({
    proxyConfiguration,
    requestHandler: router,
    maxConcurrency,
    maxRequestsPerCrawl: Math.min(maxJobs * 10, 5000),
    maxRequestRetries: 5,
    requestHandlerTimeoutSecs: 90,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: {
        maxPoolSize: 50,
        sessionOptions: {
            maxUsageCount: 10,
            maxErrorScore: 0.5,
            maxAgeSecs: 3600,
        },
    },
    minConcurrency: Math.max(1, Math.floor(maxConcurrency / 3)),
    preNavigationHooks: [
        async ({ request, session }) => {
            // Human-like delay
            const isDetail = request.userData?.label === 'DETAIL';
            const dwell = isDetail ? 300 + Math.random() * 800 : 150 + Math.random() * 500;
            await sleep(dwell);

            // Set realistic headers
            const referer = isDetail
                ? 'https://www.simplyhired.com/search'
                : 'https://www.simplyhired.com/';
            request.headers = generateHeaders(referer);
        },
    ],
    failedRequestHandler: async ({ request, error }) => {
        log.warning(`Request failed (${request.url}): ${error?.message}`);
    },
});

// Expose limits
crawler.maxJobs = maxJobs;
crawler.maxPagesPerList = maxPages;

log.info(`Starting SimplyHired scraper: ${startUrls.length} URLs, target ${maxJobs} jobs, ${maxPages} max pages`);
if (proxyConfiguration) {
    log.info(`Proxy: Apify Proxy (RESIDENTIAL)`);
} else {
    log.warning('Proxy: NONE - may get blocked');
}
startUrls.forEach((u, i) => log.info(`Start URL ${i + 1}: ${u}`));

try {
    await crawler.run(startUrls.map((url) => ({ url, label: 'LIST', uniqueKey: url })));
    log.info(`Complete. Saved ${savedJobs} jobs.`);
    if (savedJobs < maxJobs) {
        log.warning(`Target not reached (${savedJobs}/${maxJobs}). May be blocked or limited results.`);
    }
} finally {
    await Actor.exit();
}
