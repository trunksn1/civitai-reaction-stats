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
- **Dark theme** matching Civitai's aesthetic
- **Smart data retention** - Automatic aggregation (hourly → 6-hour → daily) to prevent Gist size growth
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
| `CIVITAI_API_KEY` | Your Civitai API key (helps get accurate stats) | ⚠️ Optional |

**Note:** The `CIVITAI_API_KEY` is optional but recommended. Without it, the script uses unauthenticated requests which may have lower rate limits.

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
3. Click **Save**
4. The status should change to "Configured"

## Manual Stats Refresh

By default, the stats collector runs hourly with a smart tiered refresh system:
- **Daily**: Refreshes images from last 30 days
- **Monthly** (1st of month): Also refreshes images from 1-6 months ago
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

### 7. Using the Extension

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
  "username": "YourUsername",
  "lastUpdated": "2024-01-15T10:00:00Z",
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
- **`totalSnapshots`** - Aggregate stats across all images at each timestamp
- **`images[].snapshots`** - Individual image stats history for charting trends
- **Time-series data** - Every hourly run adds a new snapshot to track growth over time
- **Automatic aggregation** - Older snapshots are automatically downsampled to save space

## How the Stats Refresh System Works

The system uses a **smart tiered refresh strategy** to balance data freshness with API efficiency:

### Automatic Tiered Refresh Schedule

| Refresh Tier | When It Runs | What Gets Refreshed |
|--------------|--------------|---------------------|
| **Daily** | Every hour (default) | • Last 30 days of images<br>• Any images with 0 stats |
| **Monthly** | 1st of each month | • Last 6 months of images<br>• Any images with 0 stats |
| **Quarterly** | Jan 1, Apr 1, Jul 1, Oct 1 | • ALL images (complete refresh)<br>• Any images with 0 stats |

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

To prevent your Gist from growing infinitely large, snapshots are automatically aggregated:

| Time Period | Resolution | Example |
|-------------|------------|---------|
| **Last 7 days** | Hourly snapshots | Full data every hour |
| **7-30 days ago** | 6-hour intervals | Downsampled to 4 points per day |
| **Beyond 30 days** | Daily intervals | One data point per day |

**How it works:**
- Every hour, a new snapshot is added
- Older snapshots are automatically aggregated (keeps the last value in each time bucket)
- This prevents exponential growth while maintaining long-term trend visibility
- Applied to both `totalSnapshots` and individual `images[].snapshots`

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
- Click "Save" after entering the URL
- The status should change to "Configured ✓"

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

### Some images have 0 reactions but I know they have stats
- Images with 0 stats are always refreshed on every run
- The Civitai API sometimes returns incomplete data - this is handled by individual re-fetching
- Force a quarterly refresh to update all images
- Check if the image is published (scheduled/future-dated images are filtered out)

## Development

### Project Structure

```
civitai-reaction-stats/
├── .github/
│   └── workflows/
│       └── collect-stats.yml    # Hourly cron job
├── scripts/
│   ├── fetch-stats.js           # Main data fetcher
│   └── package.json             # Node dependencies
├── extension/
│   ├── manifest.json            # Extension manifest (MV3)
│   ├── service-worker.js        # Background service worker
│   ├── popup/                   # Settings popup
│   ├── content/                 # Menu injection
│   ├── stats-page/              # Charts and stats display
│   ├── lib/                     # Bundled libraries (Chart.js)
│   └── icons/                   # Extension icons
└── README.md
```

### Local Development

1. Make changes to the extension files
2. Go to `chrome://extensions/`
3. Click the refresh icon on the extension card
4. Reload Civitai to test changes

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

## Privacy

- This extension only reads data from your public Gist
- No data is sent to any third-party servers
- Your Civitai stats are fetched by GitHub Actions, not by the extension
- The extension does not require any Civitai credentials

## License

MIT License - see LICENSE file for details.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
