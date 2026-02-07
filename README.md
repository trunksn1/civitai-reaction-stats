# Civitai Reaction Stats

Track and visualize reaction statistics for your Civitai images over time.

This project consists of two components:
1. **GitHub Actions workflow** - Automatically collects your image stats hourly and stores them in a GitHub Gist
2. **Chrome Extension** - Displays beautiful charts and statistics, with a "Stats" menu item injected into Civitai

## Features

- **Hourly data collection** via GitHub Actions
- **Historical charts** showing reactions over time (7d, 30d, 90d, all time)
- **Summary cards** with total likes, hearts, laughs, cries, and comments
- **Per-image statistics** with sorting by date, reactions, or comments
- **Dark theme** matching Civitai's aesthetic
- **Data retention** - Automatic aggregation to prevent Gist size growth

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

| Secret Name | Value |
|-------------|-------|
| `GIST_ID` | Your Gist ID from step 1 |
| `GIST_TOKEN` | Your Personal Access Token from step 2 |
| `CIVITAI_USERNAME` | Your Civitai username |

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

### 7. Using the Extension

**Option 1: Via Extension Popup**
- Click the extension icon → Click "Open Stats"

**Option 2: Via Civitai Menu**
1. Go to [civitai.com](https://civitai.com) and log in
2. Click your avatar/profile button in the top-right
3. Look for the "Stats" menu item
4. Click it to open your stats page

## Data Structure

The stats are stored in your Gist as JSON:

```json
{
  "username": "YourUsername",
  "lastUpdated": "2024-01-15T10:00:00Z",
  "totalSnapshots": [
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
      "name": "My Image",
      "url": "https://civitai.com/images/12345",
      "thumbnailUrl": "https://...",
      "createdAt": "2024-01-01T00:00:00Z",
      "currentStats": {
        "likes": 100,
        "hearts": 50,
        "laughs": 30,
        "cries": 10,
        "comments": 25
      }
    }
  ]
}
```

## Data Retention Policy

To prevent your Gist from growing too large:

| Time Period | Resolution |
|-------------|------------|
| Last 7 days | Hourly snapshots |
| 7-30 days | 6-hour intervals |
| Beyond 30 days | Daily intervals |

This is handled automatically by the GitHub Actions workflow.

## Troubleshooting

### GitHub Actions not running
- Check that Actions are enabled in your repository
- Verify all three secrets (`GIST_ID`, `GIST_TOKEN`, `CIVITAI_USERNAME`) are set correctly
- Check the Actions tab for error logs

### Extension shows "Not configured"
- Make sure you've entered the Gist raw URL in the popup
- The URL should start with `https://gist.githubusercontent.com/`

### Stats not loading
- Check that your Gist is public
- Verify the Gist URL is correct
- Check the browser console for errors (F12 → Console)

### "Stats" menu item not appearing
- Make sure you're logged into Civitai
- The menu item only appears in the user dropdown menu
- Try refreshing the page

### Charts not showing data
- Wait for at least one GitHub Actions run to complete
- Check your Gist to see if it has data
- Try the "Refresh" button on the stats page

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

```bash
cd scripts
npm install
GIST_ID=your_gist_id GIST_TOKEN=your_token CIVITAI_USERNAME=your_username node fetch-stats.js
```

## Privacy

- This extension only reads data from your public Gist
- No data is sent to any third-party servers
- Your Civitai stats are fetched by GitHub Actions, not by the extension
- The extension does not require any Civitai credentials

## License

MIT License - see LICENSE file for details.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
