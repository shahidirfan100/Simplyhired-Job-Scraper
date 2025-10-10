# SimplyHired Job Scraper - HTTP Optimized ⚡

High-performance Apify actor for scraping job listings from SimplyHired.com using HTTP-based scraping with GotCrawler and Cheerio for maximum speed and efficiency.

## 🚀 Features

- **Lightning Fast**: HTTP-based scraping (no browser overhead) with GotCrawler + Cheerio
- **Smart Extraction**: Multiple selector strategies to handle SimplyHired's dynamic structure
- **Comprehensive Data**: Extracts title, company, location, salary, description, employment type, and more
- **Advanced Pagination**: 5 different pagination detection strategies for robust navigation
- **Proxy Support**: Built-in RESIDENTIAL proxy support for anti-blocking
- **Flexible Search**: Search by keywords, location, remote jobs, or provide custom URLs
- **Resource Efficient**: Uses ~70% less resources than browser-based scrapers
- **Production Ready**: Built for Apify platform with proper error handling and logging

## 📊 Extracted Data

Each job listing includes:

- **title**: Job title
- **company**: Company name
- **location**: Job location
- **summary**: Short job description from listing page
- **salary**: Salary information (if available)
- **employment_type**: Full-time, Part-time, Contract, etc.
- **posted**: Date posted (e.g., "2 days ago")
- **description_text**: Full job description (plain text)
- **description_html**: Full job description (HTML format)
- **url**: Direct link to the job posting
- **crawledAt**: Timestamp when the job was scraped

## 🎯 Use Cases

- **Job Market Research**: Analyze hiring trends and salary ranges
- **Job Aggregation**: Build your own job board or feed
- **Competitive Intelligence**: Monitor competitor hiring patterns
- **Career Planning**: Track job requirements and skills in demand
- **Lead Generation**: Find companies actively hiring in your industry

## ⚙️ Input Configuration

### Search Parameters

**Start URLs** (optional)
- Provide direct SimplyHired search URLs
- If provided, overrides keyword/location search
- Example: `https://www.simplyhired.com/search?q=software+engineer&l=New+York`

**Keywords** (optional)
- Job search terms (e.g., "software engineer", "data scientist")
- Supports comma-separated multiple keywords
- Example: `software engineer, backend developer, python developer`

**Location** (optional)
- Geographic location (e.g., "New York, NY", "San Francisco", "Remote")
- Supports city, state, or country

**Remote Only** (checkbox)
- Search for remote jobs only
- Overrides location field when enabled

**Date Posted Filter**
- `any`: All jobs
- `1`: Last 24 hours
- `7`: Last 7 days
- `30`: Last 30 days

### Scraping Limits

**Maximum Jobs to Scrape** (default: 200)
- Total number of job listings to collect
- Range: 1-5000

**Maximum Pages Per Search** (default: 20)
- Safety limit for pagination
- Prevents infinite loops

**Concurrency** (default: 30)
- Number of parallel HTTP requests
- Higher = faster, but uses more resources
- Recommended: 20-50 for HTTP scraping

### Proxy Configuration

**Default**: RESIDENTIAL proxies (recommended)
- Prevents blocking and IP bans
- Rotating IPs for each request
- US country code by default

## 📖 Usage Examples

### Example 1: Search by Keywords and Location

```json
{
  "keywords": "software engineer",
  "location": "San Francisco, CA",
  "results_wanted": 100,
  "date_posted": "7",
  "maxConcurrency": 30
}
```

### Example 2: Multiple Keywords

```json
{
  "keywords": "data scientist, machine learning engineer, AI researcher",
  "location": "Remote",
  "results_wanted": 200,
  "remote_only": true
}
```

### Example 3: Custom URLs

```json
{
  "startUrls": [
    { "url": "https://www.simplyhired.com/search?q=frontend+developer&l=New+York" },
    { "url": "https://www.simplyhired.com/search?q=backend+developer&l=Austin" }
  ],
  "results_wanted": 150,
  "maxConcurrency": 40
}
```

### Example 4: Remote Jobs Only

```json
{
  "keywords": "product manager",
  "remote_only": true,
  "results_wanted": 100,
  "date_posted": "1"
}
```

## 🏗️ Architecture

This actor uses:
- **Apify SDK v3**: Actor framework and data storage
- **Crawlee v3**: Web scraping framework
- **GotCrawler**: HTTP-based crawler (no browser overhead)
- **Cheerio**: Fast HTML parsing and DOM manipulation
- **got-scraping**: HTTP client with anti-blocking features

## 🔧 Technical Details

### Performance Optimizations

1. **HTTP-Only Scraping**: No browser = 10x faster than Playwright/Puppeteer
2. **Smart Concurrency**: Optimized parallel requests with session pooling
3. **Minimal Waiting**: No DOM loading waits, instant parsing
4. **Resource Blocking**: Not needed for HTTP (no images/CSS to block)
5. **Session Reuse**: Persistent sessions reduce overhead

### Anti-Blocking Measures

1. **RESIDENTIAL Proxies**: Rotating residential IPs
2. **User Agent Rotation**: Multiple realistic browser user agents
3. **HTTP Headers**: Complete browser-like header sets
4. **Session Pooling**: Distributed requests across sessions
5. **Request Throttling**: Controlled concurrency to avoid rate limits

### Selector Strategies

The scraper uses multiple fallback strategies to extract data:
- Primary: `data-testid` attributes (SimplyHired's structure)
- Secondary: Class-based selectors
- Tertiary: Semantic HTML patterns
- Quaternary: Content-based detection
- Quintenary: Link pattern matching

## 💾 Output Format

Results are saved to the Apify dataset in JSON format:

```json
{
  "title": "Senior Software Engineer",
  "company": "Tech Corp Inc.",
  "location": "San Francisco, CA",
  "summary": "We're looking for an experienced software engineer...",
  "salary": "$120,000 - $180,000 a year",
  "employment_type": "Full-time",
  "posted": "2 days ago",
  "description_text": "Full job description here...",
  "description_html": "<div>Full job description with HTML...</div>",
  "url": "https://www.simplyhired.com/job/...",
  "crawledAt": "2024-01-15T10:30:00.000Z"
}
```

## 🐛 Troubleshooting

**No jobs found**
- Website structure may have changed
- Check if search URL is valid
- Try different keywords or location

**Rate limiting / Blocking**
- Ensure RESIDENTIAL proxies are enabled
- Reduce concurrency
- Add delays between requests

**Incomplete data**
- Some fields may be optional
- Not all jobs have salary information
- Description extraction uses multiple strategies

## 📝 Best Practices

1. **Use RESIDENTIAL proxies** for best results
2. **Start with lower concurrency** (20-30) and increase if stable
3. **Set realistic limits** - Don't scrape more than needed
4. **Monitor runs** - Check logs for any issues
5. **Export regularly** - Download results before they expire

## 🔄 Updates & Maintenance

This scraper is maintained to work with SimplyHired's current structure. If you encounter issues:
1. Check the logs for error messages
2. Verify the website structure hasn't changed
3. Update selectors if needed
4. Contact support if problems persist

## 📜 License

This actor is provided as-is for use on the Apify platform. Please ensure you comply with SimplyHired's Terms of Service when scraping their website.

## 🤝 Support

For questions or issues:
- Check the Apify documentation
- Review the logs for error messages
- Contact Apify support

---

**Built with ❤️ using Apify SDK v3 + Crawlee v3**