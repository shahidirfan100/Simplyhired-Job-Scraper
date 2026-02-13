import { Actor } from 'apify';
import log from '@apify/log';
import { load as loadHtml } from 'cheerio';
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const BASE_URL = 'https://www.simplyhired.com';
const DETAIL_CONCURRENCY = 8;
const headerGenerator = new HeaderGenerator({
    browsers: [
        { name: 'chrome', minVersion: 120, maxVersion: 132 },
        { name: 'firefox', minVersion: 115, maxVersion: 131 },
    ],
    devices: ['desktop'],
    operatingSystems: ['windows', 'macos'],
    locales: ['en-US', 'en'],
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomBetween = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const cleanText = (value) => (value || '').toString().replace(/\s+/g, ' ').trim();
const toUniqueArray = (values) => {
    if (!Array.isArray(values)) return [];
    const out = [];
    const seen = new Set();

    for (const value of values) {
        const cleaned = cleanText(value);
        if (!cleaned) continue;
        const key = cleaned.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(cleaned);
    }

    return out;
};
const isBlockedStatus = (status) => status === 403 || status === 429 || status === 503;
const toIsoFromMs = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '';
    return new Date(n).toISOString();
};

const absoluteUrl = (value) => {
    if (!value) return '';
    if (value.startsWith('http://') || value.startsWith('https://')) return value;
    if (value.startsWith('/')) return `${BASE_URL}${value}`;
    return `${BASE_URL}/${value}`;
};

const tryDecodeURIComponent = (value) => {
    if (!value) return '';
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
};

const buildSearchUrl = (keyword, location) => {
    const params = new URLSearchParams();
    if (keyword) params.set('q', keyword.trim());
    if (location) params.set('l', location.trim());
    return `${BASE_URL}/search?${params.toString()}`;
};

const getStartUrls = (input) => {
    if (!Array.isArray(input.startUrls) || !input.startUrls.length) {
        return [buildSearchUrl(input.keyword || 'software engineer', input.location || 'USA')];
    }

    return input.startUrls
        .map((item) => (typeof item === 'string' ? item : item?.url))
        .filter(Boolean);
};

const normalizeProxyInput = (proxyConfigurationInput) => {
    if (!proxyConfigurationInput || typeof proxyConfigurationInput !== 'object') {
        return { useApifyProxy: true };
    }

    const normalized = { ...proxyConfigurationInput };

    if (normalized.apifyProxyGroups && !Array.isArray(normalized.groups)) {
        normalized.groups = Array.isArray(normalized.apifyProxyGroups)
            ? normalized.apifyProxyGroups
            : [normalized.apifyProxyGroups];
    }
    if (typeof normalized.apifyProxyCountry === 'string' && !normalized.countryCode) {
        normalized.countryCode = normalized.apifyProxyCountry;
    }

    delete normalized.apifyProxyGroups;
    delete normalized.apifyProxyCountry;

    return normalized;
};

const isProxyError = (error) => {
    const msg = String(error?.message || '').toLowerCase();
    return [
        'proxy',
        'tunnel',
        '407',
        'authentication',
        'invalid password',
        'user not found',
        'socket hang up',
        'etimedout',
        'econnreset',
        'ehostunreach',
        'enotfound',
    ].some((token) => msg.includes(token));
};

const createProxyState = async (proxyConfigurationInput) => {
    const normalized = normalizeProxyInput(proxyConfigurationInput);
    const wantsProxy = Boolean(
        normalized?.useApifyProxy
        || (Array.isArray(normalized?.proxyUrls) && normalized.proxyUrls.length)
    );

    if (!wantsProxy) {
        return { configuration: null, enabled: false, failures: 0 };
    }

    try {
        const configuration = await Actor.createProxyConfiguration(normalized);
        return { configuration, enabled: true, failures: 0 };
    } catch (error) {
        log.warning(`Proxy initialization failed, continuing without proxy: ${error.message}`);
        return { configuration: null, enabled: false, failures: 0 };
    }
};

const createHeaders = ({ referer, acceptJson = false }) => {
    const generated = headerGenerator.getHeaders();
    const userAgent = generated['user-agent'] || generated['User-Agent'];
    const chromeVersion = (userAgent?.match(/Chrome\/(\d+)/)?.[1]) || '132';

    return {
        ...generated,
        'user-agent': userAgent,
        accept: acceptJson
            ? 'application/json,text/plain,*/*'
            : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        referer: referer || `${BASE_URL}/`,
        'sec-ch-ua': `"Chromium";v="${chromeVersion}", "Google Chrome";v="${chromeVersion}", "Not_A Brand";v="24"`,
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': acceptJson ? 'empty' : 'document',
        'sec-fetch-mode': acceptJson ? 'cors' : 'navigate',
        'sec-fetch-site': 'same-origin',
    };
};

const isBlockContent = (body) => {
    const text = (body || '').toLowerCase();
    return text.includes('captcha') || text.includes('access denied') || text.includes('are you human');
};

const fetchWithRetries = async ({
    url,
    referer,
    proxyState,
    sessionId,
    acceptJson = false,
    maxAttempts = 4,
}) => {
    let lastError;
    let activeSession = sessionId;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let proxyUrl;
        try {
            if (proxyState?.enabled && proxyState.configuration) {
                proxyUrl = await proxyState.configuration.newUrl(activeSession);
            }

            const response = await gotScraping({
                url,
                proxyUrl,
                headers: createHeaders({ referer, acceptJson }),
                timeout: { request: 20000 },
                throwHttpErrors: false,
                retry: { limit: 0 },
                http2: true,
            });

            const body = response.body?.toString?.() || '';
            const blocked = isBlockedStatus(response.statusCode) || (!acceptJson && isBlockContent(body));
            if (!blocked || response.statusCode === 404) {
                if (proxyState?.enabled && proxyUrl) proxyState.failures = 0;
                return {
                    statusCode: response.statusCode,
                    body,
                    headers: response.headers,
                };
            }

            lastError = new Error(`Blocked with status ${response.statusCode}`);
            if (proxyState?.enabled && proxyUrl) {
                proxyState.failures += 1;
                if (proxyState.failures >= 3) {
                    proxyState.enabled = false;
                    log.warning('Disabling proxy after repeated blocked responses. Continuing without proxy.');
                }
            }
        } catch (error) {
            lastError = error;
            if (proxyState?.enabled && isProxyError(error)) {
                proxyState.failures += 1;
                if (proxyState.failures >= 2) {
                    proxyState.enabled = false;
                    log.warning(`Disabling proxy after repeated proxy failures: ${error.message}`);
                }
            }
        }

        if (attempt < maxAttempts) {
            activeSession = `retry_${Date.now()}_${randomBetween(1000, 9999)}`;
            await sleep(randomBetween(450 * attempt, 1000 * attempt));
        }
    }

    throw lastError || new Error(`Request failed: ${url}`);
};

const getNextDataPayloadFromHtml = (html) => {
    const $ = loadHtml(html);
    const raw = $('#__NEXT_DATA__').text();
    if (!raw) return null;

    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
};

const decodeJobPathFromEncodedUrl = (encodedUrl) => {
    const decoded = tryDecodeURIComponent(encodedUrl || '');
    if (!decoded) return '';

    if (decoded.startsWith('http')) {
        const parsed = new URL(decoded);
        return parsed.pathname;
    }

    return decoded.split('?')[0];
};

const normalizeListJob = (rawJob, sourceSearchUrl) => {
    const jobPath = rawJob.botUrl || decodeJobPathFromEncodedUrl(rawJob.encodedUrl) || '';
    const salaryRaw = rawJob.salaryInfo;
    const requirements = toUniqueArray(rawJob.requirements);
    const uncategorized = toUniqueArray(rawJob.uncategorized);
    const skills = toUniqueArray([...uncategorized, ...requirements]);

    return {
        job_key: cleanText(rawJob.jobKey),
        title: cleanText(rawJob.title),
        company: cleanText(rawJob.company),
        location: cleanText(rawJob.location),
        salary: cleanText(typeof salaryRaw === 'string' ? salaryRaw : ''),
        snippet: cleanText(rawJob.snippet),
        description_text: '',
        description_html: '',
        summary: cleanText(rawJob.snippet),
        requirements,
        skills,
        benefits: Array.isArray(rawJob.benefits) ? rawJob.benefits : [],
        job_type: Array.isArray(rawJob.jobTypes) ? rawJob.jobTypes.join(', ') : '',
        remote_attributes: Array.isArray(rawJob.remoteAttributes) ? rawJob.remoteAttributes : [],
        sponsored: Boolean(rawJob.sponsored),
        company_rating: Number.isFinite(Number(rawJob.companyRating)) ? Number(rawJob.companyRating) : null,
        date_posted: toIsoFromMs(rawJob.dateOnIndeed),
        url: absoluteUrl(jobPath || ''),
        company_page_url: absoluteUrl(rawJob.companyPageUrl || ''),
        source_search_url: sourceSearchUrl,
    };
};

const pickNextCursor = (pageCursors, currentPage, usedCursors) => {
    if (!pageCursors || typeof pageCursors !== 'object') return null;

    const direct = pageCursors[String(Number(currentPage) + 1)];
    if (direct && !usedCursors.has(direct)) return direct;

    const orderedCandidates = Object.entries(pageCursors)
        .map(([key, cursor]) => ({ page: Number(key), cursor }))
        .filter(({ page, cursor }) => Number.isFinite(page) && page > Number(currentPage) && cursor)
        .sort((a, b) => a.page - b.page);

    for (const candidate of orderedCandidates) {
        if (!usedCursors.has(candidate.cursor)) {
            return candidate.cursor;
        }
    }

    for (const cursor of Object.values(pageCursors)) {
        if (cursor && !usedCursors.has(cursor)) {
            return cursor;
        }
    }

    return null;
};

const buildSearchJsonUrl = (buildId, searchUrl, cursor) => {
    const source = new URL(searchUrl);
    const jsonUrl = new URL(`${BASE_URL}/_next/data/${buildId}/search.json`);

    source.searchParams.forEach((value, key) => jsonUrl.searchParams.append(key, value));
    if (cursor) jsonUrl.searchParams.set('cursor', cursor);
    else jsonUrl.searchParams.delete('cursor');

    return jsonUrl.toString();
};

const buildDetailJsonUrl = (buildId, jobKey) => (
    `${BASE_URL}/_next/data/${buildId}/job/${encodeURIComponent(jobKey)}.json`
);

const runPool = async (items, concurrency, handler) => {
    if (!items.length) return [];

    const size = Math.max(1, Math.min(concurrency, items.length));
    const results = new Array(items.length);
    let index = 0;

    const workers = Array.from({ length: size }, async () => {
        while (true) {
            const current = index;
            index += 1;
            if (current >= items.length) return;
            results[current] = await handler(items[current], current);
        }
    });

    await Promise.all(workers);
    return results;
};

const enrichJobLongDescription = async ({ job, buildId, startUrl, proxyState }) => {
    if (!job.job_key) return job;

    try {
        const response = await fetchWithRetries({
            url: buildDetailJsonUrl(buildId, job.job_key),
            referer: startUrl,
            proxyState,
            sessionId: `detail_${job.job_key.slice(0, 10)}_${randomBetween(1000, 9999)}`,
            acceptJson: true,
            maxAttempts: 3,
        });

        if (response.statusCode >= 400) {
            return job;
        }

        const parsed = JSON.parse(response.body);
        const pageProps = parsed?.pageProps || {};
        const descriptionHtml = pageProps.jobDescriptionHtml || '';
        const descriptionText = cleanText(descriptionHtml ? loadHtml(descriptionHtml).text() : '');

        if (!descriptionText) return job;

        return {
            ...job,
            description_html: descriptionHtml,
            description_text: descriptionText,
        };
    } catch {
        return job;
    }
};

const scrapeSearch = async ({
    startUrl,
    maxPages,
    maxJobs,
    proxyState,
    seenJobs,
    state,
}) => {
    const bootstrapSession = `bootstrap_${Date.now()}_${randomBetween(1000, 9999)}`;
    const bootstrap = await fetchWithRetries({
        url: startUrl,
        referer: `${BASE_URL}/`,
        proxyState,
        sessionId: bootstrapSession,
        acceptJson: false,
        maxAttempts: 5,
    });

    if (bootstrap.statusCode >= 400) {
        throw new Error(`Failed to open search URL ${startUrl} (${bootstrap.statusCode})`);
    }

    const nextData = getNextDataPayloadFromHtml(bootstrap.body);
    if (!nextData?.buildId || !nextData?.props?.pageProps) {
        throw new Error(`No __NEXT_DATA__ found on ${startUrl}. Playwright fallback may be required for this query.`);
    }

    const buildId = nextData.buildId;
    const usedCursors = new Set();
    let pageProps = nextData.props.pageProps;
    let currentPage = Number(pageProps.currentPageNumber) || 1;
    let pagesFetched = 0;

    log.info(`Search bootstrap OK. buildId=${buildId}, startPage=${currentPage}, startUrl=${startUrl}`);

    while (pagesFetched < maxPages && state.saved < maxJobs) {
        pagesFetched += 1;
        state.pagesProcessed += 1;

        const listJobs = Array.isArray(pageProps.jobs) ? pageProps.jobs : [];
        const normalized = listJobs
            .map((job) => normalizeListJob(job, startUrl))
            .filter((job) => job.title && job.url);

        const uniqueJobs = [];
        for (const job of normalized) {
            const uniqueKey = job.job_key || job.url;
            if (!uniqueKey || seenJobs.has(uniqueKey)) continue;
            seenJobs.add(uniqueKey);
            uniqueJobs.push(job);
            if (state.saved + uniqueJobs.length >= maxJobs) break;
        }

        if (uniqueJobs.length) {
            const enrichedJobs = await runPool(uniqueJobs, DETAIL_CONCURRENCY, async (job) => enrichJobLongDescription({
                job,
                buildId,
                startUrl,
                proxyState,
            }));

            const withMeta = enrichedJobs.map((job) => ({
                ...job,
                description_text: job.description_text || '',
                source: 'SimplyHired',
                scraped_at: new Date().toISOString(),
            }));

            await Actor.pushData(withMeta);
            state.saved += withMeta.length;
        }

        log.info([
            `Page ${currentPage} processed`,
            `jobsInPage=${listJobs.length}`,
            `newJobs=${uniqueJobs.length}`,
            `savedTotal=${state.saved}/${maxJobs}`,
        ].join(' | '));

        if (state.saved >= maxJobs) break;

        const nextCursor = pickNextCursor(pageProps.pageCursors, currentPage, usedCursors);
        if (!nextCursor) {
            log.info(`No next cursor after page ${currentPage}.`);
            break;
        }

        usedCursors.add(nextCursor);
        const nextPageUrl = buildSearchJsonUrl(buildId, startUrl, nextCursor);
        const nextResponse = await fetchWithRetries({
            url: nextPageUrl,
            referer: startUrl,
            proxyState,
            sessionId: `list_${Date.now()}_${randomBetween(1000, 9999)}`,
            acceptJson: true,
            maxAttempts: 4,
        });

        if (nextResponse.statusCode >= 400) {
            log.warning(`Pagination request failed: ${nextResponse.statusCode} at page ${currentPage + 1}`);
            break;
        }

        let parsed;
        try {
            parsed = JSON.parse(nextResponse.body);
        } catch {
            log.warning(`Could not parse pagination JSON at page ${currentPage + 1}`);
            break;
        }

        if (!parsed?.pageProps) {
            log.warning(`Missing pageProps in pagination response at page ${currentPage + 1}`);
            break;
        }

        pageProps = parsed.pageProps;
        currentPage = Number(pageProps.currentPageNumber) || (currentPage + 1);
        await sleep(randomBetween(120, 320));
    }
};

await Actor.init();

try {
    const input = (await Actor.getInput()) ?? {};
    const maxJobs = Number(input.results_wanted ?? 20);
    const maxPages = Number(input.max_pages ?? Math.max(10, Math.ceil(maxJobs / 20) + 5));

    if (!Number.isFinite(maxJobs) || maxJobs < 1) {
        throw new Error('Input "results_wanted" must be an integer >= 1.');
    }
    if (!Number.isFinite(maxPages) || maxPages < 1) {
        throw new Error('Input "max_pages" must be an integer >= 1.');
    }

    const startUrls = getStartUrls(input);
    const proxyState = await createProxyState(input.proxyConfiguration);

    const state = {
        pagesProcessed: 0,
        saved: 0,
    };
    const seenJobs = new Set();

    log.info([
        'Starting SimplyHired actor',
        `targetJobs=${maxJobs}`,
        `maxPages=${maxPages}`,
        'mode=api_list_and_detail',
        `proxy=${proxyState.enabled ? 'enabled' : 'disabled'}`,
        `startUrls=${startUrls.length}`,
    ].join(' | '));

    for (const startUrl of startUrls) {
        if (state.saved >= maxJobs) break;
        await scrapeSearch({
            startUrl,
            maxPages,
            maxJobs,
            proxyState,
            seenJobs,
            state,
        });
    }

    log.info(`Finished. savedJobs=${state.saved}, pagesProcessed=${state.pagesProcessed}`);
} finally {
    await Actor.exit();
}
