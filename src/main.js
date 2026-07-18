import { readFile } from 'node:fs/promises';

import { Actor, log } from 'apify';
import { load as loadHtml } from 'cheerio';
import { Impit } from 'impit';

const BASE_URL = 'https://www.simplyhired.com';
const DETAIL_CONCURRENCY = 5;
const REQUEST_TIMEOUT_MS = 20000;
const PAGE_PROGRESS_LOG_INTERVAL = 10;
const MAX_AUTO_PAGE_BUDGET = 250;
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const ALLOWED_DESCRIPTION_TAGS = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'ul', 'ol', 'li']);
const impitClients = new Map();

const getImpitClient = (proxyUrl, sessionKey = '') => {
    const key = proxyUrl || sessionKey || 'direct';
    if (!impitClients.has(key)) {
        impitClients.set(key, new Impit({
            browser: 'chrome',
            ignoreTlsErrors: true,
            ...(proxyUrl && { proxyUrl }),
        }));
    }

    return impitClients.get(key);
};

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
const isRetryableStatus = (status) => RETRYABLE_STATUS_CODES.has(Number(status));
const getObjectValue = (value, ...keys) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;

    for (const key of keys) {
        if (Object.hasOwn(value, key)) return value[key];

        const lowerKey = key.toLowerCase();
        const match = Object.keys(value).find((candidate) => candidate.toLowerCase() === lowerKey);
        if (match) return value[match];
    }

    return undefined;
};
const getSearchParam = (params, key) => {
    const lowerKey = key.toLowerCase();
    for (const [candidate, value] of params.entries()) {
        if (candidate.toLowerCase() === lowerKey) return value;
    }

    return '';
};
const parseRetryAfterMs = (headers) => {
    const retryAfter = getObjectValue(headers, 'retry-after');
    if (!retryAfter) return 0;

    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 10000);

    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) return Math.min(Math.max(retryAt - Date.now(), 0), 10000);

    return 0;
};
const toIsoFromMs = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '';
    return new Date(n).toISOString();
};

const absoluteUrl = (value) => {
    const cleaned = cleanText(value);
    if (!cleaned) return '';

    try {
        return new URL(cleaned, BASE_URL).toString();
    } catch {
        return '';
    }
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

const toPositiveInteger = (value, fallback, fieldName) => {
    if (value === undefined || value === null || value === '') return fallback;

    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= 1) return parsed;

    log.warning(`Invalid "${fieldName}" value "${value}". Using ${fallback}.`);
    return fallback;
};
const getPageBudget = (requestedPages, maxJobs) => {
    const duplicateTolerantPages = Math.ceil(maxJobs / 5);
    return Math.min(Math.max(requestedPages, duplicateTolerantPages), MAX_AUTO_PAGE_BUDGET);
};

const normalizeSearchUrl = (value) => {
    const cleaned = cleanText(value);
    if (!cleaned) return '';

    try {
        const parsed = new URL(cleaned, BASE_URL);
        const host = parsed.hostname.toLowerCase();
        if (!/^https?:$/.test(parsed.protocol)) return '';
        if (host !== 'simplyhired.com' && !host.endsWith('.simplyhired.com')) return '';

        parsed.hash = '';
        if (!parsed.pathname || parsed.pathname === '/') parsed.pathname = '/search';
        return parsed.toString();
    } catch {
        return '';
    }
};

const buildSearchUrlFallbacks = (url, input) => {
    const normalized = normalizeSearchUrl(url);
    if (!normalized) return [];

    const parsed = new URL(normalized);
    const keyword = cleanText(getSearchParam(parsed.searchParams, 'q') || input.keyword);
    const location = cleanText(getSearchParam(parsed.searchParams, 'l') || input.location);
    const out = [normalized];

    if (keyword || location) {
        out.push(buildSearchUrl(keyword, location));
    }

    return out;
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

const getStartUrls = (input) => {
    let startUrlItems = [];
    if (Array.isArray(input.startUrls)) {
        startUrlItems = input.startUrls;
    } else if (input.startUrls) {
        startUrlItems = [input.startUrls];
    }
    const provided = startUrlItems
        .map((item) => (typeof item === 'string' ? item : item?.url))
        .flatMap((url) => buildSearchUrlFallbacks(url, input))
        .filter(Boolean);

    if (startUrlItems.length && !provided.length) {
        log.warning('No valid SimplyHired start URLs found in input. Falling back to keyword/location search.');
    }

    if (provided.length) {
        return [...new Set(provided)];
    }

    return [buildSearchUrl(input.keyword, input.location)];
};

const normalizeProxyInput = (proxyConfigurationInput) => {
    if (!proxyConfigurationInput || typeof proxyConfigurationInput !== 'object') {
        return { useApifyProxy: Actor.isAtHome() };
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
        if (Actor.isAtHome()) {
            throw new Error(`Proxy initialization failed on Apify Cloud: ${error.message}`);
        }

        log.warning(`Proxy initialization failed, continuing without proxy: ${error.message}`);
        return { configuration: null, enabled: false, failures: 0 };
    }
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
        return { data: JSON.parse((body || '').trim()), error: null };
    } catch (error) {
        return { data: null, error };
    }
};

const getPageProps = (payload) => (
    getObjectValue(payload, 'pageProps')
    || getObjectValue(getObjectValue(payload, 'props'), 'pageProps')
    || getObjectValue(getObjectValue(payload, 'data'), 'pageProps')
    || null
);

const pickArray = (...candidates) => {
    for (const candidate of candidates) {
        if (Array.isArray(candidate)) return candidate;
    }
    return [];
};

const extractJobsArray = (pageProps) => pickArray(
    getObjectValue(pageProps, 'jobs'),
    getObjectValue(pageProps, 'jobResults'),
    getObjectValue(pageProps, 'results'),
    getObjectValue(getObjectValue(pageProps, 'searchResults'), 'jobs'),
    getObjectValue(getObjectValue(pageProps, 'searchResults'), 'results'),
);

const extractPageCursors = (pageProps) => (
    getObjectValue(pageProps, 'pageCursors')
    || getObjectValue(getObjectValue(pageProps, 'pagination'), 'pageCursors')
    || getObjectValue(getObjectValue(pageProps, 'searchResults'), 'pageCursors')
    || null
);

const extractCurrentPage = (pageProps, fallbackPage) => {
    const candidate = Number(
        getObjectValue(pageProps, 'currentPageNumber')
        ?? getObjectValue(getObjectValue(pageProps, 'pagination'), 'currentPage')
        ?? getObjectValue(getObjectValue(pageProps, 'searchResults'), 'currentPage')
    );
    return Number.isFinite(candidate) && candidate > 0 ? candidate : fallbackPage;
};

const getNextDataPayloadFromHtml = (html) => {
    const $ = loadHtml(html);
    const raw = $('#__NEXT_DATA__').text() || $('[id]').filter((_, element) => (
        String($(element).attr('id')).toLowerCase() === '__next_data__'
    )).first().text();
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

const fetchWithRetries = async ({
    url,
    referer,
    proxyState,
    sessionId,
    acceptJson = false,
    maxAttempts = 4,
    quietRetries = true,
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

            const client = getImpitClient(proxyUrl, attempt === 1 ? '' : activeSession);
            const response = await client.fetch(url, {
                headers: {
                    referer: referer || `${BASE_URL}/`,
                },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                redirect: 'follow',
            });

            const body = await response.text();
            const headers = Object.fromEntries(response.headers.entries());
            const statusCode = response.status;
            const htmlWhenJsonExpected = acceptJson && isHtmlResponse(body, headers);
            const blocked = isBlockedStatus(statusCode)
                || (!acceptJson && isBlockContent(body))
                || htmlWhenJsonExpected;

            if (htmlWhenJsonExpected) {
                const htmlPayload = getNextDataPayloadFromHtml(body);
                if (htmlPayload) {
                    log.debug(`Parsed __NEXT_DATA__ HTML fallback for ${url}.`);
                    if (proxy?.enabled && proxyUrl) proxy.failures = 0;
                    return {
                        statusCode,
                        body: JSON.stringify(htmlPayload),
                        headers,
                    };
                }

                log.debug(`Expected JSON but received HTML for ${url}. Retrying with a fresh session.`);
            }

            if (!blocked && !isRetryableStatus(statusCode)) {
                if (proxy?.enabled && proxyUrl) proxy.failures = 0;
                return {
                    statusCode,
                    body,
                    headers,
                };
            }

            if (statusCode === 404) {
                if (proxy?.enabled && proxyUrl) proxy.failures = 0;
                return {
                    statusCode,
                    body,
                    headers,
                };
            }

            lastError = Object.assign(new Error(`Temporary request failure with status ${statusCode}`), { headers });
            if (proxy?.enabled && proxyUrl) {
                proxy.failures += 1;
            }
        } catch (error) {
            lastError = error;
            if (proxy?.enabled && isProxyError(error)) {
                proxy.failures += 1;
                if (proxy.failures >= 2 && !Actor.isAtHome()) {
                    proxy.enabled = false;
                    log.warning(`Disabling proxy after repeated proxy failures: ${error.message}`);
                }
            }
        }

        if (attempt < maxAttempts) {
            activeSession = `retry_${Date.now()}_${randomBetween(1000, 9999)}`;
            const retryAfterMs = parseRetryAfterMs(lastError?.headers || {});
            const retryDelayMs = retryAfterMs || randomBetween(500 * attempt, 1200 * attempt);
            if (quietRetries) {
                log.debug(`Retrying request after ${Math.round(retryDelayMs)}ms (${attempt}/${maxAttempts}) for ${url}`);
            } else {
                log.warning(`Retrying request after ${Math.round(retryDelayMs)}ms (${attempt}/${maxAttempts}) for ${url}`);
            }
            await sleep(retryDelayMs);
        }
    }

    throw lastError || new Error(`Request failed: ${url}`);
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

    const jobPath = getObjectValue(rawJob, 'botUrl', 'url')
        || decodeJobPathFromEncodedUrl(getObjectValue(rawJob, 'encodedUrl'))
        || '';
    const salaryRaw = getObjectValue(rawJob, 'salaryInfo', 'salary');
    const requirements = toUniqueArray(getObjectValue(rawJob, 'requirements'));
    const uncategorized = toUniqueArray(getObjectValue(rawJob, 'uncategorized'));
    const skills = toUniqueArray([...uncategorized, ...requirements]);
    const snippet = cleanText(getObjectValue(rawJob, 'snippet', 'summary'));
    const benefits = getObjectValue(rawJob, 'benefits');
    const jobTypes = getObjectValue(rawJob, 'jobTypes', 'jobType');
    const remoteAttributes = getObjectValue(rawJob, 'remoteAttributes');

    return {
        job_key: cleanText(getObjectValue(rawJob, 'jobKey')),
        title: cleanText(getObjectValue(rawJob, 'title')),
        company: cleanText(getObjectValue(rawJob, 'company')),
        location: cleanText(getObjectValue(rawJob, 'location')),
        salary: cleanText(typeof salaryRaw === 'string' ? salaryRaw : ''),
        snippet,
        description_text: snippet,
        description_html: snippet ? `<p>${escapeHtml(snippet)}</p>` : '',
        summary: snippet,
        requirements,
        skills,
        benefits: Array.isArray(benefits) ? benefits : [],
        job_type: Array.isArray(jobTypes) ? jobTypes.join(', ') : cleanText(jobTypes),
        remote_attributes: Array.isArray(remoteAttributes) ? remoteAttributes : [],
        sponsored: Boolean(getObjectValue(rawJob, 'sponsored')),
        company_rating: Number.isFinite(Number(getObjectValue(rawJob, 'companyRating')))
            ? Number(getObjectValue(rawJob, 'companyRating'))
            : null,
        date_posted: toIsoFromMs(getObjectValue(rawJob, 'dateOnIndeed', 'datePosted')),
        url: absoluteUrl(jobPath || ''),
        company_page_url: absoluteUrl(getObjectValue(rawJob, 'companyPageUrl') || ''),
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

    const keyword = getSearchParam(source.searchParams, 'q');
    const location = getSearchParam(source.searchParams, 'l');
    if (keyword) jsonUrl.searchParams.set('q', keyword);
    if (location) jsonUrl.searchParams.set('l', location);
    source.searchParams.forEach((value, key) => {
        const lowerKey = key.toLowerCase();
        if (['cursor', 'l', 'q'].includes(lowerKey)) return;
        jsonUrl.searchParams.append(key, value);
    });
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

const sanitizeDescriptionHtml = (value) => {
    const raw = (value || '').toString().trim();
    if (!raw) return '';

    if (!/<[^>]+>/.test(raw)) {
        return `<p>${escapeHtml(raw)}</p>`;
    }

    const $ = loadHtml(raw, null, false);
    $('script,style,noscript,iframe,svg,canvas,form,input,button,select,textarea,link,meta').remove();

    let changed = true;
    while (changed) {
        changed = false;
        for (const element of $('*').toArray()) {
            const tagName = element.tagName?.toLowerCase();
            if (!tagName) continue;

            if (ALLOWED_DESCRIPTION_TAGS.has(tagName)) {
                for (const attribute of Object.keys(element.attribs || {})) {
                    $(element).removeAttr(attribute);
                }
                continue;
            }

            changed = true;
            const contents = $(element).contents();
            if (['article', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section'].includes(tagName)) {
                const wrapper = $('<p></p>');
                wrapper.append(contents);
                $(element).replaceWith(wrapper);
            } else {
                $(element).replaceWith(contents);
            }
        }
    }

    $('p').each((_, element) => {
        if (!cleanText($(element).text()) && !$(element).find('br').length) {
            $(element).remove();
        }
    });

    return ($.root().html() || '').trim();
};

const toDescriptionPair = (candidate, fallbackSnippet) => {
    const fallbackText = cleanText(fallbackSnippet);
    const fallbackHtml = fallbackText ? `<p>${escapeHtml(fallbackText)}</p>` : '';
    if (!candidate) {
        return { descriptionText: fallbackText, descriptionHtml: fallbackHtml };
    }

    const raw = candidate.toString();
    const hasHtml = /<[^>]+>/.test(raw);
    const descriptionHtml = sanitizeDescriptionHtml(raw);
    const descriptionText = cleanText(hasHtml ? loadHtml(descriptionHtml).text() : raw);

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
                const jobData = getObjectValue(pageProps, 'job') || {};
                const directDescription = getObjectValue(pageProps, 'jobDescriptionHtml', 'jobDescription')
                    || getObjectValue(jobData, 'jobDescriptionHtml', 'descriptionHtml', 'description');
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
        maxAttempts: 8,
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

    log.debug(`Search bootstrap OK. buildId=${buildId}, startPage=${currentPage}, startUrl=${startUrl}`);

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

        if (
            pagesFetched === 1
            || progress.saved >= maxJobs
            || pagesFetched % PAGE_PROGRESS_LOG_INTERVAL === 0
        ) {
            log.info([
                `Page ${currentPage} processed`,
                `jobsInPage=${listJobs.length}`,
                `newJobs=${uniqueJobs.length}`,
                `savedTotal=${progress.saved}/${maxJobs}`,
            ].join(' | '));
        } else {
            log.debug([
                `Page ${currentPage} processed`,
                `jobsInPage=${listJobs.length}`,
                `newJobs=${uniqueJobs.length}`,
                `savedTotal=${progress.saved}/${maxJobs}`,
            ].join(' | '));
        }

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
    }
};

await Actor.init();

try {
    const actorInput = (await Actor.getInput()) ?? {};
    const input = isNonEmptyObject(actorInput) ? actorInput : await loadLocalFallbackInput();
    const normalizedInput = {
        ...input,
        keyword: cleanText(input.keyword),
        location: cleanText(input.location),
    };

    const maxJobs = toPositiveInteger(normalizedInput.results_wanted, 20, 'results_wanted');
    const requestedMaxPages = toPositiveInteger(
        normalizedInput.max_pages,
        Math.max(10, Math.ceil(maxJobs / 20) + 5),
        'max_pages',
    );
    const maxPages = getPageBudget(requestedMaxPages, maxJobs);

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
        try {
            await scrapeSearch({
                startUrl,
                maxPages,
                maxJobs,
                proxyState,
                seenJobs,
                state,
            });
        } catch (error) {
            log.warning(`Skipping failed search URL ${startUrl}: ${error.message}`);
        }
    }

    if (state.saved === 0) {
        throw new Error('No jobs were extracted. Check input query/start URL or possible upstream API/response changes.');
    }

    log.info(`Finished. savedJobs=${state.saved}, pagesProcessed=${state.pagesProcessed}`);
} finally {
    await Actor.exit();
}
