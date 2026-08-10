# Civitai Reaction Stats

Track and visualize reaction statistics for your Civitai images over time.

This project consists of two components:
1. **GitHub Actions workflow** - Automatically collects your image stats hourly and stores them in a GitHub Gist
2. **Chrome Extension** - Displays beautiful charts and statistics, with a "Stats" menu item injected into Civitai

## Features

- **Automated hourly data collection** via GitHub Actions
- **Smart tiered refresh system** - Efficient API usage with daily/monthly/quarterly tiers
- **Manual full refresh** - Force refresh all images anytime via GitHub Actions UI
- **Historical time-series data** for every image with automatic snapshot management
- **Interactive charts** showing reactions over time (1d, 7d, 30d, 90d, all time)
- **Summary cards** with total likes 👍, hearts ❤️, laughs 😂, cries 😢, and comments 💬
- **Per-image statistics** with sorting by date, reactions, or comments
- **Readable image names** from your post titles, with a rename box for the rest
- **Follower history** with honest daily net-change reporting (gains and unfollows)
- **Creator Insights** with activity calendar, publish-impact overlay, records,
  milestones, combined post rankings, back-catalog gains, and publish-age cohorts
- **Thumbnail-rich image timeline** in both the legend and hover details
- **Optional Civitai title write-back** through independent OAuth/PKCE, with no
  open Civitai tab, conflict detection, verification, and safe undo when the
  original post already had a title
- **Dark theme** matching Civitai's aesthetic
- **Smart data retention** - Automatic aggregation (hourly → 6-hour → daily) limits Gist growth while preserving long-term trends
- **Resilient API calls** - Exponential backoff retry logic with rate limit handling

## Architecture

```
GitHub Actions (hourly) ──► Civitai API ──► GitHub Gist (JSON)
                                                  │
                                                  ▼
Chrome Extension ◄── reads ◄── gist.githubusercontent.com
      │
      ├── Content Script (injects "Stats" menu item)
      ├── Service Worker (handles messages, cross-origin fetches)
      └── Stats Page (displays charts)
```

## Setup Instructions

### 1. Create a GitHub Gist

1. Go to [gist.github.com](https://gist.github.com)
2. Create a **new public Gist**
3. Add a file named `stats.json` with content: `{}`
4. Click "Create public gist"
5. Copy the Gist ID from the URL (the long alphanumeric string, e.g., `abc123def456789`)

### 2. Create a GitHub Personal Access Token

1. Go to [GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens](https://github.com/settings/tokens?type=beta)
2. Click "Generate new token"
3. Give it a name like "Civitai Stats"
4. Set expiration as desired (or no expiration)
5. Under "Repository access", select "Public Repositories (read-only)" or your specific repo
6. Under "Permissions", expand "Account permissions" and set **Gists** to "Read and write"
7. Click "Generate token"
8. **Copy the token immediately** - you won't see it again

### 3. Fork/Clone This Repository

1. Fork this repository or clone it to your GitHub account
2. Go to your repository's **Settings → Secrets and variables → Actions**
3. Add these **repository secrets**:

| Secret Name | Value | Required |
|-------------|-------|----------|
| `GIST_ID` | Your Gist ID from step 1 | ✅ Yes |
| `GIST_TOKEN` | Your Personal Access Token from step 2 | ✅ Yes |
| `CIVITAI_USERNAME` | Your Civitai username | ✅ Yes |
| `CIVITAI_API_KEY` | Your account-wide Civitai API key (required for live buzz/collect/view counters) | ⚠️ Recommended |
| `CIVITAI_RED_API_KEY` | Rarely needed — your one account-wide `CIVITAI_API_KEY` already works on civitai.red. Optional override only | ⚠️ Optional |

**Note:** Collection still works without `CIVITAI_API_KEY`: discovery and the
core reaction/comment counters fall back to REST. Authenticated tRPC is required
for live buzz, collect, and view counters; without a key those extended fields
are carried forward at their last known values. Broad tRPC failures abort before
the Gist write so an apparently successful run cannot silently freeze them.

**civitai.red (R-rated and harder content):** Civitai moved R+ content to a separate domain, `civitai.red`. The collector now queries **both** `civitai.com` and `civitai.red` so reactions on your R+ images keep being tracked. This is on by default; set the `CIVITAI_RED_ENABLED` repo variable to `false` to disable it.

**Image names:** Civitai images have no name of their own, so the extension builds one — see [How images get their names](#how-images-get-their-names). The collector resolves your post titles at up to `POST_TITLE_BUDGET` posts per run (default 300); the first backfill drains over a few runs.

Civitai issues a **single account-wide API key** (civitai.com → Account settings → **API Keys**) that works on **both** domains — there is no separate "civitai.red" key. In fact bulk discovery works even with no key at all, so just leave `CIVITAI_RED_API_KEY` **unset** unless you have a specific reason to use a different key for `.red`. See [civitai.red split](#civitairred-split-r-content) below for what happens to images tracked before the split.

### 4. Enable GitHub Actions

1. Go to your repository's **Actions** tab
2. If prompted, click "I understand my workflows, go ahead and enable them"
3. Click on "Collect Civitai Stats" workflow
4. Click "Run workflow" → "Run workflow" to test it manually
5. Wait for the workflow to complete and verify your Gist now has stats data

### 5. Install the Chrome Extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top-right corner)
3. Click **Load unpacked**
4. Select the `extension/` folder from this repository
5. The extension icon should appear in your Chrome toolbar

### 6. Configure the Extension

1. Click the Civitai Reaction Stats extension icon
2. Enter your Gist raw URL in this format:
   ```
   https://gist.githubusercontent.com/YOUR_USERNAME/YOUR_GIST_ID/raw/stats.json
   ```
3. Click **Save settings**
4. The stats-data status should change to "Stats Gist configured"

### 7. Optional: connect Civitai OAuth for public title changes

Reading the stats does not require OAuth. Connect it only if you want the rename
dialog to update public Civitai post titles without keeping a Civitai tab open.

1. Load the unpacked extension first, then open its popup.
2. Copy **Redirect URL to register exactly**. It has the form
   `https://EXTENSION_ID.chromiumapp.org/oauth2`.
3. In Civitai **Account Settings -> OAuth Applications**, create a
   **Browser / Mobile App** and register that redirect URL byte-for-byte.
4. Give the app only **Profile & Settings Read**, **Media & Posts Read**, and
   **Media & Posts Write**. The extension requests their integer scope mask `97`.
5. Paste the app's **public client ID** into the popup. Do not create, paste, or
   store a client secret for this public PKCE client.
6. Click **Connect Civitai**, authorize the three permissions, and confirm the
   popup reports the connected username.

The redirect URL is derived from the Chrome extension ID. Another Chrome
profile or another unpacked copy can receive a different ID and therefore need
its own registered redirect URL. The public client ID is synced by Chrome; OAuth
access and rotating refresh tokens stay in protected extension-local storage.

**Disconnect** deletes the local tokens. To revoke the grant on Civitai itself,
remove it from Civitai's OAuth Applications settings.

## Manual Stats Refresh

By default, the stats collector runs hourly with a smart tiered refresh system:
- **Daily**: Refreshes images from last 30 days
- **Monthly** (1st of month, 00:00 UTC run only): Also refreshes images from 1-6 months ago
- **Quarterly** (Jan/Apr/Jul/Oct 1st): Refreshes ALL images

### Force Full Refresh for All Images

To manually trigger a full refresh of ALL images (including old ones):

1. Go to your repository on GitHub
2. Click **Actions** tab
3. Select **Collect Civitai Stats** workflow
4. Click **Run workflow** button (top right)
5. Select **quarterly** from the "Refresh tier" dropdown
6. Click **Run workflow**

This will fetch fresh stats for every image, regardless of age.

**Options:**
- `auto` - Use date-based logic (default for scheduled runs)
- `daily` - Refresh only last 30 days
- `monthly` - Refresh up to 6 months
- `quarterly` - Refresh ALL images (use this to force full refresh)

### 8. Using the Extension

**Option 1: Via Extension Popup**
- Click the extension icon → Click "Open Stats"

**Option 2: Via Civitai Menu**
1. Go to [civitai.com](https://civitai.com) and log in
2. Click your avatar/profile button in the top-right
3. Look for the "Stats" menu item
4. Click it to open your stats page

## Data Structure

The stats are stored in your Gist as JSON with time-series data:

```json
{
  "formatVersion": 1,
  "username": "YourUsername",
  "lastUpdated": "2024-01-15T10:00:00Z",
  "creatorSnapshots": [
    { "timestamp": "2024-01-15T10:00:00Z", "followers": 1250 }
  ],
  "totalSnapshots": [
    {
      "timestamp": "2024-01-15T09:00:00Z",
      "likes": 1480,
      "hearts": 795,
      "laughs": 398,
      "cries": 199,
      "comments": 148,
      "imageCount": 50
    },
    {
      "timestamp": "2024-01-15T10:00:00Z",
      "likes": 1500,
      "hearts": 800,
      "laughs": 400,
      "cries": 200,
      "comments": 150,
      "imageCount": 50
    }
  ],
  "images": [
    {
      "id": "12345",
      "name": "My amazing artwork prompt text...",
      "url": "https://civitai.com/images/12345",
      "thumbnailUrl": "https://image.civitai.com/...",
      "createdAt": "2024-01-01T00:00:00Z",
      "snapshots": [
        {
          "timestamp": "2024-01-15T09:00:00Z",
          "likes": 98,
          "hearts": 49,
          "laughs": 29,
          "cries": 10,
          "comments": 24
        },
        {
          "timestamp": "2024-01-15T10:00:00Z",
          "likes": 100,
          "hearts": 50,
          "laughs": 30,
          "cries": 10,
          "comments": 25
        }
      ]
    }
  ]
}
```

**Key Points:**
- **`formatVersion: 1`** - Explicit schema version. Files written before this
  field existed are accepted as legacy version 1; unknown versions are rejected
  instead of being guessed.
- **`creatorSnapshots`** - Absolute follower totals. The dashboard derives net
  change between observations, so unfollows remain visible rather than being
  clamped away. A failed follower request adds no point and never invents zero.
- **`totalSnapshots`** - Aggregate stats across all images at each timestamp
- **`images[].snapshots`** - Individual image stats history for charting trends
- **Time-series data** - Every hourly run adds a new snapshot to track growth over time
- **Automatic aggregation** - Older observations are deliberately downsampled to save space

## How the Stats Refresh System Works

The system uses a **smart tiered refresh strategy** to balance data freshness with API efficiency:

### Automatic Tiered Refresh Schedule

| Refresh Tier | When It Runs | What Gets Refreshed |
|--------------|--------------|---------------------|
| **Daily** | Every hour (default) | • Last 30 days of images<br>• Any images with 0 stats |
| **Monthly** | 1st of each month (00:00 UTC run only) | • Last 6 months of images<br>• Older images stuck at 0 stats |
| **Quarterly** | Jan 1, Apr 1, Jul 1, Oct 1 (00:00 UTC run only) | • ALL images (complete refresh) |

**Note on 0-stat images:** images from the last 30 days are always refreshed hourly,
including those at 0. Images older than 30 days that are still at 0 refresh on the
monthly tier (they used to be re-fetched every hour forever).

### Incremental discovery

Hourly (daily-tier) runs use **incremental discovery**: since results are sorted
newest-first, pagination stops at the first page made entirely of already-known images —
new uploads are still found immediately, but the run no longer re-downloads the full
gallery listing (4 NSFW levels × 2 hosts) every hour. Images beyond the stop point are
carried from stored data, and their stat freshness comes from the tiered per-image
refresh as always. Monthly/quarterly runs (and the first run ever) still sweep every
page — those full sweeps are also the only runs that mark disappeared images as
`frozen`. To force a full sweep on demand, set the `FULL_DISCOVERY=true` env var (or
just dispatch the workflow with the `monthly` or `quarterly` tier).

### Why Tiered Refresh?

**Problem:** The Civitai bulk API returns **stale/cached stats** that can be hours or days old.

**Solution:**
- Re-fetch individual image stats using the accurate `/images?imageId=X` endpoint
- But only refresh images that need it, based on age
- Older images change less frequently, so they don't need hourly updates

**Result:** Fresh stats for recent images without overwhelming the API with unnecessary requests for old images.

### Manual Override

You can bypass the automatic schedule and force any tier manually:
- Go to Actions → Collect Civitai Stats → Run workflow
- Select your desired tier (daily/monthly/quarterly)
- Use **quarterly** to force a complete refresh of all images anytime

## Data Retention Policy

To prevent unbounded Gist growth, scheduled runs intentionally reduce the
resolution of older aggregate and per-image histories:

| Time Period | Resolution | Example |
|-------------|------------|---------|
| **Last 7 days** | Hourly snapshots | Full data every hour |
| **7-30 days ago** | 6-hour intervals | Downsampled to 4 points per day |
| **Beyond 30 days** | Daily intervals | One data point per day |

Within each older UTC-aligned bucket, the latest observation is retained. This
preserves the useful long-term curve while discarding redundant fine-grained
points. Before writing, the collector verifies exact added/retained-away count
accounting, checks that every observation required by this policy survives
unchanged, and rejects any unrelated history loss.

## civitai.red split (R+ content)

Civitai moved R-rated-and-harder content to a separate domain, `civitai.red`. The collector queries both domains and tags each image with its `host` (`com` or `red`).

**Your historical counts were never at risk.** Even before this change, images that dropped out of the API were *carried forward* at their last-known value (never zeroed) and stats are clamped so they can never decrease. So R+ images simply **froze** at their pre-split value rather than losing data.

**What changes now:**
- R+ images are rediscovered on `civitai.red` and resume receiving fresh stats.
- Images not returned by either domain in a run are flagged `stale: true` and shown with a **frozen** badge in the extension (likely migrated or removed).
- Image links point at the correct domain (`civitai.com` or `civitai.red`).

**⚠️ One-time catch-up bump:** the first successful `.red` run records each previously-frozen image at its *current* (higher) total. Because stats are stored as gains-over-time, all the reactions earned while the image was frozen appear as a **single spike** on that date. This is expected — those reactions are real, but Civitai's API never exposed *when* each one arrived, so they can't be spread across the gap.

## How images get their names

Civitai images have no name. The API field the extension used to lean on is the
generation prompt, and it comes back empty for every image on this account — which
is why every card used to read `Image 114507519`.

So the extension builds a name, taking the first of these that exists:

1. **A name you set on that one image** (pencil icon on the card).
2. **A name you set on the whole post** — each image shows it as `Name — pt. 1`,
   `Name — pt. 2`, …
3. **The post's title on Civitai**, numbered the same way when the post holds
   several images.
4. **Base model and date**, e.g. `SD 1.5 · Jan 15, 2024`.
5. `Image {id}`, if nothing else is available.

Hovering a name shows where it came from, plus the post it belongs to.

The rename dialog keeps two choices separate:

- **Local display scope:** change only this image, or all images in its post with
  derived `pt. N` labels. These local choices live in `chrome.storage.local` and
  are not synced between machines.
- **Public Civitai title:** an independent, unchecked checkbox writes the plain
  title (never the `pt. N` suffix) through the OAuth connection. No Civitai tab
  or login cookie is needed. The extension checks the current server title
  before writing, verifies it afterward, and stores one undo record locally when
  the previous title was non-empty. If the server title changed meanwhile, it
  asks before overwriting. A failed public write leaves the local rename intact
  and reports the failure.

Civitai's current update service ignores an empty title instead of clearing the
existing title. The extension therefore refuses public blank-title writes. It
can rename a previously untitled post, but it cannot automatically undo that
specific first title back to "untitled"; the dialog reports this instead of
offering an unusable Undo action.

**About `pt. 1` / `pt. 2`:** that numbering exists only in this extension. A Civitai
post has a single title shared by all the images in it, and images have no title of
their own, so there is no per-image name to store upstream even in principle.

**Most posts have no title** (~7% of this account's do), which is why rung 4 exists —
otherwise almost everything would still show a bare id.

## Troubleshooting

### GitHub Actions not running
- Check that Actions are enabled in your repository (Settings → Actions → General)
- Verify all required secrets are set correctly (`GIST_ID`, `GIST_TOKEN`, `CIVITAI_USERNAME`)
- Check the Actions tab for error logs
- Make sure the workflow file is in `.github/workflows/` directory
- Try manually triggering with "Run workflow" button

### GitHub Actions fails with "Missing required environment variables"
- Go to Settings → Secrets and variables → Actions
- Verify `GIST_ID`, `GIST_TOKEN`, and `CIVITAI_USERNAME` are all set
- Secret names are case-sensitive
- Re-create secrets if they were recently updated

### GitHub Actions fails with "HTTP 404" or "Gist not found"
- Verify your `GIST_ID` is correct (the alphanumeric string from the Gist URL)
- Make sure the Gist exists and is accessible
- Check that `GIST_TOKEN` has "Gists" read/write permission

### Rate limiting / Too many API calls
- The tiered refresh system minimizes API calls automatically
- Older images (7+ months) only refresh quarterly
- If you see rate limit errors, wait for the next hourly run
- Consider adding `CIVITAI_API_KEY` for higher rate limits

### Extension shows "Not configured"
- Make sure you've entered the Gist raw URL in the popup
- The URL format should be: `https://gist.githubusercontent.com/USERNAME/GIST_ID/raw/stats.json`
- Click "Save settings" after entering the URL
- The status should change to "Configured ✓"

### Civitai OAuth will not connect

- Copy the redirect URL from the currently loaded extension and register it
  exactly in a Civitai **Browser / Mobile App**.
- Confirm the app allows Profile Read, Media Read, and Media Write, then reconnect.
- Paste only the public client ID; this extension never uses a client secret.
- An unpacked extension loaded in another Chrome profile may have a different
  redirect URL.

### Stats not loading in extension
- Check that your Gist is **public** (private Gists won't work)
- Verify the Gist URL is correct by opening it in a browser
- Check the browser console for errors (F12 → Console tab)
- Make sure the Gist has actual data (not just `{}`)
- Try clicking the "Refresh" button

### "Stats" menu item not appearing on Civitai
- Make sure you're logged into Civitai (not just visiting as a guest)
- The menu item appears in the user dropdown (click your avatar/profile icon in top-right)
- Try refreshing the Civitai page (F5 or Ctrl+R)
- Check that the extension is enabled in `chrome://extensions/`
- Try disabling and re-enabling the extension

### Charts not showing data / Empty graphs
- Wait for at least 2-3 hourly GitHub Actions runs to complete (need multiple data points)
- Check your Gist to verify it contains `totalSnapshots` and `images` arrays with data
- Open browser DevTools (F12) → Console tab to check for JavaScript errors
- Verify timestamps in your Gist data are valid ISO 8601 format
- Try the "Refresh Data" button on the stats page

### Stats seem outdated or stale
- The bulk Civitai API returns cached stats - this is why we re-fetch individually
- Older images (7+ months old) only get refreshed quarterly
- To force immediate refresh of all images:
  1. Go to GitHub → Actions → Collect Civitai Stats
  2. Click "Run workflow" → select "quarterly" → Run
- Check the Actions log to see which refresh tier was used

### Fixing inflated stats (clamp reset)

Stats are clamped to never decrease (protection against stale API data). The downside:
if the API ever returns an inflated value once, the clamp bakes it in forever. To fix a
specific image:

1. Go to GitHub → Actions → Collect Civitai Stats → **Run workflow**
2. In **reset-image-ids**, enter the affected image ID(s), comma-separated (e.g. `12345678,87654321`)
3. Run the workflow

For that one run, the listed images accept the API's fresh values as-is (allowed to
decrease), and the total is recomputed without its own clamp. Afterwards the normal
clamping resumes. Locally: `RESET_IMAGE_IDS=12345678 node fetch-stats.js` with the usual env vars.

### Some images have 0 reactions but I know they have stats
- Images with 0 stats are refreshed hourly for their first 30 days, then monthly
- The Civitai API sometimes returns incomplete data - this is handled by individual re-fetching
- Force a quarterly refresh to update all images
- Check if the image is published (scheduled/future-dated images are filtered out)

## Development

### Project Structure

```
civitai-reaction-stats/
├── .github/
│   └── workflows/
│       ├── ci.yml               # Non-mutating tests on pushes and PRs
│       └── collect-stats.yml    # Hourly cron + safe manual dry runs
├── analysis/                    # Standalone posting-time study
├── scripts/
│   ├── fetch-stats.js           # Main data fetcher
│   ├── lib/                     # tRPC decoding and data validation
│   ├── test-*.js                # Collector/codec safety tests
│   └── package.json             # Node dependencies
├── extension/
│   ├── manifest.json            # Extension manifest (MV3)
│   ├── service-worker.js        # Background service worker
│   ├── popup/                   # Settings popup
│   ├── content/                 # Menu injection
│   ├── stats-page/              # Charts and stats display
│   ├── lib/                     # Chart.js, snapshot codec, safe rendering
│   └── icons/                   # Extension icons
└── README.md
```

### Local Development

1. Make changes to the extension files
2. Go to `chrome://extensions/`
3. Click the refresh icon on the extension card
4. Reload Civitai to test changes

Before committing collector or dashboard changes:

```bash
cd scripts
npm ci
npm test
```

### Testing the Fetch Script Locally

#### Basic Test (using automatic tier based on date)
```bash
cd scripts
npm install
GIST_ID=your_gist_id GIST_TOKEN=your_token CIVITAI_USERNAME=your_username node fetch-stats.js
```

#### Test with Manual Tier Override
```bash
# Test daily tier
GIST_ID=xxx GIST_TOKEN=xxx CIVITAI_USERNAME=xxx REFRESH_TIER=daily node fetch-stats.js

# Test monthly tier
GIST_ID=xxx GIST_TOKEN=xxx CIVITAI_USERNAME=xxx REFRESH_TIER=monthly node fetch-stats.js

# Test quarterly tier (refreshes ALL images)
GIST_ID=xxx GIST_TOKEN=xxx CIVITAI_USERNAME=xxx REFRESH_TIER=quarterly node fetch-stats.js
```

#### With Civitai API Key (Optional)
```bash
GIST_ID=xxx GIST_TOKEN=xxx CIVITAI_USERNAME=xxx CIVITAI_API_KEY=xxx REFRESH_TIER=quarterly node fetch-stats.js
```

**What to watch for in the logs:**
- "Using manual refresh tier override: quarterly" (if REFRESH_TIER is set)
- "Refreshing stats: X/Y images (tier: quarterly)"
- "Stats changed: X" and "Unchanged: Y"
- Check your Gist to verify data was written correctly

### Safe validation against the live dataset

Manual workflow runs default to **dry-run enabled**. A dry run reads the existing
Gist, performs discovery/refresh/merge/retention, validates that every removal
matches the documented policy and every required snapshot, image, and
post-title cache entry survives, then uploads before/after JSON as a
short-lived Actions artifact, and **does not update the Gist**. Disable dry-run
only when you deliberately want the manual run to write.

The Gist itself is a Git repository and retains revisions. See
[ROLLBACK.md](./ROLLBACK.md) for data-backup and recovery procedures.

The API authentication details and tRPC wire formats are documented in
[CIVITAI_OAUTH_INTEGRATION_GUIDE.md](./CIVITAI_OAUTH_INTEGRATION_GUIDE.md).

## Privacy

- The current Gist-based mode stores data in a **public GitHub Gist**. It can
  expose the configured username, image ids and URLs, timestamps, reaction
  history, base models, cached post titles, and prompt-derived names when Civitai
  supplies them.
- The extension reads that Gist and opens Civitai links; it does not send the
  dataset to an additional analytics service. An explicitly requested public
  title change sends the post id and new title directly to Civitai's tRPC API
  using the user's OAuth grant.
- Civitai credentials stay in GitHub Actions secrets and are not available to
  the extension. The optional OAuth connection is separate: its public client ID
  is stored in `chrome.storage.sync`, while access/refresh tokens and identity
  stay in `chrome.storage.local`, restricted to trusted extension contexts.
- Local custom names and the most recent title-undo record remain in
  `chrome.storage.local` on that browser. The extension never reads, copies, or
  stores the Civitai session cookie or a client secret. OAuth disconnect is local;
  server-side revocation remains available in Civitai OAuth Applications settings.

## License

MIT License — see [LICENSE](./LICENSE).

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
