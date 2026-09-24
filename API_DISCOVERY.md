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
- A cloud run with Apify Proxy returned HTTP 403 on all four bootstrap attempts while reusing one sticky session. Bootstrap and list requests now rotate to a fresh proxy session after a 403; the successful session is reused for later requests, while network and 5xx retries keep the current session. Each cached Impit client has its own cookie jar, and concurrent detail requests do not mutate the shared session.
- The search-page bootstrap is the first request; there is no separate direct homepage warm-up that can establish cookies on a different route.
- Impit supplies the selected Chrome profile's fingerprint headers instead of combining a generated profile with manually pinned version headers.
- Supplied `startUrls` are authoritative and are not expanded with schema-default keyword or location searches.
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
