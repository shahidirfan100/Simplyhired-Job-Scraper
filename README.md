# SimplyHired Jobs Scraper

Extract job listings from SimplyHired quickly and reliably for research, monitoring, and hiring intelligence. Collect structured job data including company details, salary information, and full long-form job descriptions. Designed for repeatable, automated collection at scale.

## Features

- **Comprehensive job extraction** — Collect titles, companies, locations, salary, and metadata.
- **Long-form descriptions** — Capture full plain-text and HTML descriptions for deeper analysis.
- **Automatic pagination** — Continue collection across search pages until your target is reached.
- **Flexible inputs** — Run by keyword/location or provide direct search URLs.
- **Duplicate-resistant output** — Save unique jobs using stable identifiers.
- **Automation-ready datasets** — Use output in recurring workflows and reporting pipelines.

## Use Cases

### Hiring Market Analysis
Track demand across locations and roles over time. Build datasets to monitor where hiring is rising and which positions are most active.

### Lead Generation
Find companies actively hiring in your target segment. Use hiring activity as a strong outreach and prioritization signal.

### Job Intelligence Dashboards
Create dashboards, alerts, and trend reports powered by fresh job data. Keep internal teams updated with scheduled collections.

### Skills and Compensation Research
Analyze requirements, salary text, and job types to identify in-demand skills and market expectations.

---

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `startUrls` | Array | No | — | One or more SimplyHired search URLs. If provided, these are used directly. |
| `keyword` | String | No | `software engineer` | Search keyword (for example, `data engineer`). |
| `location` | String | No | `USA` | Location filter (for example, `Remote`, `New York, NY`). |
| `results_wanted` | Integer | No | `20` | Maximum number of jobs to collect. |
| `max_pages` | Integer | No | `250` | Hard cap for pagination pages to visit. |
| `proxyConfiguration` | Object | No | Residential proxy preset | Proxy settings for reliable collection. |

---

## Output Data

Each dataset item can contain:

| Field | Type | Description |
|-------|------|-------------|
| `job_key` | String | Unique job identifier. |
| `title` | String | Job title. |
| `company` | String | Hiring company name. |
| `location` | String | Job location. |
| `salary` | String | Salary text when available. |
| `job_type` | String | Employment type details when available. |
| `description_text` | String | Full long-form job description in plain text. |
| `description_html` | String | Full long-form job description in HTML format. |
| `snippet` | String | Short preview text from search results. |
| `summary` | String | Short listing summary. |
| `requirements` | Array | Requirement keywords from listing metadata. |
| `skills` | Array | Skill and metadata terms normalized for analysis. |
| `benefits` | Array | Benefit keywords when available. |
| `remote_attributes` | Array | Remote or hybrid attributes when available. |
| `sponsored` | Boolean | Whether the listing is sponsored. |
| `company_rating` | Number | Company rating when provided. |
| `date_posted` | String | Posting date timestamp. |
| `url` | String | Direct job URL. |
| `company_page_url` | String | Company page URL when available. |
| `source_search_url` | String | Search URL used to discover the listing. |
| `source` | String | Data source label. |
| `scraped_at` | String | Extraction timestamp. |

---

## Usage Examples

### Basic Search

Collect 50 software engineering jobs in the US:

```json
{
  "keyword": "software engineer",
  "location": "USA",
  "results_wanted": 50,
  "max_pages": 30
}
```

### Direct Search URL

Run from a specific SimplyHired search page:

```json
{
  "startUrls": [
    { "url": "https://www.simplyhired.com/search?q=data+engineer&l=Remote" }
  ],
  "results_wanted": 100,
  "max_pages": 60
}
```

### Larger Collection

Collect a larger dataset for analysis:

```json
{
  "keyword": "product manager",
  "location": "United States",
  "results_wanted": 500,
  "max_pages": 250,
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
  "job_key": "abcd1234example",
  "title": "Senior Software Engineer",
  "company": "Example Technologies",
  "location": "Remote",
  "salary": "$140,000 - $180,000 a year",
  "job_type": "Full-time",
  "description_text": "Full long-form job description text...",
  "description_html": "<p>Full long-form job description HTML...</p>",
  "snippet": "Short listing preview...",
  "requirements": ["Python", "AWS", "API design"],
  "benefits": ["Health insurance", "401(k)"],
  "sponsored": false,
  "company_rating": 4.2,
  "date_posted": "2026-02-13T10:40:34.160Z",
  "url": "https://www.simplyhired.com/job/example",
  "source": "SimplyHired",
  "scraped_at": "2026-02-13T10:40:34.160Z"
}
```

---

## Tips for Best Results

### Start With Small Runs
- Begin with `results_wanted: 20` to validate the query.
- Increase limits after confirming output quality.

### Use Clear Search Terms
- Specific keywords produce cleaner datasets.
- Add location constraints to reduce noise when needed.

### Tune Pagination Deliberately
- Keep `max_pages` high enough for larger targets.
- Lower `max_pages` for faster exploratory runs.

### Use Reliable Proxy Settings
- Residential proxies improve consistency for repeated runs.
- Keep proxy settings enabled for scheduled workloads.

---

## Integrations

Connect your data with:

- **Google Sheets** — Share job insights with teams.
- **Airtable** — Build searchable job and company datasets.
- **Make** — Trigger no-code automations from new runs.
- **Zapier** — Route results into business tools.
- **Webhooks** — Send run results to your own endpoints.

### Export Formats

- **JSON** — API and application workflows.
- **CSV** — Spreadsheet and BI analysis.
- **Excel** — Business reporting and sharing.
- **XML** — System interoperability where needed.

---

## Frequently Asked Questions

### How many jobs can I collect?
Set `results_wanted` based on your needs. The actor collects until it reaches your target or your pagination limit.

### Does output include long-form descriptions?
Yes. Each item includes `description_text` and `description_html` when available.

### Can I use multiple start URLs in one run?
Yes. Add multiple entries in `startUrls` and they will be processed in sequence.

### Why are some fields empty?
Some listings do not publish every attribute, such as salary or benefits. Empty values reflect source availability.

### Does it reduce duplicates?
Yes. The actor is designed to reduce duplicates using stable job identifiers.

### Is it suitable for scheduled monitoring?
Yes. It works well with recurring runs and automated dataset processing.

---

## Support

For issues or feature requests, use the Apify Console support channels.

### Resources

- [Apify Documentation](https://docs.apify.com/)
- [Apify API Reference](https://docs.apify.com/api/v2)
- [Apify Scheduling](https://docs.apify.com/platform/schedules)

---

## Legal Notice

This actor is intended for legitimate data collection and analysis. You are responsible for complying with website terms, local laws, and data-use obligations.
