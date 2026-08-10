## What does SimplyHired Jobs Scraper do?

SimplyHired Jobs Scraper collects public job listings from SimplyHired by keyword, location, or one or more prepared SimplyHired search URLs. It saves structured job records with titles, companies, locations, salary text, descriptions, skills, benefits, work arrangements, posting dates, and direct job links.

Use the dataset for recruiting research, hiring market analysis, lead generation, compensation research, job board monitoring, and scheduled reports. Results can be downloaded in common formats or connected to spreadsheets, alerts, dashboards, and other business workflows through Apify.

## Why use SimplyHired Jobs Scraper?

- **Build hiring datasets** - Collect current SimplyHired listings without manually copying job cards into a spreadsheet.
- **Search by role and geography** - Compare demand for a job title, skill, company type, city, state, country, or remote work.
- **Capture useful job context** - Review descriptions, requirements, benefits, employment type, remote attributes, salary text, and company ratings when published.
- **Support recruiting and sales research** - Identify companies that are hiring now and organize their open roles for sourcing or outreach.
- **Monitor changes over time** - Schedule repeat runs with the same searches to track new listings, hiring volume, salary signals, and skill demand.
- **Use automation-ready output** - Export the dataset or connect it to Google Sheets, Airtable, webhooks, Make, Zapier, or your own application.

## What data can you extract from SimplyHired?

| Field | Type | Description |
|-------|------|-------------|
| `job_key` | String | SimplyHired job identifier when available. |
| `title` | String | Job title as published in the listing. |
| `company` | String | Hiring company name. |
| `location` | String | Location shown for the job. |
| `salary` | String | Salary or compensation text when published. |
| `snippet` | String | Short preview from the search result. |
| `summary` | String | Listing summary text. |
| `description_html` | String | Job description with basic formatting when available. |
| `description_text` | String | Plain-text job description. |
| `requirements` | Array | Requirement terms found in the listing. |
| `skills` | Array | Skills and related terms associated with the role. |
| `benefits` | Array | Benefits listed by the employer when available. |
| `job_type` | String | Employment type, such as full-time or part-time. |
| `remote_attributes` | Array | Remote, hybrid, or other workplace attributes. |
| `sponsored` | Boolean | Whether the listing is marked as sponsored. |
| `company_rating` | Number | Company rating when SimplyHired provides one. |
| `date_posted` | String | Posting date in ISO timestamp format when available. |
| `url` | String | Direct job listing URL. |
| `company_page_url` | String | Company page URL when available. |
| `source_search_url` | String | SimplyHired search URL that produced the listing. |
| `source` | String | Source label, returned as `SimplyHired`. |
| `scraped_at` | String | ISO timestamp for when the record was saved. |

Some fields are optional because employers do not publish the same information for every job. Missing salary, benefits, rating, or remote details normally means that the source listing did not provide them.

## How to scrape SimplyHired jobs

1. Open SimplyHired Jobs Scraper in Apify Console.
2. Enter a `keyword` and `location`, or add one or more public SimplyHired search URLs in `startUrls`.
3. Set `results_wanted` to the maximum number of jobs you need.
4. Adjust `max_pages` when you need broader pagination coverage.
5. Run the Actor, review the dataset preview, and download or connect the results.

When `startUrls` is supplied, the Actor uses those search pages instead of building a search from `keyword` and `location`. For a first run, the default keyword, location, result limit, and page limit are suitable for a small validation dataset.

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `startUrls` | Array | No | None | One or more public SimplyHired search URLs. These take precedence over keyword and location search. |
| `keyword` | String | No | `software engineer` | Job title, skill, or search phrase, such as `data analyst`, `registered nurse`, or `sales manager`. |
| `location` | String | No | `USA` | Search location, such as `Remote`, `New York, NY`, `Los Angeles`, or `United States`. |
| `results_wanted` | Integer | No | `20` | Maximum number of job listings to save. |
| `max_pages` | Integer | No | `2` | Minimum pagination page budget. The Actor can continue when additional pages are needed to reach `results_wanted`, subject to its safety limit. |
| `proxyConfiguration` | Object | No | `{ "useApifyProxy": false }` | Optional Apify Proxy settings for runs that need proxy routing. |

## Output Data

Each dataset item represents one SimplyHired job listing. The Actor removes duplicate listings during a run and adds source and collection-time metadata to saved records.

| Field | Type | Description |
|-------|------|-------------|
| `job_key` | String | Stable job key when available. |
| `title` | String | Job title. |
| `company` | String | Employer name. |
| `location` | String | Published job location. |
| `salary` | String | Published salary text, if available. |
| `snippet` | String | Search result preview. |
| `summary` | String | Summary text from the listing. |
| `description_html` | String | Formatted description when available. |
| `description_text` | String | Plain-text description for analysis and indexing. |
| `requirements` | Array | Requirement terms. |
| `skills` | Array | Skills and related terms. |
| `benefits` | Array | Employer-provided benefits. |
| `job_type` | String | Employment type. |
| `remote_attributes` | Array | Remote or hybrid attributes. |
| `sponsored` | Boolean | Sponsored-listing flag. |
| `company_rating` | Number | Company rating, if published. |
| `date_posted` | String | ISO posting timestamp when available. |
| `url` | String | Direct job URL. |
| `company_page_url` | String | Company page URL when available. |
| `source_search_url` | String | Search page used to find the job. |
| `source` | String | `SimplyHired`. |
| `scraped_at` | String | ISO collection timestamp. |

## Usage Examples

### Basic keyword search

Collect 20 software engineering jobs in the United States.

```json
{
  "keyword": "software engineer",
  "location": "USA",
  "results_wanted": 20,
  "max_pages": 2
}
```

### Multiple SimplyHired search URLs

Collect jobs from two prepared searches in one run.

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

### Larger remote hiring dataset

Collect a larger set of remote data analyst jobs and route requests through an Apify residential proxy group.

```json
{
  "keyword": "data analyst",
  "location": "Remote",
  "results_wanted": 100,
  "max_pages": 10,
  "proxyConfiguration": {
    "useApifyProxy": true,
    "groups": ["RESIDENTIAL"]
  }
}
```

## Sample Output

The following example shows one realistic dataset item. Optional fields can be empty when SimplyHired does not publish the corresponding value.

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

## Tips for Best Results

- **Start with a small run** - Use `results_wanted: 20` to confirm that a query returns the roles and locations you need.
- **Use specific keywords** - Terms such as `backend engineer`, `warehouse associate`, or `marketing manager` usually produce more focused results.
- **Add seniority or skills** - Include terms such as `senior`, `entry level`, `Python`, or `registered nurse` when you need a narrower dataset.
- **Choose locations carefully** - Use city and state names for local research, `Remote` for remote hiring, and country names for broad comparisons.
- **Increase page coverage when needed** - Raise `max_pages` for larger datasets. The run can stop early after it reaches `results_wanted`.
- **Expect source-dependent fields** - Salary, benefits, company ratings, and full descriptions may not be available for every employer.
- **Keep scheduled searches consistent** - Reusing the same keyword, location, and page settings makes trend comparisons easier.

## Integrations

- **Google Sheets** - Review, filter, and share job datasets with recruiting or research teams.
- **Airtable** - Build a searchable hiring tracker with company and role fields.
- **Webhooks** - Send completed-run notifications or dataset events to another service.
- **Make or Zapier** - Trigger alerts, enrichment, or CRM workflows from new runs.
- **API** - Access datasets programmatically from your own applications.

### Export Formats

| Format | Useful for |
|--------|------------|
| JSON | Applications, APIs, and data pipelines |
| CSV | Spreadsheet analysis and bulk review |
| Excel | Business reports and shared workbooks |
| XML | Systems that require XML imports |

## Frequently Asked Questions

### Can I scrape SimplyHired by keyword and location?

Yes. Set `keyword` and `location` to build a SimplyHired search automatically. Use a prepared search URL in `startUrls` when you need to reuse an existing search page.

### Can I use my own SimplyHired search URLs?

Yes. Add one or more request objects containing a `url` in `startUrls`. When this field is present, those URLs take precedence over the keyword and location inputs.

### How many jobs can I collect in one run?

Set `results_wanted` to the maximum number of listings you want. The final count also depends on how many matching public listings are available and how much pagination is needed.

### Why are salary, benefits, or ratings missing?

Those fields are missing when the employer or SimplyHired does not publish them for a listing. The Actor keeps the available source data and does not infer unavailable values.

### Does the Actor remove duplicate jobs?

Yes. Listings are checked using their job identifiers or URLs during a run so repeated search results are less likely to create duplicate dataset records.

### Can I run SimplyHired monitoring on a schedule?

Yes. Create an Apify schedule for hourly, daily, weekly, or custom recurring runs, then compare the resulting datasets or send them to a downstream workflow.

### Can I export SimplyHired data to CSV or Excel?

Yes. Apify datasets can be downloaded as JSON, CSV, Excel, XML, and other supported formats.

### Is it legal to scrape SimplyHired?

Public data collection may be subject to laws, privacy requirements, and SimplyHired terms. You are responsible for using this Actor lawfully, respecting access rules, and collecting only data you are allowed to use.

## Related Actors

- [APEC Jobs Scraper](https://apify.com/shahidirfan/apec-jobs-scraper) - Collect French executive and specialist job listings.
- [BuiltIn Jobs Scraper](https://apify.com/shahidirfan/builtin-jobs-scraper) - Collect technology and startup job listings.
- [Learn4Good Job Scraper](https://apify.com/shahidirfan/learn4good-job-scraper) - Collect worldwide, teaching, and career listings.
- [AiJobs.net Scraper](https://apify.com/shahidirfan/aijobs-net-scraper) - Collect AI, machine learning, and data job listings.

## Support

For issues, feature requests, or questions about the dataset, use the Issues tab on the Actor page or contact the developer through Apify.

## Legal Notice

This Actor is intended for legitimate recruitment research, market analysis, monitoring, and other responsible data workflows. Users are responsible for complying with SimplyHired terms, applicable laws, privacy requirements, and data-use obligations.
