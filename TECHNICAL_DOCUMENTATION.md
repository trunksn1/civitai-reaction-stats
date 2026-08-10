# Technical documentation: Civitai Reaction Stats

This document describes the current implementation. The source code remains
authoritative when an upstream Civitai behavior changes.

## System overview

The repository contains two related tools:

1. The main personal statistics system: GitHub Actions collects cumulative
   counters into a public GitHub Gist, and a Chrome MV3 extension visualizes the
   resulting history.
2. `analysis/`: a standalone platform-wide posting-time study. It is prior art
   for future visualizations but is not part of the personal collector runtime.

The main data path is:

```text
GitHub Actions
  -> read and validate existing Gist
  -> discover images on civitai.com and civitai.red
  -> refresh selected image counters
  -> merge without dropping historical images
  -> retain/downsample and delta-encode snapshots
  -> validate the complete candidate transition
  -> update stats.json (unless dry-run)

Chrome extension
  -> fetch raw stats.json through its service worker
  -> decode snapshots with the shared codec
  -> render Overview, Trends, and Images views
  -> optionally authorize with Civitai OAuth/PKCE and write verified post titles
```

## Repository map

```text
.github/workflows/
  ci.yml                     non-mutating push/PR validation
  collect-stats.yml          scheduled collector + manual dry-run
analysis/                    standalone posting-time analyzer/viewer
extension/
  content/                   Stats-menu injection on .com and .red
  lib/
    chart.min.js             vendored Chart.js
    civitai-oauth.js         tested PKCE/scope/token/tRPC/DNR helpers
    insights-analytics.js    pure daily/post/cohort/record calculations
    safe-values.js           tested HTML/URL rendering guards
    snapshot-codec.js        shared absolute/delta codec
  popup/                     Gist settings and Civitai OAuth connection
  stats-page/                dashboard
  manifest.json              MV3 manifest
  service-worker.js          settings, Gist fetch, tabs, verified title relay
scripts/
  fetch-stats.js             collector CLI
  lib/trpc.js                dual-format tRPC decoding and headers
  lib/stats-validation.js    dataset/transition validation
  test-*.js                  unit and safety tests
```

## Workflow behavior

`.github/workflows/collect-stats.yml` runs on an hourly schedule and supports
manual dispatch. A concurrency group prevents two runs from reading the same
old Gist state and racing to overwrite one another.

Manual dispatch includes:

- `refresh-tier`: `auto`, `daily`, `monthly`, or `quarterly`;
- `reset-image-ids`: a comma-separated one-run clamp bypass;
- `post-title-budget`: maximum post-title resolutions for that run;
- `dry-run`: defaults to `true` for manual runs.

A dry run executes the complete collection and validation path but skips
`octokit.gists.update`. It emits `stats-before.json` and
`stats-candidate.json`; the workflow uploads them as a 30-day Actions artifact.

Scheduled runs write only after all validation passes. Workflow permissions are
restricted to repository `contents: read`; Gist access comes from `GIST_TOKEN`.

## Configuration

Required secrets:

| Name | Purpose |
|---|---|
| `GIST_ID` | Gist containing `stats.json` |
| `GIST_TOKEN` | token with permission to update that Gist |
| `CIVITAI_USERNAME` | account whose images are discovered |

Recommended secrets:

| Name | Purpose |
|---|---|
| `CIVITAI_API_KEY` | authenticated tRPC for live extended counters and post titles |
| `CIVITAI_RED_API_KEY` | optional override; the normal account key works on both hosts |

Optional runtime variables include `REFRESH_TIER`, `RESET_IMAGE_IDS`,
`FULL_DISCOVERY`, `POST_TITLE_BUDGET`, `DRY_RUN`, `SAFETY_EXPORT_DIR`,
`REQUEST_TIMEOUT_MS`, and `MAX_REFRESH_FAILURE_RATIO`.

Without an API key, discovery and core reactions/comments still work through
REST. Buzz, collects, and views cannot be refreshed through REST and therefore
remain at their last-known values.

## Collection pipeline

### 1. Read first, fail closed

`readGistData()` runs before Civitai discovery. It:

- requires the `stats.json` file to exist;
- follows `raw_url` when GitHub truncates a large Gist file in its API response;
- treats an empty file or `{}` as an intentional first-run dataset;
- aborts on transport, parse, or schema errors;
- validates image ids, snapshots, timestamps, and finite non-negative counters.

It never converts an unreadable/misconfigured Gist into an empty candidate.

### 2. Select the refresh tier

Automatic tier selection uses UTC and escalates only at 00:00:

| Tier | Automatic time | Individual refresh scope |
|---|---|---|
| Daily | all ordinary hourly runs | images from the last 30 days |
| Monthly | first day of a non-quarter month at 00:00 UTC | last 6 months plus old zero-reaction images |
| Quarterly | Jan/Apr/Jul/Oct 1 at 00:00 UTC | all images |

Manual overrides are validated against those three values.

### 3. Discover images on both hosts

REST discovery calls `/api/v1/images` on `civitai.com` and, unless disabled,
`civitai.red`. Each host is queried separately for None, Soft, Mature, and X
content because a single API request does not reliably return all levels.

Daily runs are incremental: streams are sorted newest-first and stop when a
complete page consists of known image ids. Stored images not reached by that
short scan are synthesized from their last snapshot so they remain in totals.

Monthly/quarterly runs, first runs, and `FULL_DISCOVERY=true` use full sweeps.
Only full sweeps can classify an image as missing/frozen.

### 4. Refresh individual counters

For selected images, authenticated tRPC `image.get` is preferred. It supplies:

- likes, hearts, laughs, cries, and comments;
- buzz/tipped amount count;
- collects;
- views.

`scripts/lib/trpc.js` supplies matching browser-like `Origin`/`Referer` headers
and decodes both live Civitai response families:

- legacy `result.data.json`;
- string-encoded reference tables.

If tRPC fails, the collector attempts REST `?imageId=...` for the core counters
and tries the alternate host after a 404. It reports how many refreshes used
tRPC, REST fallback, or failed. With an API key configured, a broad fallback or
failure ratio above `MAX_REFRESH_FAILURE_RATIO` aborts the run so extended
counters cannot silently freeze behind a green workflow.

Requests use bounded timeouts, exponential backoff, numeric or HTTP-date
`Retry-After` handling, and immediate failure for non-retryable 4xx responses.

### 5. Merge histories

Every image id already present in the Gist must remain in the candidate. Images
missing from a full API sweep are carried forward at their last values and
marked `stale: true`; their histories are not deleted.

Counters normally use a never-decrease clamp to defend against stale or partial
upstream responses. `RESET_IMAGE_IDS` bypasses the clamp for selected images for
one run and allows a known inflated value to be corrected.

Per-image snapshots are appended only when at least one tracked field changes.
Aggregate total snapshots are appended each successful run, including an `_d`
zero-change marker when appropriate.

### 6. Resolve post titles

Image discovery stores `postId` and `baseModel`. `refreshPostTitles()` resolves
unknown posts newest-first within `POST_TITLE_BUDGET` and persists:

```json
"postTitles": {
  "123": { "title": "Example", "fetchedAt": "2026-08-10T00:00:00.000Z" },
  "456": { "title": null, "fetchedAt": "2026-08-10T00:00:00.000Z" }
}
```

`title: null` means a successful read of an untitled post. An absent key means
unresolved/failed and is retried later.

Authenticated tRPC `post.get` is attempted first. Availability is cached per
host only after definitive failures. HTML parsing of `/posts/{id}` is the
fallback; it locates the `__NEXT_DATA__` query whose `state.data.id` matches the
post id rather than trusting an array position.

### 7. Retention and encoding

Scheduled runs intentionally downsample both aggregate and per-image histories
according to this policy:

| Age | Resolution |
|---|---|
| 0-7 days | all collected points |
| 7-30 days | last point per six-hour bucket |
| over 30 days | last point per UTC-aligned daily bucket |

Within each UTC-aligned bucket, the latest observation is retained. The policy
lives in `scripts/lib/retention.js` so collection and transition validation use
the exact same implementation.

`extension/lib/snapshot-codec.js` is loaded by both the Node collector and the
extension. The first point is absolute. Later points use short delta keys such
as `dl`, `dh`, and `dco`; `_d: 1` marks a zero-change delta.

### 8. Candidate safety checks and write

Before any write, the collector verifies:

- exact per-image snapshot accounting after additions and policy-authorized retention removals;
- valid and unique image ids;
- valid timestamps and finite non-negative resolved counters;
- every pre-existing image id is still present;
- every image and aggregate snapshot required by the retention policy survives unchanged;
- no historical value that survives at the same timestamp is altered;
- the post-title cache did not shrink.

The before and candidate datasets can be exported with SHA-256 hashes. Normal
output is compact `JSON.stringify(data)` to reduce raw-Gist size. `DRY_RUN=true`
logs the candidate size but skips the update.

## Stored data shape

The logical top-level shape is:

```text
StatsData
  formatVersion: 1
  username: string
  lastUpdated: ISO timestamp | null
  totalSnapshots: Snapshot[]
  creatorSnapshots: { timestamp: ISO timestamp, followers: integer }[]
  images: ImageData[]
  postTitles: { [postId]: { title: string|null, fetchedAt: ISO timestamp } }

ImageData
  id, name, url, thumbnailUrl, createdAt
  host: "com" | "red"
  postId, baseModel
  lastSeenAt, stale
  snapshots: Snapshot[]
```

Tracked snapshot fields are likes, hearts, laughs, cries, comments, buzz,
collects, and views. Aggregate snapshots also carry `imageCount`.

Object-format files now carry `formatVersion: 1`; files written before the field
existed are interpreted as legacy version 1, and unknown versions are rejected.
The planned positional-array or split-store migration would therefore become
version 2 and remains separate work. Creator snapshots use absolute follower
totals and the same retention policy as the other histories. They intentionally
allow decreases, because those represent real net unfollows.

## Extension architecture

### Service worker and popup

The popup validates and stores a Gist URL and public Civitai OAuth client ID in
`chrome.storage.sync`. It displays `chrome.identity.getRedirectURL('oauth2')` so
the exact Chromium redirect can be registered in a Civitai Browser / Mobile app.

The service worker cache-busts and fetches the Gist, returns parsed JSON to the
stats page, and opens the dashboard tab. Optional title access uses OAuth
Authorization Code + PKCE S256 with scope `97` (identity read, media read, media
write). It exchanges the code without a client secret, fetches `/userinfo`, and
stores the access token, rotating refresh token, expiry, granted scope, and
identity together in `chrome.storage.local`. Local storage access is restricted
to trusted extension contexts; refreshes are serialized and every replacement
refresh token is persisted before waiting callers resume. A 4xx refresh failure
clears the local session; network/5xx errors do not destroy a potentially valid
grant. Disconnect is local, while grant revocation remains a Civitai account
setting.

Civitai's tRPC bearer-token middleware currently requires browser-like `Origin`
and `Referer` values matching the selected `.com` or `.red` host. JavaScript
cannot set these forbidden headers directly, so the service worker temporarily
installs a `declarativeNetRequest` session rule. The rule is limited to the exact
Civitai hostname, extension initiator, XHR resource type, and a private request
marker, then removed in `finally`. tRPC requests are serialized so one request
cannot remove another's temporary rule. No Civitai tab or session cookie is used.

The popup currently accepts raw Gist hosts only as configuration; normalization
of ordinary Gist page URLs is separate UX work.

### Content script

`extension/content/content.js` observes dynamic menu DOM on both Civitai hosts.
When a visible user menu appears, it inserts one idempotent Stats button. Debug
logging is disabled by default.

### Dashboard

The dashboard uses the shared codec and includes:

- summary cards and fixed-interval activity;
- reaction mix, top movers, distribution, personalities, and On this day;
- true time spacing on numeric epoch axes;
- stepped cumulative lines, stacked fixed-bucket delta bars, and stacked areas;
- per-image cards, sparklines, detailed charts, sorting, and a top-image timeline.
- follower total/net-change reporting plus Creator Insights: daily publish-impact
  overlay, switchable 12-month calendar, records/milestones, post aggregation,
  new-vs-back-catalog gains, and coverage-gated publish-age cohorts;
- thumbnail legend items and external thumbnail tooltips on the image timeline.

External Gist/post-title values are escaped with `safe-values.js`. Links and
thumbnail sources are limited to HTTPS Civitai/Civitai CDN hostnames before
being inserted into templates.

### Image naming

Display names resolve in this order:

1. local per-image override;
2. local per-post override, with extension-only `— pt. N` numbering;
3. cached Civitai post title, with the same numbering;
4. `baseModel · date`;
5. collector prompt/name or `Image {id}`.

Local overrides live in `chrome.storage.local`. The rename dialog independently
controls local image/post scope and optional public post-title write-back. The
public checkbox starts unchecked on every dialog. The OAuth write path performs
an authoritative pre-read, detects conflicts, submits only `{ id, title }`,
re-reads to verify, updates the in-memory title cache, and keeps one local undo
record when the old title was non-empty. It fails without changing the public
post when OAuth is disconnected or the upstream call cannot be verified.

Current upstream `updatePost` behavior treats a null/empty title as an omitted
update, so public title clearing is refused. A newly titled, previously untitled
post cannot offer an honest automatic undo until Civitai supports clearing the
field through this endpoint.

## Testing

From `scripts/`:

```bash
npm ci
npm test
npm run validate:stats -- /path/to/stats.json
```

Tests cover the snapshot codec, legacy/reference-table tRPC decoding, safe HTML
and URL handling, insight calculations, versioned creator-history transition
guards, UTC tier selection, retention, and post-title extraction.
`.github/workflows/ci.yml` runs these tests, syntax
checks, and a synthetic posting-time analysis without secrets or Gist writes.

The collector workflow also runs the tests before collection. A manual dry run
against the live dataset is the final pre-deployment validation step.

## Data recovery

The Gist is itself a Git repository with revision history. Before deployment,
clone its full history outside this repository and verify it with `git fsck`.
See [ROLLBACK.md](./ROLLBACK.md) for code reverts and dataset recovery. Never
replace `stats.json` with `{}` when recovering; that would discard the snapshot
history even if current totals could be reconstructed.

## API and privacy constraints

- Civitai REST and tRPC are external, partially undocumented dependencies.
- OAuth is implemented for extension title read/write over tRPC; REST v1 still
  rejects OAuth. The scheduled collector remains API-key/Gist based. See
  [CIVITAI_OAUTH_INTEGRATION_GUIDE.md](./CIVITAI_OAUTH_INTEGRATION_GUIDE.md).
- The current storage mode is a public Gist. It exposes the account identifier,
  image metadata, post titles, and historical counters described in README.
- Gist mode remains the authoritative 24/7 path. A future local IndexedDB mode
  is planned but not implemented.
