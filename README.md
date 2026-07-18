# SimplyHired Jobs Scraper

Extract job listings from SimplyHired for recruiting research, market tracking, lead generation, and hiring analysis. This SimplyHired Jobs Scraper collects structured job data such as titles, companies, locations, salary text, descriptions, skills, benefits, ratings, job URLs, and posting metadata in a fast, automated workflow.

Use it to gather job market data by keyword and location, or start from one or more SimplyHired search URLs. The actor is built for repeatable collection, scheduled monitoring, and clean exports that can be used in spreadsheets, dashboards, CRMs, and data pipelines.

## Features

- **Keyword and location search** - Collect jobs by role, skill, company type, city, state, country, or remote location.
- **Direct search URL support** - Provide SimplyHired search URLs when you already know the exact pages you want to collect.
- **Rich job records** - Gather job titles, company names, locations, salary text, descriptions, requirements, benefits, and links.
- **Automatic pagination** - Continue through search result pages until the requested result count or page limit is reached.
- **Duplicate reduction** - Avoid repeated listings using stable job identifiers and URLs.
- **Analysis-ready output** - Export structured datasets for business reporting, hiring intelligence, and research.

---

## Use Cases

### Recruiting Market Research

Track hiring demand for specific roles across different locations. Recruiters and analysts can compare job volume, skills, salary signals, and remote work trends across markets.

### Lead Generation

Find companies that are actively hiring in your target industry. Hiring activity can help sales, staffing, and partnership teams prioritize accounts with current business needs.

### Compensation and Skills Analysis

Collect job descriptions, salary text, requirements, and skill terms for workforce planning. Use the dataset to identify common qualifications, benefit patterns, and role expectations.

### Job Board Monitoring

Run scheduled searches for important keywords and locations. Build alerts, trend reports, or dashboards that show new job activity over time.

### Competitive Hiring Intelligence

Monitor how competitors describe roles, where they are hiring, and which skills they request. This helps teams understand talent demand and positioning in the labor market.

---

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `startUrls` | Array | No | None | One or more SimplyHired search URLs. If provided, these are used instead of keyword and location search. |
| `keyword` | String | No | `software engineer` | Job search keyword, such as `data analyst`, `registered nurse`, or `sales manager`. |
| `location` | String | No | `USA` | Search location, such as `Remote`, `New York, NY`, `Los Angeles`, or `United States`. |
| `results_wanted` | Integer | No | `20` | Maximum number of job listings to save. |
| `max_pages` | Integer | No | `2` | Minimum pagination page budget. The actor may continue past this to reach `results_wanted`, up to an internal safety cap. |
| `proxyConfiguration` | Object | No | `useApifyProxy: true` | Proxy settings for reliable Apify Cloud runs. |

---

## Output Data

Each dataset item can include:

| Field | Type | Description |
|-------|------|-------------|
| `job_key` | String | Unique job identifier when available. |
| `title` | String | Job title. |
| `company` | String | Hiring company name. |
| `location` | String | Job location shown in the listing. |
| `salary` | String | Salary text when published. |
| `snippet` | String | Short listing preview. |
| `summary` | String | Listing summary text. |
| `description_html` | String | Job description with formatting when available. |
| `description_text` | String | Plain text job description. |
| `requirements` | Array | Requirement terms from the listing. |
| `skills` | Array | Skills and related terms found in listing metadata. |
| `benefits` | Array | Benefits listed by the employer when available. |
| `job_type` | String | Employment type, such as full-time or part-time. |
| `remote_attributes` | Array | Remote, hybrid, or related work attributes. |
| `sponsored` | Boolean | Whether the listing is marked as sponsored. |
| `company_rating` | Number | Company rating when provided. |
| `date_posted` | String | Posting date in timestamp format when available. |
| `url` | String | Direct job listing URL. |
| `company_page_url` | String | Company page URL when available. |
| `source_search_url` | String | Search URL where the listing was found. |
| `source` | String | Source label. |
| `scraped_at` | String | Collection timestamp. |

---

## Usage Examples

### Basic Job Search

Collect 20 software engineering jobs in the United States:

```json
{
  "keyword": "software engineer",
  "location": "USA",
  "results_wanted": 20,
  "max_pages": 2
}
```

### Remote Role Search

Collect remote data analyst jobs:

```json
{
  "keyword": "data analyst",
  "location": "Remote",
  "results_wanted": 50,
  "max_pages": 5
}
```

### Direct Search URLs

Start from specific SimplyHired search pages:

```json
{
  "startUrls": [
    {
      "url": "https://www.simplyhired.com/search?q=product+manager&l=New+York%2C+NY"
    },
    {
      "url": "https://www.simplyhired.com/search?q=product+manager&l=Remote"
    }
  ],
  "results_wanted": 100,
  "max_pages": 10
}
```

### Proxy-Assisted Run

Use proxy settings for repeated or larger collection jobs:

```json
{
  "keyword": "registered nurse",
  "location": "Texas",
  "results_wanted": 100,
  "max_pages": 10,
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

---

## Sample Output

```json
{
  "job_key": "example123",
  "title": "Senior Software Engineer",
  "company": "Example Technologies",
  "location": "Remote",
  "salary": "$140,000 - $180,000 a year",
  "snippet": "Build and maintain services used by customers worldwide.",
  "summary": "Build and maintain services used by customers worldwide.",
  "description_text": "Example Technologies is hiring a senior software engineer to design, build, and improve production systems.",
  "requirements": ["JavaScript", "Cloud platforms", "API design"],
  "skills": ["JavaScript", "Cloud platforms", "API design"],
  "benefits": ["Health insurance", "401(k)", "Paid time off"],
  "job_type": "Full-time",
  "remote_attributes": ["Remote"],
  "sponsored": false,
  "company_rating": 4.2,
  "date_posted": "2026-07-18T10:40:34.160Z",
  "url": "https://www.simplyhired.com/job/example123",
  "company_page_url": "https://www.simplyhired.com/company/example-technologies",
  "source_search_url": "https://www.simplyhired.com/search?q=software+engineer&l=USA",
  "source": "SimplyHired",
  "scraped_at": "2026-07-18T10:45:12.220Z"
}
```

---

## Tips for Best Results

### Start With QA-Sized Runs

- Use `results_wanted: 20` when testing a new query.
- Increase `results_wanted` after confirming the search returns relevant listings.
- Keep `max_pages` reasonable; the actor can extend the page budget when more pages are needed to reach `results_wanted`.

### Use Specific Search Terms

- Prefer clear role names such as `backend engineer`, `warehouse associate`, or `marketing manager`.
- Add seniority, tools, or certifications when you need a narrower dataset.
- Use broad keywords only when you want market-wide coverage.

### Choose Useful Locations

- Use city and state names for local hiring research.
- Use `Remote` for remote job tracking.
- Use country-level searches for broad market analysis.

### Review Missing Fields Correctly

- Some employers do not publish salary, benefits, ratings, or full remote details.
- Empty fields usually mean the listing did not provide that information.
- Compare several runs before drawing conclusions from a small sample.

---

## Integrations

Connect your data with:

- **Google Sheets** - Review and share job datasets with teams.
- **Airtable** - Build searchable recruiting and company databases.
- **Slack** - Send notifications when scheduled runs finish.
- **Webhooks** - Deliver new job data to internal systems.
- **Make** - Create no-code workflows from completed runs.
- **Zapier** - Trigger follow-up actions in sales and recruiting tools.

### Export Formats

- **JSON** - Use in applications, APIs, and data pipelines.
- **CSV** - Open in spreadsheets and business intelligence tools.
- **Excel** - Share structured reports with non-technical teams.
- **XML** - Send data to systems that require XML imports.

---

## Frequently Asked Questions

### Can I scrape SimplyHired by keyword and location?

Yes, you can scrape SimplyHired by entering a `keyword` and `location`. The actor builds the search from those values and collects matching job listings.

### Can I use my own SimplyHired search URLs?

Yes, you can provide one or more URLs in `startUrls`. This is useful when you have already created a filtered search on SimplyHired.

### How many jobs can I collect in one run?

You can set `results_wanted` to the number of jobs you need. The final count also depends on available listings, pagination limits, and source availability.

### Why are salary or benefits sometimes missing?

Salary and benefits can be missing because employers do not always publish those details. The actor leaves unavailable fields empty instead of inventing values.

### Does this actor remove duplicate jobs?

Yes, the actor reduces duplicate records by tracking job identifiers and URLs during a run. This helps keep the dataset cleaner for analysis.

### Is this scraper suitable for scheduled monitoring?

Yes, this scraper works well for scheduled monitoring. You can run the same search daily or weekly and export the results for trend tracking.

### What proxy settings should I use?

For small tests, the default proxy setting is often enough. For repeated or larger runs, Apify Proxy with residential groups can improve reliability.

---

## Support

For issues, questions, or feature requests, use the support options available in the Apify Console.

### Resources

- [Apify Documentation](https://docs.apify.com/)
- [Apify API Reference](https://docs.apify.com/api/v2)
- [Scheduling Runs](https://docs.apify.com/platform/schedules)

---

## Legal Notice

This actor is designed for legitimate data collection, research, and analysis. You are responsible for following SimplyHired terms, applicable laws, privacy rules, and data-use obligations. Collect only the data you are allowed to use, and apply reasonable limits to automated runs.
