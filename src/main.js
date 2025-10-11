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
    
    // Reduced logging - only log every other page
    if (pagesProcessed % 2 === 1 || pagesProcessed === 1) {
        log.info(`🔍 LIST page ${pagesProcessed}/${maxPages} - Jobs saved: ${savedJobs}/${maxJobs}`);
    }
    
    // Early exit conditions
    if (jobsProcessed >= maxJobs || crawlerTerminated) {
        return;
    }
    
    if (pagesProcessed > maxPages) {
        log.info(`📄 Reached page limit: ${maxPages}`);
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
        log.error(`❌ No job links found. Page title: ${$('title').text()}`);
        return;
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
                const $el = $(this);
                // Only get leaf elements (no children) with text
                return $el.children().length === 0 && $el.text().trim().length > 0;
            });
            companyText.each((_, el) => {
                const text = $(el).text().trim();
                // Company name is usually after title, not a date/time, not salary, not CSS
                if (text && 
                    text !== title && 
                    !text.match(/^\d+[dhm]$/i) && 
                    !text.match(/ago$/i) &&
                    !text.match(/^\$[\d,]+/) &&
                    !text.includes('css-') &&
                    !text.includes('chakra-') &&
                    !text.includes('var(--') &&
                    text.length < 100) {
                    if (!company) company = text;
                }
            });
            
            // Remove rating from company name (e.g., "Company Name - 4.4" -> "Company Name")
            if (company) {
                company = company.replace(/\s*[-–—]\s*\d+(\.\d+)?\s*$/, '').trim();
            }
            
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
    const remainingCapacity = Math.max(0, maxJobs - savedJobs); // Use savedJobs instead of jobsProcessed
    const jobsToProcess = Math.min(jobs.length, remainingCapacity);
    
    if (remainingCapacity <= 0 || crawlerTerminated) {
        log.info(`✋ Stopping: ${savedJobs}/${maxJobs} jobs already saved`);
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
    
    // Reduced logging - only show significant updates
    if (pagesProcessed === 1 || jobsToProcess > 0) {
        log.info(`📤 Page ${pagesProcessed}: +${jobsToProcess} jobs | Total: ${jobsProcessed} enqueued, ${savedJobs} saved`);
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
    
    // Reduced logging for speed - only log every 20th job
    if (savedJobs % 20 === 0) {
        log.info(`📄 Processing: ${meta.title || 'Unknown'} (${savedJobs}/${maxJobs})`);
    }
    
    // Check if we've already reached our target
    if (savedJobs >= maxJobs || crawlerTerminated) {
        return;
    }
    
    // Wrap entire handler in try-catch to prevent crashes
    try {
        // Check if page loaded properly (not a block page)
        const pageTitle = $('title').text().toLowerCase();
        if (pageTitle.includes('access denied') || pageTitle.includes('blocked') || pageTitle.includes('captcha')) {
            log.warning(`⚠️ Detected block page for: ${request.url}`);
            throw new Error('Page blocked - will retry');
        }

        // ========================================================================
        // CLEAN TEXT & HTML EXTRACTION HELPERS
        // ========================================================================
        
        // Helper to get clean text - removes CSS classes and HTML tags
        const cleanText = (element) => {
            if (!element || !element.length) return '';
        
        let text = element.text().trim();
        
        // Remove CSS class patterns like .css-xxxxx{...} and chakra-xxx{...}
        text = text.replace(/\.(css-[a-z0-9-]+|chakra-[a-z0-9-]+)\{[^}]*\}/gi, '');
        text = text.replace(/var\(--[^)]+\)/gi, '');
        text = text.replace(/\{[^}]*\}/g, '');
        text = text.replace(/@media[^{]+\{[^}]*\}/gi, '');
        text = text.replace(/font-size:|font-weight:|line-height:|margin-bottom:|color:|background:/gi, '');
        text = text.replace(/:host|:root|\[data-theme\]|\.chakra-ui/gi, '');
        
        // Remove JSON-like structures
        text = text.replace(/"[^"]*":\{[^}]*\}/g, '');
        text = text.replace(/\{"[^"]*":/g, '');
        
        // Clean up whitespace
        text = text.replace(/\s+/g, ' ').trim();
        
        return text;
    };
    
    // Helper to get clean HTML - keeps structure but removes CSS classes and empty tags
    const cleanHtml = (element) => {
        if (!element || !element.length) return '';
        
        // Clone to avoid modifying original
        const clone = element.clone();
        
        // Remove unwanted elements
        clone.find('style, script, svg, img').remove();
        clone.find('[class*="css-"]').removeAttr('class');
        clone.find('[class*="chakra-"]').removeAttr('class');
        clone.find('*').removeAttr('style').removeAttr('id');
        
        // Remove data attributes
        clone.find('*').each((_, el) => {
            const $el = $(el);
            const attrs = $el.get(0).attributes;
            for (let i = attrs.length - 1; i >= 0; i--) {
                const attrName = attrs[i].name;
                if (attrName.startsWith('data-') || attrName.startsWith('aria-')) {
                    $el.removeAttr(attrName);
                }
            }
        });
        
        // Get HTML
        let html = clone.html() || '';
        
        // Remove CSS patterns from text
        html = html.replace(/\.(css-[a-z0-9-]+|chakra-[a-z0-9-]+)\{[^}]*\}/gi, '');
        html = html.replace(/var\(--[^)]+\)/gi, '');
        html = html.replace(/@media[^{]+\{[^}]*\}/gi, '');
        html = html.replace(/\{[^}]*\}/g, '');
        
        // Remove empty tags like <div></div>, <span></span>, <p></p>
        html = html.replace(/<(\w+)[^>]*>\s*<\/\1>/gi, '');
        // Do it twice to catch nested empty tags
        html = html.replace(/<(\w+)[^>]*>\s*<\/\1>/gi, '');
        
        // Clean up excessive whitespace
        html = html.replace(/\s+/g, ' ').trim();
        
        return html;
    };

    // ========================================================================
    // EXTRACT JOB DATA - Using data-testid attributes for SimplyHired
    // ========================================================================
    
    // Title - from meta or h1
    const title = meta.title || 
                  cleanText($('h1[data-testid="viewJobBodyJobHeader"]')) ||
                  cleanText($('h1').first()) ||
                  '';
    
    // Company name - look for company text that doesn't contain CSS
    let company = meta.company || '';
    if (!company) {
        // Try specific selectors first
        company = cleanText($('[data-testid="viewJobCompanyName"]'));
        
        // Fallback: find company in h2 or specific class (but filter out CSS)
        if (!company) {
            $('h2, .company-name, [class*="company"]').each((_, el) => {
                const text = cleanText($(el));
                if (text && !text.includes('css-') && !text.includes('var(--') && text.length < 100) {
                    company = text;
                    return false;
                }
            });
        }
    }
    
    // Remove rating from company name (e.g., "Company Name - 4.4" -> "Company Name")
    if (company) {
        company = company.replace(/\s*[-–—]\s*\d+(\.\d+)?\s*$/, '').trim();
    }
    
    // Location
    let location = meta.location || cleanText($('[data-testid="viewJobCompanyLocation"]')) || '';
    
    // Salary - extract ONLY the salary text, not CSS or HTML
    let salary = '';
    
    // Method 1: Try the specific data-testid selector
    const salaryDetailText = $('[data-testid="viewJobBodyJobCompensation"] [data-testid="detailText"]');
    if (salaryDetailText.length) {
        const rawText = salaryDetailText.first().text().trim();
        // Only accept if it looks like a salary (contains $ or numbers with period)
        if (rawText.match(/\$|(\d+.*(?:hour|year|month|week))/i) && rawText.length < 100) {
            salary = rawText;
        }
    }
    
    // Method 2: Search for salary pattern in small text nodes
    if (!salary) {
        // Find elements that ONLY contain salary-like text (very short)
        $('span, div, p').each((_, el) => {
            const $el = $(el);
            const text = $el.text().trim();
            
            // Skip if element has children or text is too long
            if ($el.children().length > 1 || text.length > 80) return;
            
            // Look for salary patterns
            if (text.match(/^\$[\d,.]+ ?- ?\$[\d,.]+\s*(?:per|an?|\/)\s*(?:hour|year|month|week|day)?$/i) ||
                text.match(/^\$[\d,.]+\s*(?:per|an?|\/)\s*(?:hour|year|month|week|day)$/i)) {
                salary = text;
                return false; // Stop searching
            }
        });
    }
    
    // Clean salary value
    if (salary) {
        // Decode HTML entities (&#x24; → $)
        const tempDiv = $('<div>').html(salary);
        salary = tempDiv.text().trim();
        
        // Remove any remaining CSS artifacts
        salary = salary.replace(/\.(css-|chakra-)[\w-]+\{[^}]*\}/gi, '');
        salary = salary.replace(/var\(--[^)]+\)/gi, '');
        salary = salary.replace(/[{}]/g, '');
        salary = salary.trim();
        
        // Final validation - if still contains weird characters, clear it
        if (salary.length > 100 || salary.includes('{') || salary.includes('css-')) {
            salary = '';
        }
    }
    
    // Job type (Full-time, Part-time, Contract, etc.)
    const job_type = cleanText($('[data-testid="viewJobBodyJobDetailsJobType"] [data-testid="detailText"]')) || '';
    
    // Date posted
    const date_posted = cleanText($('[data-testid="viewJobBodyJobPostingTimestamp"] [data-testid="detailText"]')) || '';
    
    // Benefits - extract from list and combine into single string
    const benefitsList = [];
    $('[data-testid="viewJobBenefitItem"]').each((_, el) => {
        const benefit = cleanText($(el));
        if (benefit && !benefit.includes('css-') && !benefit.includes('var(--')) {
            benefitsList.push(benefit);
        }
    });
    const benefits = benefitsList.length > 0 ? benefitsList.join(', ') : '';
    
    // Qualifications - extract from list and combine into single string (limit to top 15)
    const qualificationsList = [];
    $('[data-testid="viewJobQualificationItem"]').each((i, el) => {
        // Only get first 15 qualifications to avoid overwhelming data
        if (i >= 15) return false;
        
        const qual = cleanText($(el));
        if (qual && !qual.includes('css-') && !qual.includes('var(--')) {
            qualificationsList.push(qual);
        }
    });
    const qualifications = qualificationsList.length > 0 ? qualificationsList.join(', ') : '';
    
    // Full job description - the main content
    let description_text = '';
    let description_html = '';
    
    const descContainer = $('[data-testid="viewJobBodyJobFullDescriptionContent"]');
    if (descContainer.length) {
        description_text = cleanText(descContainer);
        description_html = cleanHtml(descContainer);
        
        // Decode HTML entities in description text
        description_text = $('<div>').html(description_text).text();
    }
    
    // Fallback: try other common description containers
    if (!description_text) {
        const altDesc = $('.css-cxpe4v, .job-description, [class*="description"]').first();
        if (altDesc.length) {
            description_text = cleanText(altDesc);
            description_html = cleanHtml(altDesc);
            description_text = $('<div>').html(description_text).text();
        }
    }

    // ========================================================================
    // SAVE JOB DATA
    // ========================================================================
    
    const jobData = {
        title: title || 'N/A',
        company: company || 'N/A',
        location: location || 'N/A',
        salary: salary || 'N/A',
        job_type: job_type || 'N/A',
        date_posted: date_posted || 'N/A',
        benefits: benefits || '',
        qualifications: qualifications || '',
        description_text: description_text || '',
        description_html: description_html || '',
        url: request.url,
        source: 'SimplyHired',
        scraped_at: new Date().toISOString(),
    };

    // Reduced logging - only log every 25 jobs or at milestones
    if (savedJobs % 25 === 0 || savedJobs === 1 || savedJobs === maxJobs) {
        log.info(`✅ Saved ${savedJobs}/${maxJobs}: "${title}" at "${company}"`);
    }
    
    await Dataset.pushData(jobData);
    savedJobs++;
    jobsProcessed++;

    // Check if we've reached target
    if (savedJobs >= maxJobs && !crawlerTerminated) {
        crawlerTerminated = true;
        log.info(`🎯 Target reached! ${savedJobs} jobs collected.`);
    }
    
    } catch (error) {
        log.error(`❌ Error in DETAIL handler for ${request.url}: ${error.message}`);
        // Re-throw to trigger retry mechanism
        throw error;
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
// OPTIMIZED for SPEED - Higher concurrency with smart session management
const maxConcurrency = Math.min(input.maxConcurrency ?? 15, 20); // Default 15, max 20

log.info(`⚙️ Configuration: maxJobs=${maxJobs}, maxPages=${maxPages}, maxConcurrency=${maxConcurrency}`);

// ============================================================================
// CHEERIO CRAWLER SETUP - OPTIMIZED FOR SPEED & ANTI-BLOCKING
// ============================================================================


const crawler = new CheerioCrawler({
    proxyConfiguration,
    requestHandler: router,
    maxConcurrency: maxConcurrency,
    maxRequestsPerCrawl: Math.min(maxJobs * 10, 5000),
    maxRequestRetries: 4, // 4 retries - balance between success and speed
    requestHandlerTimeoutSecs: 90, // 90s - faster timeout
    useSessionPool: true,
    persistCookiesPerSession: true,
    
    // Keep some minimum concurrency for speed
    minConcurrency: Math.floor(maxConcurrency / 3),
    
    sessionPoolOptions: {
        maxPoolSize: 100, // Large pool for better distribution
        sessionOptions: {
            maxUsageCount: 30, // Use sessions longer (reduce overhead)
            maxErrorScore: 1.5, // Be stricter with bad sessions
            maxAgeSecs: 7200,  // 2 hours - keep sessions longer
        },
    },
    
    preNavigationHooks: [
        async ({ request, session }) => {
            // Rotate user-agent per session
            if (!session.userData.userAgent) {
                session.userData.userAgent = randomUA();
            }
            
            // MINIMAL DELAYS - Speed optimized while avoiding blocks
            const isDetailPage = request.userData?.label === 'DETAIL';
            let delay;
            
            if (isDetailPage) {
                // Detail pages: 400-1000ms (was 1-3s) - Still safe but 3x faster
                delay = 400 + Math.random() * 600;
            } else {
                // List pages: 50-150ms (was 300-800ms) - Very fast, minimal risk
                delay = 50 + Math.random() * 100;
            }
            
            await new Promise(resolve => setTimeout(resolve, delay));
            
            // Enhanced headers to look more like a real browser
            const isFromSameSite = request.userData?.label === 'DETAIL';
            
            request.headers = {
                'user-agent': session.userData.userAgent,
                'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'accept-language': 'en-US,en;q=0.9',
                'accept-encoding': 'gzip, deflate, br',
                'cache-control': 'no-cache',
                'pragma': 'no-cache',
                'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
                'sec-fetch-dest': 'document',
                'sec-fetch-mode': 'navigate',
                'sec-fetch-site': isFromSameSite ? 'same-origin' : 'none',
                'sec-fetch-user': '?1',
                'upgrade-insecure-requests': '1',
                'dnt': '1',
                'connection': 'keep-alive',
            };
            
            // Add referer only for detail pages
            if (isFromSameSite) {
                request.headers['referer'] = 'https://www.simplyhired.com/search';
            }
            
            log.debug(`${isDetailPage ? '📄' : '📋'} ${request.url.substring(0, 60)}... (${Math.round(delay)}ms)`);
        },
    ],
    
    failedRequestHandler: async ({ request, error }) => {
        // Only log important failures
        if (request.retryCount >= 3) {
            log.warning(`⚠️ Failed after ${request.retryCount} retries: ${request.userData?.label || 'unknown'} - ${error?.message}`);
        }
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
    log.info(`📊 Total jobs saved: ${savedJobs}/${maxJobs} (${Math.round(savedJobs/maxJobs*100)}%)`);
    log.info(`📄 Total pages processed: ${pagesProcessed}`);
    log.info(`⏱️  Average: ${(savedJobs/pagesProcessed || 0).toFixed(1)} jobs per page`);
    
    if (savedJobs < maxJobs) {
        log.warning(`⚠️ Target not reached. Got ${savedJobs}/${maxJobs} jobs. This may be due to:`);
        log.warning(`   - Not enough jobs available for your search criteria`);
        log.warning(`   - Some jobs were blocked (403 errors)`);
        log.warning(`   - Try reducing maxConcurrency for better stealth`);
    }
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
