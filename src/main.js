// src/main.js
// ============================================================================
// SIMPLYHIRED JOB SCRAPER - COMPREHENSIVE APIFY ACTOR
// HTTP-based scraping with CheerioCrawler for maximum speed and efficiency
// ============================================================================

import { Actor } from 'apify';
import { CheerioCrawler, createCheerioRouter, Dataset, log } from 'crawlee';

// ============================================================================
// ROUTER SETUP
// ============================================================================
export const router = createCheerioRouter();

// ============================================================================
// GLOBAL STATE & COUNTERS
// ============================================================================
let jobsProcessed = 0;      // Total jobs enqueued for detail scraping
let pagesProcessed = 0;     // Total listing pages processed
let crawlerTerminated = false;
let savedJobs = 0;          // Actual jobs saved to dataset

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Converts relative URLs to absolute URLs for SimplyHired
 */
const absolute = (href) => {
    if (!href) return null;
    if (href.startsWith('http')) return href;
    if (href.startsWith('/')) return `https://www.simplyhired.com${href}`;
    return `https://www.simplyhired.com/${href}`;
};

// ============================================================================
// ROUTE HANDLERS
// ============================================================================

/**
 * LIST HANDLER - Scrapes job listings from search results pages
 * Uses Cheerio to parse HTML and extract job cards
 */
router.addDefaultHandler(async ({ $, enqueueLinks, request, crawler }) => {
    pagesProcessed++;
    
    const maxJobs = crawler.maxJobs || 200;
    const maxPages = crawler.maxPagesPerList || 20;
    
    log.info(`🔍 LIST HANDLER called for page ${pagesProcessed}`);
    
    // Early exit conditions
    if (jobsProcessed >= maxJobs || crawlerTerminated) {
        log.info(`Skipping - already at target (${jobsProcessed}/${maxJobs})`);
        return;
    }
    
    if (pagesProcessed > maxPages) {
        log.info(`📄 Reached page limit of ${maxPages}`);
        return;
    }

    log.info(`📋 Scraping listing page ${pagesProcessed}: ${request.url}`);

    // Validate we got HTML content
    const html = $.html();
    if (!html || html.length < 1000) {
        log.warning(`⚠️ Received very short or empty HTML response (${html?.length || 0} bytes)`);
        log.warning(`Response preview: ${html?.substring(0, 500)}`);
        return;
    }
    
    log.info(`✓ Received HTML content: ${html.length} bytes`);

    // ========================================================================
    // ENHANCED JOB EXTRACTION - Updated for SimplyHired's current structure
    // ========================================================================
    const jobs = [];
    
    // NEW STRATEGY: SimplyHired 2025 structure - jobs are in h2 > a elements
    // Each job card is within an article or div containing h2 > a[href*="/job/"]
    
    log.info('Looking for job links with selector: h2 > a[href*="/job/"]');
    const jobLinks = $('h2 > a[href*="/job/"]');
    
    log.info(`✓ Found ${jobLinks.length} job links on the page`);
    
    // ALTERNATIVE: Try finding just any link with /job/ in it
    if (jobLinks.length === 0) {
        log.warning('No h2 > a job links found, trying alternative selector: a[href*="/job/"]');
        const altJobLinks = $('a[href*="/job/"]');
        log.info(`Alternative selector found ${altJobLinks.length} links`);
        
        // Log first few links for debugging
        altJobLinks.slice(0, 5).each((i, el) => {
            log.info(`  Sample link ${i + 1}: ${$(el).attr('href')} - Text: ${$(el).text().trim().substring(0, 50)}`);
        });
    }
    
    if (jobLinks.length === 0) {
        log.error('❌ No job links found on page. Website structure may have changed or page is blocked.');
        log.info('Checking page title and content...');
        log.info(`Page title: ${$('title').text()}`);
        log.info(`Page has h1: ${$('h1').length} found`);
        log.info(`Page has h2: ${$('h2').length} found`);
        log.info(`Total links on page: ${$('a').length}`);
        
        // Save HTML for debugging
        const debugHtml = $.html();
        log.info(`HTML snippet: ${debugHtml.substring(0, 1000)}`);
    }
    
    jobLinks.each((_, element) => {
        const titleLink = $(element);
        
        try {
            // Get title from the link text
            const title = titleLink.text().trim();
            const link = titleLink.attr('href');
            
            if (!title || !link) return;
            
            // Find the parent container (article, section, or div)
            let container = titleLink.closest('article');
            if (!container.length) container = titleLink.closest('section');
            if (!container.length) container = titleLink.closest('div');
            
            // Extract company - usually text before/after the title
            let company = '';
            // Try to find company name in the container (usually plain text or in a span/div)
            const companyText = container.find('*').filter(function() {
                return $(this).children().length === 0 && $(this).text().trim().length > 0;
            });
            companyText.each((_, el) => {
                const text = $(el).text().trim();
                // Company name is usually after title, not a date/time, not salary
                if (text && 
                    text !== title && 
                    !text.match(/^\d+[dhm]$/i) && 
                    !text.match(/ago$/i) &&
                    !text.match(/^\$[\d,]+/)) {
                    if (!company) company = text;
                }
            });
            
            // Extract location - usually has city/state format or "Remote"
            let location = '';
            container.find('*').each((_, el) => {
                const text = $(el).text().trim();
                if (text.match(/^[A-Z][a-z]+,\s*[A-Z]{2}$/i) || text === 'Remote' || text.match(/—.*$/)) {
                    location = text.replace(/—/g, '').trim();
                    return false;
                }
            });
            
            // Extract summary - longer text content in the container
            let summary = '';
            container.find('p, div').each((_, el) => {
                const text = $(el).text().trim();
                if (text.length > 50 && text !== title) {
                    summary = text;
                    return false;
                }
            });
            
            // Extract salary - contains dollar sign and numbers
            let salary = '';
            container.find('*').each((_, el) => {
                const text = $(el).text().trim();
                if (text.match(/\$[\d,]+/)) {
                    salary = text;
                    return false;
                }
            });

            jobs.push({ title, link, company, location, summary, salary });
        } catch (err) {
            log.error('Error parsing job card:', err.message);
        }
    });

    if (jobs.length === 0) {
        log.warning('⚠️ No jobs found on page. Website structure may have changed.');
        return;
    }

    // ========================================================================
    // ENQUEUE DETAIL PAGES - Respect limits
    // ========================================================================
    const remainingCapacity = Math.max(0, maxJobs - jobsProcessed);
    const jobsToProcess = Math.min(jobs.length, remainingCapacity);
    
    if (remainingCapacity <= 0 || crawlerTerminated) {
        return;
    }

    // Enqueue detail pages with precise limit
    for (let i = 0; i < jobsToProcess; i++) {
        const job = jobs[i];
        const url = absolute(job.link);
        if (url) {
            await enqueueLinks({
                urls: [url],
                label: 'DETAIL',
                userData: { jobMeta: job },
            });
        }
    }
    
    jobsProcessed += jobsToProcess;
    
    // Log progress every 5 pages to reduce overhead
    if (pagesProcessed % 5 === 1 || pagesProcessed === 1) {
        log.info(`📤 Progress: ${jobsProcessed}/${maxJobs} jobs enqueued from ${pagesProcessed} pages`);
    }

    // ========================================================================
    // PAGINATION DETECTION - Updated for SimplyHired 2025
    // ========================================================================
    let nextHref = null;
    
    // Look for "Next page" link in pagination
    const paginationLinks = $('a[href*="cursor="]');
    paginationLinks.each((_, link) => {
        const $link = $(link);
        const text = $link.text().toLowerCase().trim();
        const ariaLabel = $link.attr('aria-label')?.toLowerCase() || '';
        
        if (text.includes('next') || ariaLabel.includes('next')) {
            nextHref = $link.attr('href');
            return false; // break
        }
    });
    
    // Fallback: find any link with cursor parameter (pagination)
    if (!nextHref && paginationLinks.length > 0) {
        // Get the last pagination link (usually "next")
        nextHref = paginationLinks.last().attr('href');
    }

    // Check if we should continue pagination
    const shouldContinue = nextHref && 
                          jobsProcessed < maxJobs && 
                          pagesProcessed < maxPages;
    
    if (shouldContinue) {
        const nextUrl = absolute(nextHref);
        await enqueueLinks({ urls: [nextUrl], label: 'LIST' });
        log.info(`➡️ Enqueued next page: ${nextUrl}`);
    } else if (jobsProcessed >= maxJobs) {
        log.info(`🎯 Target reached: ${maxJobs} jobs enqueued`);
    } else if (!nextHref) {
        log.info(`📄 No more pages found. Completed pagination.`);
    }
});

/**
 * DETAIL HANDLER - Scrapes full job details from individual job pages
 * Uses Cheerio with enhanced selectors to extract comprehensive job data
 */
router.addHandler('DETAIL', async ({ $, request, crawler }) => {
    const meta = request.userData?.jobMeta ?? {};
    const maxJobs = crawler.maxJobs || 200;
    
    log.info(`📄 DETAIL HANDLER called for job: ${meta.title || 'Unknown'}`);
    
    // Check if we've already reached our target
    if (savedJobs >= maxJobs || crawlerTerminated) {
        log.info(`Skipping detail - already at target (${savedJobs}/${maxJobs})`);
        return;
    }

    // ========================================================================
    // SIMPLIFIED DETAIL EXTRACTION - Updated for SimplyHired 2025
    // ========================================================================
    
    const body = $('body');
    
    // Extract job title - usually in h1 or h2
    const title = meta.title || 
                  $('h1').first().text().trim() || 
                  $('h2').first().text().trim() ||
                  '';
    
    // Extract company - look for text patterns or company name
    let company = meta.company || '';
    if (!company) {
        // Find company name (usually displayed prominently)
        $('div, span, p').each((_, el) => {
            const text = $(el).text().trim();
            if (text && text.length < 100 && text.length > 2 && !text.includes('$') && !company) {
                // Simple heuristic: company name is usually short and doesn't contain job-related keywords
                if (!text.match(/ago|apply|job|full|part|time|posted|description|qualifications|responsibilities/i)) {
                    company = text;
                    return false;
                }
            }
        });
    }
    
    // Extract location
    let location = meta.location || '';
    if (!location) {
        $('*').each((_, el) => {
            const text = $(el).text().trim();
            if (text.match(/^[A-Z][a-z]+,\s*[A-Z]{2}$/i) || text === 'Remote') {
                location = text;
                return false;
            }
        });
    }
    
    // Extract salary - look for dollar signs
    let salary = meta.salary || '';
    if (!salary) {
        $('*').each((_, el) => {
            const text = $(el).text().trim();
            if (text.match(/\$[\d,]+.*(?:hour|year|month)/i)) {
                salary = text;
                return false;
            }
        });
    }
    
    // Extract employment type
    let employment_type = '';
    $('*').each((_, el) => {
        const text = $(el).text().trim();
        if (text.match(/^(Full-time|Part-time|Contract|Temporary|Internship|Freelance)$/i)) {
            employment_type = text;
            return false;
        }
    });
    
    // Extract posted date
    let posted = '';
    $('time').each((_, el) => {
        posted = $(el).attr('datetime') || $(el).text().trim();
        return false;
    });
    if (!posted) {
        $('*').each((_, el) => {
            const text = $(el).text().trim();
            if (text.match(/\d+\s*(day|week|month|hour)s?\s*ago|yesterday|today/i)) {
                posted = text;
                return false;
            }
        });
    }
    
    // Extract full description
    let description_text = '';
    let description_html = '';
    
    // Look for the main content area with job description
    // Try to find sections with "description", "responsibilities", "qualifications", etc.
    const mainContent = $('main, article, [role="main"], #content, .content, .job-description, .description').first();
    
    if (mainContent.length) {
        // Clone and clean
        const cleaned = mainContent.clone();
        
        // Remove unwanted elements
        cleaned.find('header, nav, footer, script, style, .ad, .advertisement, .related-jobs, .similar-jobs').remove();
        
        description_text = cleaned.text().trim();
        description_html = cleaned.html() || '';
    } else {
        // Fallback: get all text from body, excluding common non-description sections
        const bodyClone = body.clone();
        bodyClone.find('header, nav, footer, script, style, .ad, .advertisement').remove();
        description_text = bodyClone.text().trim();
        description_html = bodyClone.html() || '';
    }
    
    // Clean up description text
    description_text = description_text
        .replace(/\s+/g, ' ')
        .replace(/\n+/g, '\n')
        .trim();

    // ========================================================================
    // BUILD & SAVE FINAL ITEM
    // ========================================================================
    
    const item = {
        title: title.slice(0, 200),
        company: company || meta.company || '',
        location: location || meta.location || '',
        summary: meta.summary || '',
        salary: salary || meta.salary || '',
        employment_type: employment_type || '',
        posted: posted || '',
        description_text: description_text || '',
        description_html: description_html || '',
        url: request.loadedUrl || request.url,
        crawledAt: new Date().toISOString(),
    };

    try {
        await Dataset.pushData(item);
        savedJobs++;
        
        // Log progress every 10 jobs or when reaching target
        if (savedJobs % 10 === 0 || savedJobs === maxJobs) {
            log.info(`✅ Progress: ${savedJobs}/${maxJobs} jobs saved`);
        }

        // Check if we've reached target and terminate
        if (savedJobs >= maxJobs && !crawlerTerminated) {
            crawlerTerminated = true;
            log.info(`🎯 Target reached! ${savedJobs} jobs collected. Terminating crawler...`);
            try {
                await crawler.teardown();
            } catch (error) {
                log.warning('Error during crawler teardown:', error.message);
            }
            return;
        }
    } catch (e) {
        log.error('Failed to push to dataset:', e.message);
    }
});

// ============================================================================
// MAIN ACTOR LOGIC
// ============================================================================

await Actor.init();

// Get Actor input
const input = (await Actor.getInput()) ?? {};

log.info('Actor initialized');
log.info(`Input received: ${JSON.stringify(input, null, 2)}`);

// ============================================================================
// SEARCH URL BUILDER
// ============================================================================

/**
 * Builds search URLs from keywords and location parameters
 * Supports comma-separated keywords for multiple searches
 */
function buildSearchUrls(keywords, location, datePosted, remoteOnly) {
    const baseUrl = 'https://www.simplyhired.com/search';
    const urls = [];
    
    // Handle keywords - can be a single string or comma-separated
    const keywordList = keywords ? keywords.split(',').map(k => k.trim()) : [''];
    
    // Handle location
    let locationParam = '';
    if (remoteOnly) {
        locationParam = 'Remote';
    } else if (location) {
        locationParam = location.trim();
    }
    
    for (const keyword of keywordList) {
        const params = new URLSearchParams();
        
        if (keyword) params.set('q', keyword);
        if (locationParam) params.set('l', locationParam);
        
        // Add date filter if specified (1, 7, 30 days)
        if (datePosted && datePosted !== 'any') {
            params.set('fdb', datePosted);
        }
        
        // Ensures we're on job search
        params.set('job', '');
        
        const url = `${baseUrl}?${params.toString()}`;
        urls.push(url);
    }
    
    return urls;
}

// ============================================================================
// DETERMINE START URLs
// ============================================================================

let startUrls = [];

if (input.startUrls && input.startUrls.length > 0) {
    // User-provided URLs - handle both string array and object array formats
    startUrls = input.startUrls.map(urlObj => {
        if (typeof urlObj === 'string') {
            return urlObj;
        } else if (urlObj.url) {
            return urlObj.url;
        }
        return null;
    }).filter(url => url !== null);
    
    log.info(`Using ${startUrls.length} custom start URLs`);
} else if (input.keywords || input.location || input.remote_only) {
    // Build URLs from search parameters
    startUrls = buildSearchUrls(
        input.keywords, 
        input.location, 
        input.date_posted, 
        input.remote_only
    );
    
    log.info(`Built ${startUrls.length} search URLs from keywords/location`);
} else {
    // Fallback to default search
    startUrls = ['https://www.simplyhired.com/search?q=software+engineer&l='];
    log.info('Using default search URL');
}

// Validate startUrls
if (!startUrls || startUrls.length === 0) {
    throw new Error('No start URLs provided or generated. Please provide keywords, location, or custom URLs.');
}

log.info(`Start URLs: ${JSON.stringify(startUrls, null, 2)}`);

// ============================================================================
// PROXY CONFIGURATION
// ============================================================================

let proxyConfiguration;
try {
    if (input.proxyConfiguration) {
        // Use user-provided proxy configuration
        const proxyConfig = input.proxyConfiguration;
        
        log.info(`Proxy config received: ${JSON.stringify(proxyConfig)}`);
        
        // If apifyProxyGroups is empty array, use RESIDENTIAL as default
        if (proxyConfig.useApifyProxy && (!proxyConfig.apifyProxyGroups || proxyConfig.apifyProxyGroups.length === 0)) {
            proxyConfig.apifyProxyGroups = ['RESIDENTIAL'];
        }
        
        proxyConfiguration = await Actor.createProxyConfiguration(proxyConfig);
    } else {
        // Default configuration with RESIDENTIAL proxies
        log.info('No proxy config provided, using default RESIDENTIAL proxies');
        proxyConfiguration = await Actor.createProxyConfiguration({
            useApifyProxy: true,
            groups: ['RESIDENTIAL'],
            countryCode: 'US',
        });
    }
    
    log.info('Proxy configuration created successfully');
} catch (error) {
    log.error(`Error creating proxy configuration: ${error.message}`);
    log.warning('Continuing without proxies - may result in blocking');
    proxyConfiguration = await Actor.createProxyConfiguration();
}

// ============================================================================
// ENHANCED USER AGENT ROTATION
// ============================================================================

const userAgents = [
    // Chrome variants (most common)
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    // Firefox variants
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0',
    // Safari variants
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
];

const randomUA = () => userAgents[Math.floor(Math.random() * userAgents.length)];

// ============================================================================
// CONFIGURE LIMITS
// ============================================================================

const maxJobs = input.results_wanted ?? 200;
const maxPages = input.maxPagesPerList ?? 20;
const maxConcurrency = input.maxConcurrency ?? 30; // Optimized for HTTP requests

// ============================================================================
// CHEERIO CRAWLER SETUP - OPTIMIZED FOR SPEED & ANTI-BLOCKING
// ============================================================================


const crawler = new CheerioCrawler({
    proxyConfiguration,
    requestHandler: router,
    maxConcurrency: maxConcurrency,
    maxRequestsPerCrawl: Math.min(maxJobs * 5, 3000),
    maxRequestRetries: 3,
    requestHandlerTimeoutSecs: 120,
    useSessionPool: true,
    persistCookiesPerSession: true,
    
    // Reduce concurrency to avoid rate limiting
    minConcurrency: 1,
    
    sessionPoolOptions: {
        maxPoolSize: Math.max(20, maxConcurrency * 2),
        sessionOptions: {
            maxUsageCount: 20,
            maxErrorScore: 3,
            maxAgeSecs: 1800,
        },
    },
    
    preNavigationHooks: [
        async ({ request, session }) => {
            // Rotate user-agent per session
            if (!session.userData.userAgent) {
                session.userData.userAgent = randomUA();
            }
            
            // REDUCED DELAY - Only add small delay to avoid looking like a bot
            // The session pool and proxy rotation already help with anti-blocking
            const delay = 200 + Math.random() * 300; // 200-500ms instead of 1-3 seconds
            await new Promise(resolve => setTimeout(resolve, delay));
            
            request.headers = {
                ...request.headers,
                'user-agent': session.userData.userAgent,
                'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'accept-language': 'en-US,en;q=0.9',
                'accept-encoding': 'gzip, deflate, br',
                'cache-control': 'max-age=0',
                'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
                'sec-fetch-dest': 'document',
                'sec-fetch-mode': 'navigate',
                'sec-fetch-site': 'same-origin',
                'sec-fetch-user': '?1',
                'upgrade-insecure-requests': '1',
                'referer': 'https://www.simplyhired.com/',
            };
            
            log.debug(`Request to: ${request.url}`);
        },
    ],
    
    failedRequestHandler: async ({ request, error }) => {
        log.error(`❌ Request failed: ${request.url}`, {
            error: error?.message,
            retryCount: request.retryCount,
            label: request.userData?.label,
        });
    },
});

// Store configuration in crawler for access in handlers
crawler.maxJobs = maxJobs;
crawler.maxPagesPerList = maxPages;

// ============================================================================
// RUN CRAWLER
// ============================================================================

try {
    const proxyInfo = input.proxyConfiguration?.useApifyProxy 
        ? `with ${input.proxyConfiguration?.apifyProxyGroups?.join(',') || 'RESIDENTIAL'} proxies` 
        : 'without proxies';
    
    log.info('='.repeat(80));
    log.info('🚀 SIMPLYHIRED JOB SCRAPER - STARTING');
    log.info('='.repeat(80));
    log.info(`📍 Start URLs: ${startUrls.length}`);
    startUrls.forEach((url, i) => log.info(`  ${i + 1}. ${url}`));
    log.info(`🎯 Target jobs: ${maxJobs}`);
    log.info(`📄 Max pages per list: ${maxPages}`);
    log.info(`⚡ Concurrency: ${maxConcurrency}`);
    log.info(`🌐 Proxy: ${proxyInfo}`);
    log.info(`🔧 HTTP-based scraping with CheerioCrawler & Cheerio`);
    log.info('='.repeat(80));
    
    log.info('Starting crawler.run()...');
    await crawler.run(startUrls);
    
    log.info('='.repeat(80));
    log.info('✅ CRAWLER FINISHED SUCCESSFULLY');
    log.info(`📊 Total jobs saved: ${savedJobs}`);
    log.info(`📄 Total pages processed: ${pagesProcessed}`);
    log.info('='.repeat(80));
} catch (err) {
    log.error('='.repeat(80));
    log.error('💥 CRAWLER CRASHED');
    log.error('='.repeat(80));
    log.error(`Error: ${err.message}`);
    log.error(`Stack: ${err.stack}`);
    log.error('='.repeat(80));
    
    // Re-throw to mark the run as failed
    throw err;
} finally {
    log.info('Calling Actor.exit()...');
    await Actor.exit();
}
