// src/main.js
// ============================================================================
// SIMPLYHIRED JOB SCRAPER - COMPREHENSIVE APIFY ACTOR
// HTTP-based scraping with GotCrawler for maximum speed and efficiency
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
    
    // Early exit conditions
    if (jobsProcessed >= maxJobs || crawlerTerminated) {
        return;
    }
    
    if (pagesProcessed > maxPages) {
        log.info(`📄 Reached page limit of ${maxPages}`);
        return;
    }

    log.info(`📋 Scraping listing page ${pagesProcessed}: ${request.url}`);

    // ========================================================================
    // ENHANCED JOB EXTRACTION - Multiple selector strategies
    // ========================================================================
    const jobs = [];
    
    // STRATEGY 1: Use data-testid selectors (SimplyHired's primary structure)
    let jobCards = $('[data-testid="searchSerpJob"]');
    
    // STRATEGY 2: Fallback to generic job containers
    if (jobCards.length === 0) {
        jobCards = $('div[data-testid="job"]');
    }
    
    // STRATEGY 3: Find all job links and get their parent containers
    if (jobCards.length === 0) {
        const jobLinks = $('a[href*="/job/"]');
        const parentSet = new Set();
        
        jobLinks.each((_, link) => {
            const $link = $(link);
            // Find closest article or job-related container
            let parent = $link.closest('article');
            if (!parent.length) parent = $link.closest('div[class*="job"]');
            if (!parent.length) parent = $link.closest('div[class*="card"]');
            
            if (parent.length) {
                parentSet.add(parent.get(0));
            }
        });
        
        jobCards = $(Array.from(parentSet));
    }

    // Parse each job card
    jobCards.each((_, element) => {
        const card = $(element);
        
        try {
            // FIND TITLE & LINK - multiple strategies
            let titleLink = card.find('a[data-testid="job-link"]');
            if (!titleLink.length) titleLink = card.find('a[href*="/job/"]').first();
            if (!titleLink.length) titleLink = card.find('h2 a, h3 a, a[class*="jobTitle"]').first();
            
            if (!titleLink.length) return;

            const title = (
                titleLink.attr('aria-label') ||
                titleLink.text() ||
                ''
            ).trim();
            
            const link = titleLink.attr('href');

            // COMPANY - multiple selectors
            const company = (
                card.find('[data-testid="companyName"]').text() ||
                card.find('span[data-testid]').text() ||
                card.find('[class*="company-name"]').text() ||
                card.find('[class*="companyName"]').text() ||
                card.find('.SerpJob-company').text() ||
                ''
            ).trim();

            // LOCATION - multiple selectors
            const location = (
                card.find('[data-testid="searchSerpJobLocation"]').text() ||
                card.find('[data-testid="job-location"]').text() ||
                card.find('[class*="location"]').text() ||
                card.find('.SerpJob-location').text() ||
                ''
            ).trim();

            // SUMMARY - multiple selectors
            const summary = (
                card.find('[data-testid="searchSerpJobSnippet"]').text() ||
                card.find('[data-testid="job-snippet"]').text() ||
                card.find('p[class*="snippet"]').text() ||
                card.find('.SerpJob-snippet').text() ||
                card.find('.job-snippet').text() ||
                ''
            ).trim();

            // SALARY (optional)
            const salary = (
                card.find('[data-testid="searchSerpJobSalary"]').text() ||
                card.find('[class*="salary"]').text() ||
                card.find('.SerpJob-salary').text() ||
                ''
            ).trim();

            if (title && link) {
                jobs.push({ title, link, company, location, summary, salary });
            }
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
    // ENHANCED PAGINATION DETECTION - 5 strategies
    // ========================================================================
    let nextHref = null;
    
    // STRATEGY 1: Find "Next" or "Next Page" text
    const allLinks = $('a');
    allLinks.each((_, link) => {
        const $link = $(link);
        const text = $link.text().toLowerCase().trim();
        if ((text === 'next' || text === 'next page' || text.includes('next')) && 
            !$link.hasClass('disabled')) {
            nextHref = $link.attr('href');
            return false; // break
        }
    });

    // STRATEGY 2: Aria-label
    if (!nextHref) {
        const ariaNext = $('a[aria-label*="Next"]');
        if (ariaNext.length && !ariaNext.hasClass('disabled')) {
            nextHref = ariaNext.attr('href');
        }
    }

    // STRATEGY 3: Chakra UI specific (SimplyHired uses Chakra)
    if (!nextHref) {
        const chakraLinks = $('a.chakra-link');
        chakraLinks.each((_, link) => {
            const $link = $(link);
            const text = $link.text();
            if (text.includes('Next Page') || text.includes('Next')) {
                nextHref = $link.attr('href');
                return false;
            }
        });
    }

    // STRATEGY 4: Pagination container logic
    if (!nextHref) {
        const pagination = 
            $('[data-testid*="pagination"]').first() ||
            $('.pagination').first() ||
            $('[class*="Pagination"]').first();
        
        if (pagination.length) {
            const links = pagination.find('a');
            const current = pagination.find('[aria-current="page"], .active, [class*="active"]').first();
            
            if (current.length) {
                const currentIndex = links.index(current.get(0));
                if (currentIndex >= 0 && currentIndex < links.length - 1) {
                    const nextLink = links.eq(currentIndex + 1);
                    if (!nextLink.hasClass('disabled')) {
                        nextHref = nextLink.attr('href');
                    }
                }
            }
        }
    }

    // STRATEGY 5: Look for chevron/arrow icons
    if (!nextHref) {
        const icons = $('svg[class*="chevron-right"], svg[class*="arrow-right"]');
        icons.each((_, icon) => {
            const $icon = $(icon);
            const link = $icon.closest('a');
            if (link.length && !link.hasClass('disabled')) {
                nextHref = link.attr('href');
                return false;
            }
        });
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
    
    // Check if we've already reached our target
    if (savedJobs >= maxJobs || crawlerTerminated) {
        return;
    }

    // ========================================================================
    // ENHANCED DETAIL EXTRACTION
    // ========================================================================
    
    // Get the page body
    const body = $('body');

    // -----------------------------------------------------------------------
    // EXTRACT FULL DESCRIPTION - Advanced multi-strategy approach
    // -----------------------------------------------------------------------
    let description_text = '';
    let description_html = '';
    
    // STRATEGY 1: Look for main job description containers
    const descriptionSelectors = [
        '[data-testid="viewJobBodyJobFullDescription"]',
        '[data-testid="viewJobBodyJobDescription"]',
        '[data-testid="jobDescriptionSection"]',
        'section[data-testid="jobDescription"]',
        '.job-description-content',
        '.ViewJob-description',
        '.job-description'
    ];

    let descEl = null;
    for (const selector of descriptionSelectors) {
        const el = $(selector);
        if (el.length) {
            const text = el.text().trim();
            const html = el.html();
            
            // Skip job details sections
            if (text.match(/^(Job Details|Full-time|Part-time|\$[\d,]+)/i)) {
                continue;
            }
            
            // Skip qualifications sections
            if (html && (html.includes('data-testid="viewJobQualificationItem"') || 
                html.includes('Qualifications') ||
                text.match(/^(Qualifications|Requirements|Skills Required)/i))) {
                continue;
            }
            
            // Must have substantial content
            if (text.length > 100) {
                descEl = el;
                break;
            }
        }
    }

    // STRATEGY 2: Find content between job details and qualifications
    if (!descEl || descEl.length === 0) {
        const jobDetailsContainer = $('[data-testid="viewJobBodyJobDetailsContainer"]');
        const qualificationsTitles = $('[data-testid="viewJobDetailsSectionTitle"]');
        
        let qualificationsEl = null;
        qualificationsTitles.each((_, el) => {
            if ($(el).text().includes('Qualifications')) {
                qualificationsEl = $(el);
                return false;
            }
        });
        
        if (jobDetailsContainer.length && qualificationsEl) {
            // Find all siblings between these two elements
            let current = jobDetailsContainer.parent().next();
            const qualParent = qualificationsEl.parent();
            
            while (current.length && current.get(0) !== qualParent.get(0)) {
                const text = current.text().trim();
                const html = current.html();
                
                if (text.length > 200 && 
                    html && !html.includes('data-testid="viewJobBodyJobDetailsContainer"') &&
                    !html.includes('data-testid="viewJobQualificationItem"') &&
                    !text.match(/^(Job Details|Qualifications|Full-time|Part-time|\$[\d,]+)/i)) {
                    descEl = current;
                    break;
                }
                current = current.next();
            }
        }
    }

    // STRATEGY 3: Look for job description indicators
    if (!descEl || descEl.length === 0) {
        const allSections = $('div, section, article');
        const jobDescIndicators = [
            'job description', 'role', 'position', 'responsibilities', 'duties',
            'we are looking', 'seeking', 'candidate will', 'you will',
            'this position', 'job summary', 'overview', 'about the role',
            'primary responsibilities', 'key responsibilities'
        ];
        
        allSections.each((_, section) => {
            const $section = $(section);
            const text = $section.text().trim();
            const html = $section.html();
            
            // Skip unwanted sections
            if (text.length < 200 || 
                html && (html.includes('data-testid="viewJobBodyJobDetailsContainer"') ||
                html.includes('data-testid="viewJobQualificationItem"')) ||
                $section.closest('[data-testid="viewJobBodyJobDetailsContainer"]').length) {
                return;
            }
            
            // Check for job description indicators
            const lowerText = text.toLowerCase();
            const hasIndicators = jobDescIndicators.some(indicator => 
                lowerText.includes(indicator)
            );
            
            if (hasIndicators) {
                descEl = $section;
                return false; // break
            }
        });
    }

    // Clean and extract description
    if (descEl && descEl.length) {
        const cleanedEl = descEl.clone();
        
        // Remove unwanted elements
        cleanedEl.find(`
            [data-testid="viewJobBodyJobDetailsContainer"],
            [data-testid="viewJobBodyJobDetailsJobType"],
            [data-testid="viewJobBodyJobCompensation"],
            [data-testid="viewJobBodyJobPostingTimestamp"],
            [data-testid="viewJobQualificationItem"],
            [data-testid="viewJobDetailsSectionTitle"],
            .css-bu2sfw, .css-155za0w, .css-xyzzkl,
            .chakra-wrap, .chakra-wrap__list,
            svg, .svg-inline--fa, hr,
            header, nav, footer, script, style
        `).remove();
        
        // Remove qualifications sections
        cleanedEl.find('h2, h3, div').each((_, el) => {
            const $el = $(el);
            const text = $el.text().trim();
            if (text.match(/^(Qualifications|Requirements|Skills Required|Skills & Qualifications)$/i)) {
                const nextEl = $el.next();
                if (nextEl.length && (nextEl.hasClass('chakra-wrap') || 
                    nextEl.html() && nextEl.html().includes('data-testid="viewJobQualificationItem"'))) {
                    nextEl.remove();
                }
                $el.remove();
            }
        });
        
        description_text = cleanedEl.text().trim();
        description_html = cleanedEl.html() || '';
        
        // Final validation - ensure it's actually job description content
        const lowerText = description_text.toLowerCase();
        const isQualifications = description_text.match(/^(Job Details|Qualifications|Full-time|Part-time|\$[\d,]+.*(?:hour|year|month))/i) ||
                                (lowerText.includes('microsoft word') && 
                                 lowerText.includes('microsoft excel') && 
                                 lowerText.includes('organizational skills') && 
                                 description_text.length < 1000) ||
                                description_text.length < 100;
        
        if (isQualifications) {
            description_text = '';
            description_html = '';
        }
    }

    // -----------------------------------------------------------------------
    // EXTRACT OTHER JOB DETAILS
    // -----------------------------------------------------------------------
    
    // COMPANY - multiple strategies
    const company = 
        body.find('[data-testid="viewJobCompanyName"]').first().text().trim() ||
        body.find('[data-testid="companyName"]').first().text().trim() ||
        body.find('h2[data-testid]').first().text().trim() ||
        body.find('[class*="company-name"]').first().text().trim() ||
        body.find('.ViewJobHeader-company').first().text().trim() ||
        body.find('.JobPosting-company').first().text().trim() ||
        '';

    // LOCATION
    const location = 
        body.find('[data-testid="viewJobBodyJobLocation"]').first().text().trim() ||
        body.find('[data-testid="job-location"]').first().text().trim() ||
        body.find('.ViewJobHeader-location').first().text().trim() ||
        body.find('.JobPosting-location').first().text().trim() ||
        '';

    // SALARY - extract from job details section
    let salary = 
        body.find('[data-testid="viewJobBodyJobCompensation"] [data-testid="detailText"]').first().text().trim() ||
        body.find('[data-testid="viewJobBodyJobCompensation"]').first().text().trim() ||
        body.find('[data-testid="job-salary"]').first().text().trim() ||
        body.find('.ViewJob-salary').first().text().trim() ||
        body.find('.JobPosting-salary').first().text().trim() ||
        '';

    // If still empty, look for salary patterns in job details container
    if (!salary) {
        const jobDetailsContainer = body.find('[data-testid="viewJobBodyJobDetailsContainer"]');
        if (jobDetailsContainer.length) {
            const detailsText = jobDetailsContainer.text();
            const salaryMatch = detailsText.match(/\$[\d,]+(?:\.\d{2})?\s*-\s*\$[\d,]+(?:\.\d{2})?\s*(?:an?\s+)?(?:hour|year|month)/i);
            if (salaryMatch) {
                salary = salaryMatch[0];
            }
        }
    }

    // EMPLOYMENT TYPE - extract from job details section
    let employment_type = 
        body.find('[data-testid="viewJobBodyJobDetailsJobType"] [data-testid="detailText"]').first().text().trim() ||
        body.find('[data-testid="viewJobBodyJobEmploymentType"]').first().text().trim() ||
        body.find('[data-testid="employment-type"]').first().text().trim() ||
        body.find('.JobPosting-employmentType').first().text().trim() ||
        '';

    // If still empty, look for employment type patterns
    if (!employment_type) {
        const jobDetailsContainer = body.find('[data-testid="viewJobBodyJobDetailsContainer"]');
        if (jobDetailsContainer.length) {
            const detailsText = jobDetailsContainer.text();
            const employmentTypes = ['Full-time', 'Part-time', 'Contract', 'Temporary', 'Internship', 'Freelance'];
            
            for (const type of employmentTypes) {
                if (detailsText.includes(type)) {
                    employment_type = type;
                    break;
                }
            }
        }
    }

    // POSTED DATE
    let posted = 
        body.find('time').first().attr('datetime') ||
        body.find('[data-testid="viewJobBodyJobPostingTimestamp"] [data-testid="detailText"]').first().text().trim() ||
        body.find('[data-testid="viewJobBodyJobPostingDate"]').first().text().trim() ||
        body.find('[data-testid="job-age"]').first().text().trim() ||
        body.find('.ViewJobPost-date').first().text().trim() ||
        '';

    // If still empty, look for time patterns
    if (!posted) {
        const jobDetailsContainer = body.find('[data-testid="viewJobBodyJobDetailsContainer"]');
        if (jobDetailsContainer.length) {
            const detailsText = jobDetailsContainer.text();
            const timeMatch = detailsText.match(/(?:Posted\s+)?(?:\d+\s+)?(?:day|days|week|weeks|month|months|hour|hours)\s+ago|yesterday|today/i);
            if (timeMatch) {
                posted = timeMatch[0];
            }
        }
    }

    // ========================================================================
    // BUILD & SAVE FINAL ITEM
    // ========================================================================
    
    const item = {
        title: meta.title || body.find('h1').first().text().trim().replace(' - SimplyHired', '').slice(0, 200),
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

// Get Actor input
const input = (await Actor.getInput()) ?? {};

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
    // Use user-provided URLs
    startUrls = input.startUrls;
} else if (input.keywords || input.location || input.remote_only) {
    // Build URLs from search parameters
    startUrls = buildSearchUrls(
        input.keywords, 
        input.location, 
        input.date_posted, 
        input.remote_only
    );
} else {
    // Fallback to default search
    startUrls = ['https://www.simplyhired.com/search?q=software+engineer&l='];
}

// ============================================================================
// PROXY CONFIGURATION
// ============================================================================

let proxyConfiguration;
if (input.proxyConfiguration) {
    // Use user-provided proxy configuration
    const proxyConfig = input.proxyConfiguration;
    
    // If apifyProxyGroups is empty array, use RESIDENTIAL as default
    if (proxyConfig.useApifyProxy && (!proxyConfig.apifyProxyGroups || proxyConfig.apifyProxyGroups.length === 0)) {
        proxyConfig.apifyProxyGroups = ['RESIDENTIAL'];
    }
    
    proxyConfiguration = await Actor.createProxyConfiguration(proxyConfig);
} else {
    // Default configuration with RESIDENTIAL proxies
    proxyConfiguration = await Actor.createProxyConfiguration({
        useApifyProxy: true,
        groups: ['RESIDENTIAL'],
        countryCode: 'US',
    });
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
// GOTCRAWLER SETUP - OPTIMIZED FOR SPEED
// ============================================================================

const crawler = new CheerioCrawler({
    proxyConfiguration,
    requestHandler: router,
    
    // MAXIMUM PERFORMANCE settings for HTTP-based scraping
    maxConcurrency: maxConcurrency,
    maxRequestsPerCrawl: Math.min(maxJobs * 5, 3000),
    maxRequestRetries: 3, // Allow retries for proxy/network issues
    requestHandlerTimeoutSecs: 60,
    
    // Session pool for better performance and anti-blocking
    useSessionPool: true,
    persistCookiesPerSession: true,
    
    sessionPoolOptions: {
        maxPoolSize: Math.max(20, maxConcurrency * 2),
        sessionOptions: {
            maxUsageCount: 20, // Reuse sessions more
            maxErrorScore: 2,
            maxAgeSecs: 1800, // 30 minutes session lifetime
        },
    },
    
    // Enhanced headers to mimic real browser behavior
    requestHandlerDefaults: {
        headers: {
            'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'accept-language': 'en-US,en;q=0.9',
            'accept-encoding': 'gzip, deflate, br',
            'cache-control': 'no-cache',
            'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'sec-fetch-dest': 'document',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-site': 'none',
            'sec-fetch-user': '?1',
            'upgrade-insecure-requests': '1',
            'user-agent': randomUA(),
        },
    },

    // Error handling
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
    log.info(`🎯 Target jobs: ${maxJobs}`);
    log.info(`📄 Max pages per list: ${maxPages}`);
    log.info(`⚡ Concurrency: ${maxConcurrency}`);
    log.info(`🌐 Proxy: ${proxyInfo}`);
    log.info(`🔧 HTTP-based scraping with GotCrawler & Cheerio`);
    log.info('='.repeat(80));
    
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
} finally {
    await Actor.exit();
}
