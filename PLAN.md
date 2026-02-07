# Civitai Reaction Stats - Chrome Extension Plan

## Overview

A Chrome extension that adds a "Stats" page to the Civitai user menu, displaying reaction statistics for the logged-in user's published images.

---

## API Research Results

### Available from Civitai API

| Feature | Available | Endpoint/Details |
|---------|-----------|------------------|
| User's images | Yes | `GET /api/v1/images?username={username}` |
| Reaction counts per image | Yes | `stats` object: `likeCount`, `heartCount`, `laughCount`, `cryCount`, `dislikeCount`, `commentCount` |
| Sort images | Yes | `sort` param: `Most Reactions`, `Most Comments`, `Most Collected`, `Newest`, `Oldest` |
| User join date | **No** | Not exposed in API |
| Historical reaction data | **No** | Only current totals available |

### Critical Limitation

**The Civitai API does NOT provide historical/time-series data for reactions.** This means we cannot show how reactions have changed over time using the API alone.

---

## Proposed Solution

Since historical data is not available from the API, we build our own tracking system using **GitHub Actions**:

1. **GitHub Actions** runs every hour (24/7, even when PC is off)
2. Fetches current reaction counts from Civitai API
3. Stores timestamped snapshots in a **GitHub Gist**
4. Chrome extension reads from Gist and displays graphs

**Pros:**
- Runs 24/7 regardless of Chrome/PC state
- Free (GitHub Actions + Gist)
- No database or server needed
- Data persists in the cloud

**Cons:**
- Requires GitHub account and initial setup
- No historical data before workflow starts

---

## Recommended Architecture: GitHub Actions + Extension

### How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                     GITHUB (runs 24/7)                         │
│  ┌──────────────────┐         ┌──────────────────────────────┐ │
│  │  GitHub Actions  │────────▶│  GitHub Gist (JSON storage)  │ │
│  │  (hourly cron)   │  saves  │  - timestamps                │ │
│  │                  │         │  - reaction counts           │ │
│  │  Fetches from    │         │  - per-image stats           │ │
│  │  Civitai API     │         │                              │ │
│  └──────────────────┘         └──────────────┬───────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                                               │
                                               │ reads (public URL)
                                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                   CHROME EXTENSION                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │Content Script│───▶│  Stats Page  │◀───│ Fetch from Gist  │  │
│  │(menu inject) │    │  (charts)    │    │                  │  │
│  └──────────────┘    └──────────────┘    └──────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Repository Structure

```
civitai-reaction-stats/
├── .github/
│   └── workflows/
│       └── collect-stats.yml    # Hourly cron job
├── scripts/
│   └── fetch-stats.js           # Node.js script to fetch & update Gist
├── extension/
│   ├── manifest.json            # Extension manifest (Manifest V3)
│   ├── content/
│   │   ├── content.js           # Injects Stats menu item
│   │   └── content.css          # Styles for injected elements
│   ├── stats-page/
│   │   ├── stats.html           # Full stats page
│   │   ├── stats.js             # Stats page logic
│   │   └── stats.css            # Stats page styles
│   ├── lib/
│   │   └── charts.js            # Chart rendering (Chart.js)
│   └── icons/
│       └── ...                  # Extension icons
└── README.md
```

### Component Details

#### 1. GitHub Actions Workflow
- **Schedule:** Runs every hour via cron (`0 * * * *`)
- **Task:** Execute `scripts/fetch-stats.js`
- **Secrets needed:** `GIST_TOKEN` (GitHub PAT with gist scope)

#### 2. Fetch Script (`scripts/fetch-stats.js`)
- Calls Civitai API: `GET /api/v1/images?username={username}`
- Reads existing data from Gist
- Appends new timestamped snapshot
- Updates Gist via GitHub API

#### 3. GitHub Gist (Data Storage)
- Public Gist containing `stats.json`
- Extension reads from raw Gist URL
- Structure: array of timestamped snapshots
- **Free, no database needed**

#### 4. Chrome Extension
- **Content Script:** Injects "Stats" menu item on civitai.com
- **Stats Page:** Fetches JSON from Gist, renders charts
- **No background service worker needed** (data comes from Gist)

---

## Features Specification

### 1. Menu Integration

- Inject "Stats" item in the user avatar dropdown menu
- Match Civitai's existing menu styling
- Only show when user is logged in

### 2. Overview Graph (Top Section)

| Element | Description |
|---------|-------------|
| X-Axis | Time (days since extension install or custom range) |
| Y-Axis | Reaction count (integer) |
| Lines | One line per reaction type + total line |
| Scale Control | Dropdown to set time scale (7d, 30d, 90d, All) |
| Custom Lines | User can create combined metrics (e.g., "All except Cry") |

**Reaction Types:**
- 👍 Like (Thumb-up)
- ❤️ Heart
- 😂 Laugh (Smile)
- 😢 Cry

### 3. Per-Image Stats (Bottom Section)

| Element | Description |
|---------|-------------|
| Sort Options | Newest, Oldest, Most Reactions, Most Comments, Most Collected |
| Display Limit | Show top 10 images (configurable) |
| Layout | Vertical list, image thumbnail on left, graph on right |
| Per-Image Graph | Same line types as overview (total + per-type) |

---

## Technical Considerations

### Authentication

- Extension needs to detect logged-in user
- Can extract username from page DOM or cookies
- API calls use public endpoints (no auth needed for own images if username known)

### Gist Data Structure

```javascript
// stats.json in GitHub Gist
{
  "username": "JeneScript",
  "lastUpdated": "2024-01-15T10:00:00Z",
  "snapshots": [
    {
      "timestamp": "2024-01-15T10:00:00Z",
      "totals": {
        "likeCount": 1500,
        "heartCount": 800,
        "laughCount": 400,
        "cryCount": 200,
        "commentCount": 350
      },
      "images": [
        {
          "id": "12345",
          "url": "https://civitai.com/images/12345",
          "thumbnailUrl": "https://...",
          "stats": {
            "likeCount": 100,
            "heartCount": 50,
            "laughCount": 30,
            "cryCount": 10,
            "commentCount": 25
          }
        }
        // ... more images
      ]
    }
    // ... more hourly snapshots
  ]
}
```

### GitHub Actions Setup

**Required Secrets:**
- `GIST_ID` - The ID of the Gist to update
- `GIST_TOKEN` - GitHub Personal Access Token with `gist` scope
- `CIVITAI_USERNAME` - Your Civitai username

**Workflow Schedule:**
```yaml
on:
  schedule:
    - cron: '0 * * * *'  # Every hour
  workflow_dispatch:      # Manual trigger option
```

### Rate Limiting

- Civitai API may have rate limits
- GitHub Actions: implement retry with backoff
- Gist API: 5000 requests/hour (more than enough)

### Chart Library

Recommend **Chart.js** for:
- Line graphs with multiple datasets
- Responsive design
- Easy customization
- Small bundle size

---

## Implementation Phases

### Phase 1: GitHub Actions Data Collector
- [ ] Create GitHub Gist for data storage
- [ ] Write `scripts/fetch-stats.js` (Node.js)
- [ ] Create `.github/workflows/collect-stats.yml`
- [ ] Test hourly collection
- [ ] Add error handling and notifications

### Phase 2: Extension Foundation
- [ ] Set up extension structure (Manifest V3)
- [ ] Create manifest.json with correct permissions
- [ ] Test loading unpacked extension

### Phase 3: Menu Injection
- [ ] Content script to detect Civitai pages
- [ ] Identify user dropdown menu DOM structure
- [ ] Inject "Stats" menu item
- [ ] Handle click events to open stats page

### Phase 4: Stats Page - Overview
- [ ] Create stats page HTML/CSS
- [ ] Fetch data from Gist
- [ ] Implement overview graph with Chart.js
- [ ] Add time scale controls (7d, 30d, 90d, All)
- [ ] Add custom line builder (combine reaction types)

### Phase 5: Stats Page - Per-Image
- [ ] Implement image list with sorting options
- [ ] Per-image reaction graphs
- [ ] Display top 10 with pagination

### Phase 6: Polish
- [ ] Match Civitai visual design (dark theme)
- [ ] Loading states and error handling
- [ ] "Last updated" timestamp display
- [ ] Manual refresh button

---

## Open Questions

1. **Gist size limits:** GitHub Gist files have a ~100MB limit. May need to prune old data after X months.
2. **Multiple users:** Current design tracks one user. Could extend to support multiple usernames.
3. **Data retention:** How long to keep hourly snapshots? Suggest: aggregate to daily after 30 days.

---

## Dependencies

### GitHub Actions / Scripts
- **Node.js 18+** - Runtime for fetch script
- **octokit** - GitHub API client for Gist updates
- **node-fetch** - HTTP client (or native fetch in Node 18+)

### Chrome Extension
- **Chart.js** - Graphing library
- **Chrome Extension APIs** - Tabs, scripting
- **Civitai REST API** - Read-only, via Gist data

---

## Setup Requirements

1. **Create a GitHub Gist**
   - Create new Gist at https://gist.github.com
   - Add empty `stats.json` file with `{}`
   - Note the Gist ID from the URL

2. **Create GitHub Personal Access Token**
   - Go to Settings → Developer Settings → Personal Access Tokens
   - Create token with `gist` scope
   - Save as repository secret `GIST_TOKEN`

3. **Configure Repository Secrets**
   - `GIST_ID` - Your Gist ID
   - `GIST_TOKEN` - Your PAT
   - `CIVITAI_USERNAME` - Your Civitai username

---

## Notes

- Data collection starts when GitHub Actions workflow is first enabled
- Historical data before workflow setup is not available (API limitation)
- Data is collected 24/7 regardless of whether Chrome/PC is running
- Gist is public but only contains aggregate stats, no sensitive data
- Consider adding data export functionality (CSV/JSON download)
