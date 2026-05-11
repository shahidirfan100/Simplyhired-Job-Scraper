import { readFile } from 'node:fs/promises';

import { Actor, log } from 'apify';
import { load as loadHtml } from 'cheerio';
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const BASE_URL = 'https://www.simplyhired.com';
const DEFAULT_KEYWORD = 'software engineer';
const DEFAULT_LOCATION = 'USA';
const DETAIL_CONCURRENCY = 5;
const headerGenerator = new HeaderGenerator({
    browsers: [
        { name: 'chrome', minVersion: 120, maxVersion: 132 },
        { name: 'firefox', minVersion: 115, maxVersion: 131 },
    ],
    devices: ['desktop'],
    operatingSystems: ['windows', 'macos'],
    locales: ['en-US', 'en'],
});

const sleep = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
});
const randomBetween = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const cleanText = (value) => (value || '').toString().replace(/\s+/g, ' ').trim();
const escapeHtml = (value) => value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;');
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

const isNonEmptyObject = (value) => (
    Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length > 0
);

const loadLocalFallbackInput = async () => {
    const candidates = ['INPUT.json'];

    for (const filePath of candidates) {
        try {
            const raw = await readFile(filePath, 'utf8');
            let data;
            try {
                data = JSON.parse(raw);
            } catch {
                continue;
            }

            if (isNonEmptyObject(data)) {
                log.info(`Using local fallback input from ${filePath}.`);
                return data;
            }
        } catch {
            // Ignore missing local fallback files.
        }
    }

    return {};
};

const toValidUrl = (value) => {
    if (!value) return '';

    try {
        const parsed = new URL(value, BASE_URL);
        if (!/^https?:$/.test(parsed.protocol)) return '';
        return parsed.toString();
    } catch {
        return '';
    }
};

const getStartUrls = (input) => {
    const provided = Array.isArray(input.startUrls)
        ? input.startUrls
            .map((item) => (typeof item === 'string' ? item : item?.url))
            .map((url) => toValidUrl(url))
            .filter(Boolean)
        : [];

    if (provided.length) {
        return provided;
    }

    return [buildSearchUrl(input.keyword, input.location)];
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

const isHtmlResponse = (body, headers) => {
    const contentType = String(headers?.['content-type'] || '').toLowerCase();
    const trimmed = (body || '').trim().toLowerCase();

    return contentType.includes('text/html')
        || trimmed.startsWith('<!doctype')
        || trimmed.startsWith('<html');
};

const tryParseJson = (body) => {
    try {
        return { data: JSON.parse(body), error: null };
    } catch (error) {
        return { data: null, error };
    }
};

const getPageProps = (payload) => (
    payload?.pageProps
    || payload?.props?.pageProps
    || payload?.data?.pageProps
    || null
);

const pickArray = (...candidates) => {
    for (const candidate of candidates) {
        if (Array.isArray(candidate)) return candidate;
    }
    return [];
};

const extractJobsArray = (pageProps) => pickArray(
    pageProps?.jobs,
    pageProps?.jobResults,
    pageProps?.results,
    pageProps?.searchResults?.jobs,
    pageProps?.searchResults?.results,
);

const extractPageCursors = (pageProps) => (
    pageProps?.pageCursors
    || pageProps?.pagination?.pageCursors
    || pageProps?.searchResults?.pageCursors
    || null
);

const extractCurrentPage = (pageProps, fallbackPage) => {
    const candidate = Number(
        pageProps?.currentPageNumber
        ?? pageProps?.pagination?.currentPage
        ?? pageProps?.searchResults?.currentPage
    );
    return Number.isFinite(candidate) && candidate > 0 ? candidate : fallbackPage;
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
    const proxy = proxyState;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let proxyUrl;
        try {
            if (proxy?.enabled && proxy.configuration) {
                proxyUrl = await proxy.configuration.newUrl(activeSession);
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
            const htmlWhenJsonExpected = acceptJson && isHtmlResponse(body, response.headers);
            const blocked = isBlockedStatus(response.statusCode)
                || (!acceptJson && isBlockContent(body))
                || htmlWhenJsonExpected;

            if (htmlWhenJsonExpected) {
                log.warning(`Expected JSON but received HTML for ${url}. Retrying with a fresh session.`);
            }

            if (!blocked || response.statusCode === 404) {
                if (proxy?.enabled && proxyUrl) proxy.failures = 0;
                return {
                    statusCode: response.statusCode,
                    body,
                    headers: response.headers,
                };
            }

            lastError = new Error(`Blocked with status ${response.statusCode}`);
            if (proxy?.enabled && proxyUrl) {
                proxy.failures += 1;
                if (proxy.failures >= 3) {
                    proxy.enabled = false;
                    log.warning('Disabling proxy after repeated blocked responses. Continuing without proxy.');
                }
            }
        } catch (error) {
            lastError = error;
            if (proxy?.enabled && isProxyError(error)) {
                proxy.failures += 1;
                if (proxy.failures >= 2) {
                    proxy.enabled = false;
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
    if (raw) {
        const parsed = tryParseJson(raw).data;
        if (parsed) return parsed;
    }

    const scriptMatch = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!scriptMatch?.[1]) return null;

    const parsed = tryParseJson(scriptMatch[1]).data;
    if (!parsed) {
        log.warning('Found __NEXT_DATA__ script but JSON parsing failed.');
    }
    return parsed;
};

const decodeJobPathFromEncodedUrl = (encodedUrl) => {
    const decoded = tryDecodeURIComponent(encodedUrl || '');
    if (!decoded) return '';

    if (decoded.startsWith('http')) {
        try {
            const parsed = new URL(decoded);
            return parsed.pathname;
        } catch {
            return decoded.split('?')[0];
        }
    }

    return decoded.split('?')[0];
};

const normalizeListJob = (rawJob, sourceSearchUrl) => {
    if (!rawJob || typeof rawJob !== 'object') return null;

    const jobPath = rawJob.botUrl || decodeJobPathFromEncodedUrl(rawJob.encodedUrl) || '';
    const salaryRaw = rawJob.salaryInfo;
    const requirements = toUniqueArray(rawJob.requirements);
    const uncategorized = toUniqueArray(rawJob.uncategorized);
    const skills = toUniqueArray([...uncategorized, ...requirements]);
    const snippet = cleanText(rawJob.snippet);

    return {
        job_key: cleanText(rawJob.jobKey),
        title: cleanText(rawJob.title),
        company: cleanText(rawJob.company),
        location: cleanText(rawJob.location),
        salary: cleanText(typeof salaryRaw === 'string' ? salaryRaw : ''),
        snippet,
        description_text: snippet,
        description_html: snippet ? `<p>${escapeHtml(snippet)}</p>` : '',
        summary: snippet,
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
    const source = new URL(searchUrl, BASE_URL);
    const jsonUrl = new URL(`${BASE_URL}/_next/data/${buildId}/search.json`);

    source.searchParams.forEach((value, key) => jsonUrl.searchParams.append(key, value));
    if (cursor) jsonUrl.searchParams.set('cursor', cursor);
    else jsonUrl.searchParams.delete('cursor');

    return jsonUrl.toString();
};

const buildDetailJsonUrl = (buildId, jobKey) => (
    `${BASE_URL}/_next/data/${buildId}/job/${encodeURIComponent(jobKey)}.json`
);

const pickDescriptionCandidates = (value) => {
    if (!value) return [];

    const out = [];
    const stack = [value];
    let visited = 0;
    const maxVisited = 8000;

    while (stack.length && visited <= maxVisited) {
        const current = stack.pop();
        visited += 1;

        if (!current) continue;

        if (typeof current === 'string') {
            if (cleanText(current).length >= 80) out.push(current);
            continue;
        }

        if (Array.isArray(current)) {
            for (const item of current) stack.push(item);
            continue;
        }

        if (typeof current !== 'object') continue;

        for (const [key, child] of Object.entries(current)) {
            const lowerKey = key.toLowerCase();
            if (typeof child === 'string' && (
                lowerKey.includes('description')
                || lowerKey.includes('about')
                || lowerKey.includes('summary')
                || lowerKey.includes('details')
            )) {
                if (cleanText(child).length >= 80) out.push(child);
            }
            stack.push(child);
        }
    }

    return out;
};

const selectLongestCandidate = (candidates) => {
    if (!Array.isArray(candidates) || !candidates.length) return null;
    return candidates.sort((a, b) => cleanText(b).length - cleanText(a).length)[0] || null;
};

const toDescriptionPair = (candidate, fallbackSnippet) => {
    const fallbackText = cleanText(fallbackSnippet);
    const fallbackHtml = fallbackText ? `<p>${escapeHtml(fallbackText)}</p>` : '';
    if (!candidate) {
        return { descriptionText: fallbackText, descriptionHtml: fallbackHtml };
    }

    const raw = candidate.toString();
    const hasHtml = /<[^>]+>/.test(raw);
    const descriptionHtml = hasHtml ? raw : `<p>${escapeHtml(raw)}</p>`;
    const descriptionText = cleanText(hasHtml ? loadHtml(raw).text() : raw);

    if (descriptionText) {
        return { descriptionText, descriptionHtml };
    }

    return { descriptionText: fallbackText, descriptionHtml: fallbackHtml };
};

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
        let bestCandidate = null;

        const response = await fetchWithRetries({
            url: buildDetailJsonUrl(buildId, job.job_key),
            referer: startUrl,
            proxyState,
            sessionId: `detail_${job.job_key.slice(0, 10)}_${randomBetween(1000, 9999)}`,
            acceptJson: true,
            maxAttempts: 3,
        });

        if (response.statusCode < 400) {
            const { data: parsed } = tryParseJson(response.body);
            if (parsed) {
                const pageProps = getPageProps(parsed) || {};
                const directDescription = pageProps.jobDescriptionHtml
                    || pageProps?.job?.jobDescriptionHtml
                    || pageProps?.job?.descriptionHtml
                    || pageProps?.job?.description
                    || pageProps?.jobDescription;
                const scanned = selectLongestCandidate(pickDescriptionCandidates(parsed));
                bestCandidate = directDescription || scanned;
            }
        }

        const { descriptionText, descriptionHtml } = toDescriptionPair(bestCandidate, job.snippet);

        return {
            ...job,
            description_html: descriptionHtml || job.description_html || '',
            description_text: descriptionText || job.description_text || '',
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
    const initialPageProps = getPageProps(nextData);
    if (!nextData?.buildId || !initialPageProps) {
        throw new Error(`No __NEXT_DATA__ found on ${startUrl}. Playwright fallback may be required for this query.`);
    }

    const { buildId } = nextData;
    const usedCursors = new Set();
    let pageProps = initialPageProps;
    let currentPage = extractCurrentPage(pageProps, 1);
    let pagesFetched = 0;
    let noProgressPages = 0;
    const progress = state;

    log.info(`Search bootstrap OK. buildId=${buildId}, startPage=${currentPage}, startUrl=${startUrl}`);

    while (pagesFetched < maxPages && progress.saved < maxJobs) {
        pagesFetched += 1;
        progress.pagesProcessed += 1;

        const listJobs = extractJobsArray(pageProps);
        if (!listJobs.length) {
            log.warning(`No jobs array found on page ${currentPage}. Stopping this search URL.`);
            break;
        }

        const normalized = listJobs
            .map((job) => normalizeListJob(job, startUrl))
            .filter(Boolean)
            .filter((job) => job.title && job.url);

        const uniqueJobs = [];
        for (const job of normalized) {
            const uniqueKey = job.job_key || job.url;
            if (!uniqueKey || seenJobs.has(uniqueKey)) continue;
            seenJobs.add(uniqueKey);
            uniqueJobs.push(job);
            if (progress.saved + uniqueJobs.length >= maxJobs) break;
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
            progress.saved += withMeta.length;
            noProgressPages = 0;
        } else {
            noProgressPages += 1;
        }

        log.info([
            `Page ${currentPage} processed`,
            `jobsInPage=${listJobs.length}`,
            `newJobs=${uniqueJobs.length}`,
            `savedTotal=${progress.saved}/${maxJobs}`,
        ].join(' | '));

        if (progress.saved >= maxJobs) break;
        if (noProgressPages >= 3) {
            log.warning(`No new jobs found for ${noProgressPages} pages in a row. Stopping to avoid endless pagination.`);
            break;
        }

        const nextCursor = pickNextCursor(extractPageCursors(pageProps), currentPage, usedCursors);
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

        const { data: parsed } = tryParseJson(nextResponse.body);
        if (!parsed) {
            log.warning(`Could not parse pagination JSON at page ${currentPage + 1}`);
            break;
        }

        const nextPageProps = getPageProps(parsed);
        if (!nextPageProps) {
            log.warning(`Missing pageProps in pagination response at page ${currentPage + 1}`);
            break;
        }

        pageProps = nextPageProps;
        currentPage = extractCurrentPage(pageProps, currentPage + 1);
        await sleep(randomBetween(120, 320));
    }
};

await Actor.init();

try {
    const actorInput = (await Actor.getInput()) ?? {};
    const input = isNonEmptyObject(actorInput) ? actorInput : await loadLocalFallbackInput();
    const normalizedInput = {
        ...input,
        keyword: cleanText(input.keyword) || DEFAULT_KEYWORD,
        location: cleanText(input.location) || DEFAULT_LOCATION,
    };

    const maxJobs = Number(normalizedInput.results_wanted ?? 20);
    const maxPages = Number(input.max_pages ?? Math.max(10, Math.ceil(maxJobs / 20) + 5));

    if (!Number.isFinite(maxJobs) || maxJobs < 1) {
        throw new Error('Input "results_wanted" must be an integer >= 1.');
    }
    if (!Number.isFinite(maxPages) || maxPages < 1) {
        throw new Error('Input "max_pages" must be an integer >= 1.');
    }

    const startUrls = getStartUrls(normalizedInput);
    if (!startUrls.length) {
        throw new Error('No valid start URLs could be built from the provided input.');
    }
    const proxyState = await createProxyState(normalizedInput.proxyConfiguration);

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

    if (state.saved === 0) {
        throw new Error('No jobs were extracted. Check input query/start URL or possible upstream API/response changes.');
    }

    log.info(`Finished. savedJobs=${state.saved}, pagesProcessed=${state.pagesProcessed}`);
} finally {
    await Actor.exit();
}
