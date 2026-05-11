# API Discovery

## Selected API
- Endpoint (bootstrap): `https://www.simplyhired.com/search?q=<keyword>&l=<location>`
- Endpoint (list API): `https://www.simplyhired.com/_next/data/<buildId>/search.json?q=<keyword>&l=<location>&cursor=<cursor>`
- Endpoint (detail API): `https://www.simplyhired.com/_next/data/<buildId>/job/<jobKey>.json`
- Method: `GET`
- Auth: None required
- Pagination: cursor-based (`pageCursors`)
- Runtime source: `__NEXT_DATA__` payload from bootstrap page

## Why This API Was Selected
- Returns structured JSON for list + detail pages.
- Supports cursor pagination and stable result iteration.
- Produces richer fields than HTML-only parsing (job key, salary metadata, remote flags, rating, benefits, typed arrays).
- Works with direct HTTP requests (`got-scraping`) without mandatory browser automation.

## Extracted Fields
- `job_key`
- `title`
- `company`
- `location`
- `salary`
- `snippet`
- `summary`
- `description_html`
- `description_text`
- `requirements`
- `skills`
- `benefits`
- `job_type`
- `remote_attributes`
- `sponsored`
- `company_rating`
- `date_posted`
- `url`
- `company_page_url`
- `source_search_url`
- `source`
- `scraped_at`

## Auto-Healing and Resilience Notes
- Actor dynamically reads `buildId` from live `__NEXT_DATA__` on every run (no hardcoded build id).
- Cursor pagination uses adaptive cursor selection and duplicate-cursor protection.
- Response parsing now supports multiple `pageProps` shapes (`pageProps`, `props.pageProps`, `data.pageProps`).
- Job array extraction supports fallback keys (`jobs`, `jobResults`, `results`, nested search result arrays).
- JSON endpoints auto-retry when HTML is returned unexpectedly (common when blocked/challenged).
- Safe stop condition halts after repeated no-progress pages to avoid user-aborted long runs.
- Detail enrichment tolerates schema drift with alternate description field paths.

## Rejected / Weaker Patterns
- Raw HTML-only scraping: weaker field coverage and more brittle on UI/layout changes.
- Hardcoded tokens/headers: not needed for current endpoints and not resilient.
- Browser-first flow: unnecessary overhead for the current API path.
